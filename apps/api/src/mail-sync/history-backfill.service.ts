import { Injectable } from '@nestjs/common';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { parseFloor, progressOf, type BackfillStatus } from './history-backfill';
import { MAIL_HISTORY_FLOOR_DEFAULT } from './mail-sync.constants';
import { MailSyncService } from './mail-sync.service';
import type { MailHistoryBackfillView } from './responses';

/**
 * The workspace's mail history backfill as an admin sees and starts it (Mailboxes page): every Gmail mailbox's floor,
 * how far back it has reached and what it stored. Starting sets each eligible mailbox's floor; the worker's tick walks
 * them (`MailSyncWorkers`), as the operator's CLI does (`cli/backfill-mail-history.ts`).
 */
@Injectable()
export class MailHistoryBackfill {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly sync: MailSyncService,
        private readonly context: WorkspaceContext,
    ) {}

    async view(): Promise<MailHistoryBackfillView> {
        const rows = await this.rls.withWorkspace((tx) =>
            tx.mailbox.findMany({
                where: { transport: 'gmail', status: { not: 'disconnected' }, purpose: { not: 'service' } },
                orderBy: { email: 'asc' },
                select: {
                    id: true,
                    email: true,
                    syncState: {
                        select: {
                            historyFloor: true,
                            backfillBefore: true,
                            backfillStatus: true,
                            backfillProgress: true,
                            backfillCompletedAt: true,
                        },
                    },
                },
            }),
        );
        const budget = await this.sync.backfillBudget();
        return {
            floor: MAIL_HISTORY_FLOOR_DEFAULT,
            usedBytes: budget.usedBytes,
            maxBytes: budget.maxBytes,
            mailboxes: rows.map((m) => {
                const state = m.syncState;
                const progress = progressOf(state?.backfillProgress);
                return {
                    mailboxId: m.id,
                    email: m.email,
                    status: (state?.backfillStatus ?? null) as BackfillStatus | null,
                    floor: state?.historyFloor ?? null,
                    reachedBack: state?.backfillBefore ?? null,
                    completedAt: state?.backfillCompletedAt ?? null,
                    imported: progress.imported,
                    listed: progress.listed,
                    unmatched: progress.unmatched,
                };
            }),
        };
    }

    /** Starts (or resumes) the backfill of every connected Gmail mailbox down to `since`. */
    async start(since: string): Promise<MailHistoryBackfillView> {
        let floor: Date;
        try {
            floor = parseFloor(since);
        } catch (error) {
            throw new ApiException(400, 'validation.failed', (error as Error).message);
        }
        const workspaceId = this.context.get()!.workspaceId;
        const mailboxes = await this.rls.withWorkspace((tx) =>
            tx.mailbox.findMany({ where: { transport: 'gmail', status: 'connected' }, select: { id: true } }),
        );
        for (const m of mailboxes) await this.sync.startBackfill(workspaceId, m.id, floor);
        return this.view();
    }
}
