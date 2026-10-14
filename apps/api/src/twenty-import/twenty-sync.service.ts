import { Inject, Injectable, Logger } from '@nestjs/common';
import {
    TWENTY_SYNC_FAILURES_BEFORE_NOTICE,
    type TwentyImportSyncView,
    type TwentySyncEvery,
    type TwentySyncInterval,
} from '@bylinecrm/shared';
import type { TwentyImportRun, TwentyImportSettings } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { StateConflict } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { AccountMail } from '../transactional-mail/account-mail';
import { capabilitiesOf } from '../workspace/roles.service';
import { queueRun } from './twenty-import.runs';
import { syncWaitMs } from './twenty-sync';

/**
 * The automatic sync's bookkeeping (#185, P4-4f), on the workspace's settings row: a tick of the
 * schedule starts one `changes` run when one is due, and a scheduled run that ends is counted —
 * a success ends a streak of failures, a failure lengthens it, and the third in a row tells the
 * workspace's admins, once. The schedule itself (a BullMQ job scheduler per workspace) is the
 * workers'; what it does when it fires is here.
 */
@Injectable()
export class TwentySyncService {
    private readonly logger = new Logger(TwentySyncService.name);

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly rls: RlsPrismaService,
        private readonly mail: AccountMail,
    ) {}

    /**
     * The schedule fired for the workspace: the id of the run it queued, or null when nothing is to
     * be started — syncing is off, a run is queued or running already (the one run per workspace the
     * importer keeps), or the last scheduled run failed and its backoff has not passed.
     */
    tick(workspaceId: string): Promise<string | null> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const settings = await tx.twentyImportSettings.findFirst();
            if (!settings || settings.syncInterval === 'off') return null;
            const open = await tx.twentyImportRun.findFirst({
                where: { status: { in: ['queued', 'running'] } },
                select: { id: true },
            });
            if (open) return null;
            if (settings.syncFailures > 0) {
                const last = await tx.twentyImportRun.findFirst({
                    where: { scheduled: true, finishedAt: { not: null } },
                    orderBy: { finishedAt: 'desc' },
                    select: { finishedAt: true },
                });
                const wait = syncWaitMs(settings.syncInterval as TwentySyncEvery, settings.syncFailures);
                if (last?.finishedAt && last.finishedAt.getTime() + wait > Date.now()) return null;
            }
            try {
                // The accounts option (#184) as last chosen at a start: the workspace's choice, with its role.
                const run = await queueRun(tx, {
                    workspaceId,
                    mode: 'changes',
                    startedById: null,
                    scheduled: true,
                    createMembersRoleId: settings.createMembersRoleId,
                });
                return run.id;
            } catch (error) {
                // A person started one between the check and the insert: theirs runs.
                if (error instanceof StateConflict) return null;
                throw error;
            }
        });
    }

    /**
     * A run ended, in the transaction that ended it. A scheduled run's outcome is the schedule's
     * record: a success resets the streak; a failure counts, and the third in a row is mailed to
     * every admin of the workspace — recorded in the same transaction, sent by the mail relay.
     */
    async recordOutcome(tx: WorkspaceClient, run: TwentyImportRun): Promise<void> {
        if (!run.scheduled) return;
        if (run.status === 'succeeded') {
            await tx.twentyImportSettings.updateMany({
                where: { workspaceId: run.workspaceId },
                data: { syncFailures: 0, syncLastError: null },
            });
            return;
        }
        if (run.status !== 'failed') return;
        await tx.twentyImportSettings.updateMany({
            where: { workspaceId: run.workspaceId },
            data: { syncFailures: { increment: 1 }, syncLastError: run.error },
        });
        const settings = await tx.twentyImportSettings.findFirst();
        if (settings?.syncFailures === TWENTY_SYNC_FAILURES_BEFORE_NOTICE) await this.notifyAdmins(tx, run, settings);
    }

    /** The sync as the screen shows it; `nextRunAt` is the scheduler's, read by the caller outside any transaction. */
    view(settings: TwentyImportSettings | null, nextRunAt: Date | null): TwentyImportSyncView {
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
        run: TwentyImportRun,
        settings: TwentyImportSettings,
    ): Promise<void> {
        const workspace = await tx.workspace.findUnique({ where: { id: run.workspaceId }, select: { name: true } });
        // Who may run the importer: the members whose role holds `workspace:admin` — resolved the way
        // the guard does, since the system admin role is every capability without stored rows.
        const members = await tx.workspaceMember.findMany({
            where: { leftAt: null },
            select: {
                id: true,
                user: { select: { email: true } },
                role: { select: { name: true, isSystem: true, permissions: { select: { capability: true } } } },
            },
        });
        const admins = members.filter((m) =>
            capabilitiesOf(
                m.role,
                m.role.permissions.map((p) => p.capability),
            ).has('workspace:admin'),
        );
        if (admins.length === 0) {
            this.logger.warn(
                `twenty sync in ${run.workspaceId} failed ${settings.syncFailures} times: no admin to tell`,
            );
            return;
        }
        for (const admin of admins) {
            await this.mail.twentySyncFailing(tx, {
                workspaceId: run.workspaceId,
                to: admin.user.email,
                memberId: admin.id,
                runId: run.id,
                workspaceName: workspace?.name ?? 'your workspace',
                failures: settings.syncFailures,
                error: run.error ?? 'the run failed',
                url: `${this.env.WEB_URL}/w/${run.workspaceId}/settings/import-twenty`,
            });
        }
    }
}
