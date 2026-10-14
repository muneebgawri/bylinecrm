import type { TwentyImportMode } from '@bylinecrm/shared';
import type { TwentyImportRun } from '@prisma/client';
import { StateConflict } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * Queues a run row — the one way a run starts, whether a person asked (`TwentyImportService.start`)
 * or the schedule did (#185). `changes` reads from the last successful run's start; with none, it
 * reads everything, and a run that failed meanwhile moves nothing: the next run resumes from the
 * same place. One queued or running run per workspace (the partial unique index): a second is a
 * `StateConflict`, which the caller turns into a `409` or into nothing started.
 */
export async function queueRun(
    tx: WorkspaceClient,
    input: {
        workspaceId: string;
        mode: TwentyImportMode;
        startedById: string | null;
        scheduled: boolean;
        /** The accounts option (#184): the role created members get; a scheduled run uses the workspace's saved choice. */
        createMembersRoleId?: string | null;
    },
): Promise<TwentyImportRun> {
    const last = await tx.twentyImportRun.findFirst({
        where: { status: 'succeeded', startedAt: { not: null } },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
    });
    try {
        return await tx.twentyImportRun.create({
            data: {
                workspaceId: input.workspaceId,
                mode: input.mode,
                since: input.mode === 'changes' ? (last?.startedAt ?? null) : null,
                startedById: input.startedById,
                scheduled: input.scheduled,
                createMembersRoleId: input.createMembersRoleId ?? null,
            },
        });
    } catch (error) {
        if (uniqueViolation(error)) throw new StateConflict('an import is already queued or running');
        throw error;
    }
}
