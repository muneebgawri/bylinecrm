import { Injectable, Logger } from '@nestjs/common';
import type { BiginStageApplyView, Capability, EventActor, StageKind } from '@bylinecrm/shared';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { StageMoveService } from '../pipelines/stage-move.service';
import { fieldsEditedAfter } from '../timeline/timeline.service';
import { BIGIN_STAGE_APPLY_PAGE, BIGIN_WRITE_CHUNK } from './bigin-import.constants';
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
            progress.status = 'succeeded';
        } catch (error) {
            progress.status = 'failed';
            progress.error = error instanceof Error ? error.message : String(error);
            this.logger.error(`bigin stage apply for ${workspaceId} failed: ${progress.error}`);
        }
        progress.finishedAt = new Date().toISOString();
        await this.rls.withWorkspace((tx) => save(tx, workspaceId, progress));
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

async function save(tx: WorkspaceClient, workspaceId: string, progress: BiginStageApplyView): Promise<void> {
    // Raw so the connection's `updated_at` (shown as when it was configured) is not moved by progress.
    await tx.$executeRaw`UPDATE "bigin_import_settings" SET "stage_apply" = ${JSON.stringify(progress)}::jsonb WHERE "workspace_id" = ${workspaceId}::uuid`;
}
