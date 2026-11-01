import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENRICHMENT_DEFAULTS, type EnrichmentObject } from '@bylinecrm/shared';
import { PrismaService } from '../infra/prisma.service';
import { mapPool } from '../infra/map-pool';
import { ENRICHMENT_SWEEP_BATCH, ENRICHMENT_SWEEP_CHECKS } from './enrichment.constants';
import { ENRICHERS, type Enricher } from './enricher.port';
import { EnrichmentQueue } from './enrichment-queue';

interface Stale {
    workspaceId: string;
    object: EnrichmentObject;
    recordId: string;
}

/**
 * Re-asks after the workspace's age (P4-2): every pass queues the records whose newest answer is
 * older than their workspace's re-ask age — the longest unasked first, `ENRICHMENT_SWEEP_BATCH` at
 * a time — for people and companies that still exist. The runner asks only the sources that are due,
 * so a record queued here costs nothing it does not owe. Runs as the owner: it spans every
 * workspace and is not a request. Running it twice queues nothing twice (one job per record).
 *
 * Then, in what is left of the batch, the people a source has never been asked about — a source just
 * added or turned on, or a person enrichment has not reached — newest first. Only sources that are on
 * and linked in the workspace count, and only people with an address (what every person source asks
 * with), so a person queued here always has a source due and is not queued again.
 */
@Injectable()
export class EnrichmentSweep {
    private readonly logger = new Logger(EnrichmentSweep.name);

    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly queue: EnrichmentQueue,
        @Inject(ENRICHERS) private readonly enrichers: Enricher[],
    ) {}

    async run(now = new Date()): Promise<number> {
        const stale = await this.ownerPrisma.$queryRaw<Stale[]>`
            SELECT a.workspace_id AS "workspaceId", a.object::text AS "object", a.record_id AS "recordId"
            FROM enrichment_answers a
            LEFT JOIN enrichment_settings s ON s.workspace_id = a.workspace_id
            WHERE (a.object = 'person' AND EXISTS (SELECT 1 FROM people p WHERE p.id = a.record_id AND p.deleted_at IS NULL))
               OR (a.object = 'company' AND EXISTS (SELECT 1 FROM companies c WHERE c.id = a.record_id AND c.deleted_at IS NULL))
            GROUP BY a.workspace_id, a.object, a.record_id, s.reask_after_days
            HAVING max(a.asked_at) < ${now}::timestamptz - make_interval(days => coalesce(s.reask_after_days, ${ENRICHMENT_DEFAULTS.reaskAfterDays}::int))
            ORDER BY max(a.asked_at) ASC
            LIMIT ${ENRICHMENT_SWEEP_BATCH}`;
        const unasked = await this.unaskedPeople(ENRICHMENT_SWEEP_BATCH - stale.length);
        let queued = 0;
        for (const row of [...stale, ...unasked]) {
            if (await this.queue.enqueue({ ...row, force: false })) queued += 1;
        }
        if (queued > 0) this.logger.log(`sweep: ${queued} records queued to be asked again`);
        return queued;
    }

    /** Up to `limit` people with an address that a source on and linked in their workspace never asked about. */
    private async unaskedPeople(limit: number): Promise<Stale[]> {
        const personSources = this.enrichers.filter((e) => e.facts('person').length > 0);
        if (limit <= 0 || personSources.length === 0) return [];
        // Workspaces with such a person for a source that is on there; only these are asked whether
        // their sources are linked, a few at once.
        const workspaces = await this.ownerPrisma.$queryRaw<{ workspaceId: string; disabled: string[] }[]>`
            SELECT p.workspace_id AS "workspaceId", coalesce(s.disabled_sources, '{}') AS "disabled"
            FROM people p
            LEFT JOIN enrichment_settings s ON s.workspace_id = p.workspace_id
            WHERE p.deleted_at IS NULL
              AND nullif(p.emails->>'primary', '') IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM unnest(${personSources.map((e) => e.source)}::text[]) AS src(source)
                  WHERE NOT (src.source = ANY(coalesce(s.disabled_sources, '{}')))
                    AND NOT EXISTS (
                        SELECT 1 FROM enrichment_answers a
                        WHERE a.workspace_id = p.workspace_id AND a.object = 'person'
                          AND a.record_id = p.id AND a.source = src.source
                    )
              )
            GROUP BY p.workspace_id, s.disabled_sources`;
        // Each workspace's sources that count — on there and linked — as (workspace, source) pairs.
        const linked = await mapPool(workspaces, ENRICHMENT_SWEEP_CHECKS, async ({ workspaceId, disabled }) => {
            const on = personSources.filter((e) => !disabled.includes(e.source));
            const ok = await Promise.all(
                on.map((e) => (e.available ? e.available(workspaceId) : Promise.resolve(true))),
            );
            return on.filter((_, i) => ok[i]).map((e) => ({ workspaceId, source: e.source }));
        });
        const pairs = linked.flat();
        if (pairs.length === 0) return [];
        return this.ownerPrisma.$queryRaw<Stale[]>`
            SELECT p.workspace_id AS "workspaceId", 'person' AS "object", p.id AS "recordId"
            FROM people p
            WHERE p.deleted_at IS NULL
              AND nullif(p.emails->>'primary', '') IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM unnest(${pairs.map((d) => d.workspaceId)}::uuid[], ${pairs.map((d) => d.source)}::text[])
                      AS due(workspace_id, source)
                  WHERE due.workspace_id = p.workspace_id
                    AND NOT EXISTS (
                        SELECT 1 FROM enrichment_answers a
                        WHERE a.workspace_id = p.workspace_id AND a.object = 'person'
                          AND a.record_id = p.id AND a.source = due.source
                    )
              )
            ORDER BY p.created_at DESC
            LIMIT ${limit}`;
    }
}
