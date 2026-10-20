import { Inject, Injectable } from '@nestjs/common';
import type { BiginStageApplyView, BiginStageMapRow, BiginStageMapView, StageKind } from '@bylinecrm/shared';
import { ApiException, UnknownReference } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { afterCommit } from '../infra/transaction-scope';
import { WorkspaceContext } from '../infra/workspace-context';
import { readBiginConnection } from './bigin-import.settings';
import { BiginImportWorkers } from './bigin-import.workers';
import { BiginApiError } from './bigin.http';
import { BIGIN_PORT, type BiginApi } from './bigin.port';
import { biginStageIndex, biginStageKey, chooseStage, type PipelineStageRef } from './stage-map';

export interface BiginStageMappingInput {
    biginStage: string;
    stageId: string | null;
}

/**
 * The Bigin stage mapping's API: Bigin's stage list (its Deals `Stage` picklist, read now; else the stages
 * imported deals carry), how many imported deals hold each, where each lands now and why, the workspace's
 * explicit choices, and applying them to deals already imported (a queued job: there are 100k+ of them).
 */
@Injectable()
export class BiginStageMapService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        @Inject(BIGIN_PORT) private readonly bigin: BiginApi,
        private readonly workers: BiginImportWorkers,
    ) {}

    async view(): Promise<BiginStageMapView> {
        this.current();
        const read = await this.rls.withWorkspace(async (tx) => {
            const stored = await readBiginConnection(tx, this.secrets);
            if (!stored) throw noConnection();
            const pipeline = await defaultPipeline(tx);
            const [mappings, counts] = await Promise.all([tx.biginStageMapping.findMany(), stageCounts(tx)]);
            return { connection: stored.connection, apply: stored.row.stageApply, pipeline, mappings, counts };
        });
        // Bigin is read outside any transaction; a picklist it will not give falls back to the imported stages.
        let picklist: string[] | null = null;
        let error: string | null = null;
        try {
            picklist = await this.bigin.dealStages(read.connection);
            if (!picklist) error = 'Bigin has no Stage field on Deals';
        } catch (e) {
            // A token without the settings scope is refused here while it still reads records.
            error = `Bigin's stage list could not be read: ${e instanceof BiginApiError ? e.message : String(e)}`;
        }
        const mapping = biginStageIndex(read.mappings);
        const names = new Map<string, string>();
        for (const name of [
            ...(picklist ?? []),
            ...read.counts.seen.keys(),
            ...read.mappings.map((m) => m.biginStage),
        ]) {
            const key = biginStageKey(name);
            if (key && !names.has(key)) names.set(key, name.trim());
        }
        const rows: BiginStageMapRow[] = [...names].map(([key, biginStage]) => {
            const choice = chooseStage(read.pipeline.stages, mapping, biginStage);
            const explicit = mapping.get(key);
            return {
                biginStage,
                deals: read.counts.byKey.get(key) ?? 0,
                stageId: explicit && read.pipeline.stages.some((s) => s.id === explicit) ? explicit : null,
                targetStageId: choice.id,
                match: choice.match,
            };
        });
        return {
            source: picklist ? 'bigin' : 'imported',
            error: picklist ? null : error,
            pipelineId: read.pipeline.id,
            stages: read.pipeline.stages,
            rows,
            unread: read.counts.unread,
            apply: (read.apply as BiginStageApplyView | null) ?? null,
        };
    }

    /** Replaces the mapping: each Bigin stage with a stage of the default pipeline; a null one is unmapped. */
    async put(input: readonly BiginStageMappingInput[]): Promise<BiginStageMapView> {
        const { workspaceId } = this.current();
        const wanted = new Map<string, { biginStage: string; stageId: string }>();
        for (const row of input) {
            const biginStage = row.biginStage.trim();
            if (row.stageId) wanted.set(biginStageKey(biginStage), { biginStage, stageId: row.stageId });
            else wanted.delete(biginStageKey(biginStage));
        }
        await this.rls.withWorkspace(async (tx) => {
            if (!(await tx.biginImportSettings.findFirst({ select: { workspaceId: true } }))) throw noConnection();
            const pipeline = await defaultPipeline(tx);
            const ids = new Set(pipeline.stages.map((s) => s.id));
            const bad = [...wanted.values()].find((row) => !ids.has(row.stageId));
            if (bad) {
                throw new UnknownReference('mappings', `${bad.biginStage}: not a stage of the default pipeline`);
            }
            await tx.biginStageMapping.deleteMany({});
            if (wanted.size > 0) {
                await tx.biginStageMapping.createMany({
                    data: [...wanted.values()].map((row) => ({ workspaceId, ...row })),
                });
            }
        });
        return this.view();
    }

    /** Queues moving imported deals to where their Bigin stage now maps; one apply at a time. */
    async apply(): Promise<BiginStageApplyView> {
        const { workspaceId } = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const settings = await tx.biginImportSettings.findFirst({ select: { stageApply: true } });
            if (!settings) throw noConnection();
            const current = settings.stageApply as BiginStageApplyView | null;
            if (current && (current.status === 'queued' || current.status === 'running')) return current;
            const queued: BiginStageApplyView = {
                status: 'queued',
                requestedAt: new Date().toISOString(),
                finishedAt: null,
                moved: 0,
                skipped: 0,
                error: null,
            };
            await tx.$executeRaw`UPDATE "bigin_import_settings" SET "stage_apply" = ${JSON.stringify(queued)}::jsonb WHERE "workspace_id" = ${workspaceId}::uuid`;
            afterCommit('BiginStageMapService.apply', () => {
                void this.workers.enqueueStageApply(workspaceId);
            });
            return queued;
        });
    }

    private current() {
        const context = this.context.get();
        if (!context) throw new Error('BiginStageMapService is used inside a workspace scope');
        return context;
    }
}

async function defaultPipeline(tx: WorkspaceClient): Promise<{ id: string; stages: PipelineStageRef[] }> {
    const pipeline = await tx.pipeline.findFirst({ where: { isDefault: true }, select: { id: true } });
    if (!pipeline) throw new ApiException(422, 'unprocessable', 'this workspace has no default pipeline');
    const stages = await tx.pipelineStage.findMany({
        where: { pipelineId: pipeline.id },
        orderBy: { position: 'asc' },
        select: { id: true, name: true, kind: true },
    });
    return { id: pipeline.id, stages: stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind as StageKind })) };
}

/** Imported deals per Bigin stage (from their links' snapshots), and how many links have no stage yet. */
async function stageCounts(
    tx: WorkspaceClient,
): Promise<{ seen: Map<string, number>; byKey: Map<string, number>; unread: number }> {
    const rows = await tx.$queryRaw<{ stage: string | null; known: boolean; n: number }[]>`
        SELECT "snapshot"->>'stage' AS stage, ("snapshot"->'stage') IS NOT NULL AS known, count(*)::int AS n
        FROM "bigin_import_links"
        WHERE "object" = 'Deals'
        GROUP BY 1, 2`;
    const seen = new Map<string, number>();
    const byKey = new Map<string, number>();
    let unread = 0;
    for (const row of rows) {
        if (!row.known) {
            unread += row.n;
            continue;
        }
        if (!row.stage || !row.stage.trim()) continue;
        seen.set(row.stage, (seen.get(row.stage) ?? 0) + row.n);
        const key = biginStageKey(row.stage);
        byKey.set(key, (byKey.get(key) ?? 0) + row.n);
    }
    return { seen, byKey, unread };
}

function noConnection(): ApiException {
    return new ApiException(422, 'unprocessable', 'connect Bigin first', [
        { path: 'refreshToken', message: 'no Bigin connection is configured' },
    ]);
}
