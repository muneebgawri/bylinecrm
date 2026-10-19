import { Inject, Injectable, Logger } from '@nestjs/common';
import {
    TWENTY_SYNC_FAILURES_BEFORE_NOTICE,
    type BiginImportSyncView,
    type TwentySyncEvery,
    type TwentySyncInterval,
} from '@bylinecrm/shared';
import type { BiginImportRun, BiginImportSettings } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { StateConflict } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { AccountMail } from '../transactional-mail/account-mail';
import { workspaceAdmins } from '../import-common/admins';
import { syncWaitMs } from '../twenty-import/twenty-sync';
import { biginReportFrom, queueBiginRun } from './bigin-import.settings';

/**
 * The automatic Bigin sync's bookkeeping (BIGIN-1), the Twenty sync's (#185) on Bigin's settings row: a
 * tick starts one `changes` run when one is due; a scheduled run that ends is counted. Failing loudly:
 * a run that failed, or one that finished with records it could not write (the module's cursor holds at
 * the oldest of them, so the next run meets them again), lengthens the streak; the schedule backs off by
 * it, and the third in a row is mailed to every admin, once. Only a clean run ends a streak.
 */
@Injectable()
export class BiginSyncService {
    private readonly logger = new Logger(BiginSyncService.name);

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly rls: RlsPrismaService,
        private readonly mail: AccountMail,
    ) {}

    tick(workspaceId: string): Promise<string | null> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const settings = await tx.biginImportSettings.findFirst();
            if (!settings || settings.syncInterval === 'off') return null;
            const open = await tx.biginImportRun.findFirst({
                where: { status: { in: ['queued', 'running'] } },
                select: { id: true },
            });
            if (open) return null;
            if (settings.syncFailures > 0) {
                const last = await tx.biginImportRun.findFirst({
                    where: { scheduled: true, finishedAt: { not: null } },
                    orderBy: { finishedAt: 'desc' },
                    select: { finishedAt: true },
                });
                const wait = syncWaitMs(settings.syncInterval as TwentySyncEvery, settings.syncFailures);
                if (last?.finishedAt && last.finishedAt.getTime() + wait > Date.now()) return null;
            }
            try {
                const run = await queueBiginRun(tx, {
                    workspaceId,
                    mode: 'changes',
                    startedById: null,
                    scheduled: true,
                    createMembersRoleId: settings.createMembersRoleId,
                });
                return run.id;
            } catch (error) {
                if (error instanceof StateConflict) return null;
                throw error;
            }
        });
    }

    /** A run ended, in the transaction that ended it: a scheduled run's outcome is the schedule's record. */
    async recordOutcome(tx: WorkspaceClient, run: BiginImportRun): Promise<void> {
        if (!run.scheduled) return;
        const failure = outcomeError(run);
        if (failure === null) {
            if (run.status !== 'succeeded') return;
            await tx.biginImportSettings.updateMany({
                where: { workspaceId: run.workspaceId },
                data: { syncFailures: 0, syncLastError: null },
            });
            return;
        }
        await tx.biginImportSettings.updateMany({
            where: { workspaceId: run.workspaceId },
            data: { syncFailures: { increment: 1 }, syncLastError: failure },
        });
        const settings = await tx.biginImportSettings.findFirst();
        if (settings?.syncFailures === TWENTY_SYNC_FAILURES_BEFORE_NOTICE) {
            await this.notifyAdmins(tx, run, settings, failure);
        }
    }

    view(settings: BiginImportSettings | null, nextRunAt: Date | null): BiginImportSyncView {
        const interval = (settings?.syncInterval ?? 'off') as TwentySyncInterval;
        return {
            interval,
            nextRunAt: interval === 'off' ? null : (nextRunAt?.toISOString() ?? null),
            failures: settings?.syncFailures ?? 0,
            lastError: settings?.syncLastError ?? null,
            cutoverAt: settings?.cutoverAt?.toISOString() ?? null,
        };
    }

    private async notifyAdmins(
        tx: WorkspaceClient,
        run: BiginImportRun,
        settings: BiginImportSettings,
        error: string,
    ): Promise<void> {
        const workspace = await tx.workspace.findUnique({ where: { id: run.workspaceId }, select: { name: true } });
        const admins = await workspaceAdmins(tx);
        if (admins.length === 0) {
            this.logger.warn(
                `bigin sync in ${run.workspaceId} failed ${settings.syncFailures} times: no admin to tell`,
            );
            return;
        }
        for (const admin of admins) {
            await this.mail.biginSyncFailing(tx, {
                workspaceId: run.workspaceId,
                to: admin.email,
                memberId: admin.id,
                runId: run.id,
                workspaceName: workspace?.name ?? 'your workspace',
                failures: settings.syncFailures,
                error,
                url: `${this.env.WEB_URL}/w/${run.workspaceId}/settings/import-bigin`,
            });
        }
    }
}

/** Why a finished run counts against the schedule, or null when it does not: failed, or records left unwritten. */
export function outcomeError(run: Pick<BiginImportRun, 'status' | 'error' | 'report'>): string | null {
    if (run.status === 'failed') return run.error ?? 'the run failed';
    if (run.status !== 'succeeded') return null;
    const failed = biginReportFrom(run.report).filter((entry) => entry.failed > 0);
    if (failed.length === 0) return null;
    const total = failed.reduce((sum, entry) => sum + entry.failed, 0);
    const first = failed.flatMap((entry) =>
        entry.errors.map((e) => `${entry.object} ${e.externalId}: ${e.message}`),
    )[0];
    return `${total} record${total === 1 ? '' : 's'} could not be written${first ? ` (first: ${first})` : ''}`;
}
