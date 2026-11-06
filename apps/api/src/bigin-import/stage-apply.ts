import { Injectable, Logger } from '@nestjs/common';
import {
    BIGIN_TIMELINE_SOURCE,
    type BiginStageApplyView,
    type Capability,
    type EventActor,
    type StageKind,
} from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { StageMoveService } from '../pipelines/stage-move.service';
import { fieldsEditedAfter } from '../timeline/timeline.service';
import { BIGIN_STAGE_APPLY_PAGE, BIGIN_WRITE_CHUNK } from './bigin-import.constants';
import { HISTORY_KEY_PREFIX } from './history';
import { biginStageIndex, chooseStage, snapshotStage, type PipelineStageRef } from './stage-map';

/** Moves deals only: no capability beyond what an import writes without one. */
const JOB_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>();
/** The import moves them, so a later import or apply never mistakes the move for a person's. */
const ACTOR: EventActor = { kind: 'import', id: null };

/**
 * Applies the Bigin stage mapping to deals already imported: each Deals link whose snapshot holds Bigin's
 * stage is resolved as the runner would (`chooseStage`), and a deal not in that stage is moved there through
 * the one stage writer, as the import (`reason: 'import'`, backward allowed, closes included). A deal moved by
 * someone other than the import after Bigin last changed it is left where it is — the runner's local-edit
 * rule. Links are read a page at a time by Bigin id and written `BIGIN_WRITE_CHUNK` per transaction, so 100k
 * deals never make one long transaction; the progress is on the settings row. Running it again is harmless.
 *
 * Then the imported stage history (`stage-history:` entries, BIGIN-1) is re-pointed the same way: each entry's
 * Bigin `from` and `to` are resolved again (`chooseStage`, as the runner wrote them) and an entry whose
 * `diff.stageId` now differs gets the new stage ids — nothing else in it changes. Entries are read a page at a
 * time along the timeline's `(workspace, source, key)` index and re-pointed `BIGIN_WRITE_CHUNK` per transaction
 * through `repoint_imported_stage_history`, the one way the app role may change a timeline entry's stages.
 */
@Injectable()
export class BiginStageApplier {
    private readonly logger = new Logger(BiginStageApplier.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly moves: StageMoveService,
    ) {}

    async apply(workspaceId: string): Promise<void> {
        await this.context.run(
            { workspaceId, capabilities: JOB_CAPABILITIES, actor: { kind: 'import', id: null } },
            () => this.execute(workspaceId),
        );
    }

    private async execute(workspaceId: string): Promise<void> {
        const started = await this.rls.withWorkspace(async (tx) => {
            const settings = await tx.biginImportSettings.findFirst({ select: { stageApply: true } });
            if (!settings) return null;
            const previous = settings.stageApply as BiginStageApplyView | null;
            const progress: BiginStageApplyView = {
                status: 'running',
                requestedAt: previous?.requestedAt ?? new Date().toISOString(),
                finishedAt: null,
                moved: 0,
                skipped: 0,
                historyRepointed: 0,
                error: null,
            };
            await save(tx, workspaceId, progress);
            const pipeline = await tx.pipeline.findFirst({ where: { isDefault: true }, select: { id: true } });
            if (!pipeline) return { progress, pipeline: null, stages: [], mapping: new Map<string, string>() };
            const stages = await tx.pipelineStage.findMany({
                where: { pipelineId: pipeline.id },
                orderBy: { position: 'asc' },
                select: { id: true, name: true, kind: true },
            });
            return {
                progress,
                pipeline: pipeline.id,
                stages: stages.map((s): PipelineStageRef => ({ id: s.id, name: s.name, kind: s.kind as StageKind })),
                mapping: biginStageIndex(await tx.biginStageMapping.findMany()),
            };
        });
        if (!started) return;
        const { progress, pipeline, stages, mapping } = started;
        try {
            if (!pipeline) throw new Error('this workspace has no default pipeline');
            let after: string | null = null;
            for (;;) {
                const links = await this.rls.withWorkspace((tx) =>
                    tx.biginImportLink.findMany({
                        where: {
                            object: 'Deals',
                            localType: 'opportunity',
                            ...(after ? { externalId: { gt: after } } : {}),
                        },
                        orderBy: { externalId: 'asc' },
                        take: BIGIN_STAGE_APPLY_PAGE,
                        select: { externalId: true, localId: true, snapshot: true, externalUpdatedAt: true },
                    }),
                );
                if (links.length === 0) break;
                after = links.at(-1)!.externalId;
                for (let i = 0; i < links.length; i += BIGIN_WRITE_CHUNK) {
                    const chunk = links.slice(i, i + BIGIN_WRITE_CHUNK);
                    const done = await this.rls.withWorkspace((tx) =>
                        this.applyChunk(tx, workspaceId, pipeline, stages, mapping, chunk),
                    );
                    progress.moved += done.moved;
                    progress.skipped += done.skipped;
                }
                await this.rls.withWorkspace((tx) => save(tx, workspaceId, progress));
            }
            await this.repointHistory(workspaceId, stages, mapping, progress);
            progress.status = 'succeeded';
        } catch (error) {
            progress.status = 'failed';
            progress.error = error instanceof Error ? error.message : String(error);
            this.logger.error(`bigin stage apply for ${workspaceId} failed: ${progress.error}`);
        }
        progress.finishedAt = new Date().toISOString();
        await this.rls.withWorkspace((tx) => save(tx, workspaceId, progress));
    }

    /** The second pass: imported stage moves re-pointed to where their Bigin stages now resolve. */
    private async repointHistory(
        workspaceId: string,
        stages: readonly PipelineStageRef[],
        mapping: ReadonlyMap<string, string>,
        progress: BiginStageApplyView,
    ): Promise<void> {
        let after = HISTORY_KEY_PREFIX.StageHistory;
        for (;;) {
            const entries = await this.rls.withWorkspace((tx) =>
                tx.$queryRaw<HistoryEntry[]>(stageHistoryPage(workspaceId, after, BIGIN_STAGE_APPLY_PAGE)),
            );
            if (entries.length === 0) break;
            after = entries.at(-1)!.key;
            const changed = entries.flatMap((entry) => {
                const target = repointed(stages, mapping, entry.properties);
                return target ? [{ id: entry.id, ...target }] : [];
            });
            for (let i = 0; i < changed.length; i += BIGIN_WRITE_CHUNK) {
                const chunk = changed.slice(i, i + BIGIN_WRITE_CHUNK);
                // Via text[]: a chunk whose `from`s are all null is sent untyped, which Postgres reads as int[].
                const [row] = await this.rls.withWorkspace(
                    (tx) => tx.$queryRaw<{ n: number }[]>`
                        SELECT repoint_imported_stage_history(
                            ${chunk.map((c) => c.id)}::text[]::uuid[],
                            ${chunk.map((c) => c.from)}::text[]::uuid[],
                            ${chunk.map((c) => c.to)}::text[]::uuid[]
                        ) AS n`,
                );
                progress.historyRepointed += row?.n ?? 0;
            }
            await this.rls.withWorkspace((tx) => save(tx, workspaceId, progress));
        }
    }

    private async applyChunk(
        tx: WorkspaceClient,
        workspaceId: string,
        pipelineId: string,
        stages: readonly PipelineStageRef[],
        mapping: ReadonlyMap<string, string>,
        links: readonly { localId: string; snapshot: unknown; externalUpdatedAt: Date | null }[],
    ): Promise<{ moved: number; skipped: number }> {
        let moved = 0;
        let skipped = 0;
        const known = links.filter((l) => snapshotStage(l.snapshot) !== undefined);
        if (known.length === 0) return { moved, skipped };
        const deals = await tx.opportunity.findMany({
            where: { id: { in: known.map((l) => l.localId) }, deletedAt: null, pipelineId },
            select: { id: true, workspaceId: true, pipelineId: true, stageId: true },
        });
        const byId = new Map(deals.map((d) => [d.id, d]));
        for (const link of known) {
            const deal = byId.get(link.localId);
            if (!deal) continue;
            const choice = chooseStage(stages, mapping, snapshotStage(link.snapshot) ?? null);
            if (deal.stageId === choice.id) continue;
            // The runner's precedence rule: a stage someone else set after Bigin last changed the deal stays.
            const edited = await fieldsEditedAfter(
                tx,
                { type: 'opportunity', id: deal.id },
                link.externalUpdatedAt ?? new Date(0),
            );
            if (edited.has('stageId')) {
                skipped += 1;
                continue;
            }
            const outcome = await this.moves.move(tx, deal, choice.id, ACTOR, {
                reason: 'import',
                allowBackward: true,
                close: choice.kind !== 'open' ? { lostReason: undefined } : undefined,
            });
            if (outcome.outcome === 'moved') {
                await this.moves.announce(tx, workspaceId, deal.id, ACTOR, outcome);
                moved += 1;
            }
        }
        return { moved, skipped };
    }
}

interface HistoryEntry {
    id: string;
    key: string;
    properties: unknown;
}

/**
 * A page of the workspace's imported stage moves after key `after`, in key order: a range on the unique index
 * `(workspace_id, source, idempotency_key)` — equality on the workspace and the source, a range on the key, all
 * conditions an index may serve under row-level security. The prefix and kind are checked on the rows read. The
 * range is bounded below only (the first page starts at the bare prefix, below every key it begins): the database's
 * collation is not C in production, where punctuation sorts differently, so a prefix range such as
 * `< 'stage-history;'` would find nothing. Past the last entry the scan meets only the source's keys after it.
 */
export function stageHistoryPage(workspaceId: string, after: string, take: number): Prisma.Sql {
    return Prisma.sql`
        SELECT "id", "idempotency_key" AS key, "properties"
        FROM "timeline_activities"
        WHERE "workspace_id" = ${workspaceId}::uuid
          AND "source" = ${BIGIN_TIMELINE_SOURCE}
          AND "idempotency_key" > ${after}
          AND "idempotency_key" LIKE ${`${HISTORY_KEY_PREFIX.StageHistory}%`}
          AND "kind" = 'deal.stage_changed'
        ORDER BY "idempotency_key"
        LIMIT ${take}`;
}

/**
 * Where an imported stage move points now, from the Bigin stages it keeps (`bigin.from`, `bigin.to`), resolved as
 * the runner resolves them; null when it already points there or does not keep Bigin's stages.
 */
export function repointed(
    stages: readonly PipelineStageRef[],
    mapping: ReadonlyMap<string, string>,
    properties: unknown,
): { from: string | null; to: string } | null {
    if (typeof properties !== 'object' || properties === null) return null;
    const { bigin, diff } = properties as { bigin?: unknown; diff?: unknown };
    if (typeof bigin !== 'object' || bigin === null) return null;
    const raw = bigin as { from?: unknown; to?: unknown };
    if (typeof raw.to !== 'string') return null;
    const current = (diff as { stageId?: { from?: unknown; to?: unknown } } | null | undefined)?.stageId;
    if (typeof current !== 'object' || current === null) return null;
    const to = chooseStage(stages, mapping, raw.to).id;
    const from = typeof raw.from === 'string' ? chooseStage(stages, mapping, raw.from).id : null;
    if (current.to === to && (current.from ?? null) === from) return null;
    return { from, to };
}

async function save(tx: WorkspaceClient, workspaceId: string, progress: BiginStageApplyView): Promise<void> {
    // Raw so the connection's `updated_at` (shown as when it was configured) is not moved by progress.
    await tx.$executeRaw`UPDATE "bigin_import_settings" SET "stage_apply" = ${JSON.stringify(progress)}::jsonb WHERE "workspace_id" = ${workspaceId}::uuid`;
}
