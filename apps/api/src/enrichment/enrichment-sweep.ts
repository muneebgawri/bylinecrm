import { Injectable, Logger } from '@nestjs/common';
import { ENRICHMENT_DEFAULTS, type EnrichmentObject } from '@bylinecrm/shared';
import { PrismaService } from '../infra/prisma.service';
import { ENRICHMENT_SWEEP_BATCH } from './enrichment.constants';
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
 */
@Injectable()
export class EnrichmentSweep {
    private readonly logger = new Logger(EnrichmentSweep.name);

    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly queue: EnrichmentQueue,
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
        let queued = 0;
        for (const row of stale) {
            if (await this.queue.enqueue({ ...row, force: false })) queued += 1;
        }
        if (queued > 0) this.logger.log(`sweep: ${queued} records queued to be asked again`);
        return queued;
    }
}
