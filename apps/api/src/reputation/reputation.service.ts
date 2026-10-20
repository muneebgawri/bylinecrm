import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { MailboxPause, PausedMailboxView, ReputationSettings, ReputationSettingsView } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { pickReputationSettings, primaryDomainIn, reputationSettingsIn } from './settings';

/**
 * The workspace's sender-reputation thresholds (REP-1): read by reviewers, set by admins. REP-2: the mailboxes the
 * reply-rate floor or the spam-rate kill switch paused, and a manager's resume.
 */
@Injectable()
export class ReputationService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
    ) {}

    settings(): Promise<ReputationSettingsView> {
        return this.rls.withWorkspace(async (tx) => {
            const s = await reputationSettingsIn(tx);
            return { ...s, effectivePrimaryDomain: await primaryDomainIn(tx, s) };
        });
    }

    async updateSettings(input: ReputationSettings): Promise<ReputationSettingsView> {
        const workspaceId = this.current().workspaceId;
        return this.rls.withWorkspace(async (tx) => {
            const s = pickReputationSettings(
                await tx.reputationSettings.upsert({
                    where: { workspaceId },
                    create: { workspaceId, ...input },
                    update: input,
                }),
            );
            return { ...s, effectivePrimaryDomain: await primaryDomainIn(tx, s) };
        });
    }

    /** Every paused mailbox, personal and pool, oldest pause first. */
    async paused(): Promise<PausedMailboxView[]> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.mailbox.findMany({
                where: { pausedAt: { not: null }, status: { not: 'disconnected' } },
                orderBy: { pausedAt: 'asc' },
                select: { id: true, email: true, purpose: true, pausedAt: true, pauseReason: true },
            });
            return rows.map((m) => ({
                mailboxId: m.id,
                email: m.email,
                purpose: m.purpose,
                pausedAt: m.pausedAt!.toISOString(),
                pause: m.pauseReason as unknown as MailboxPause,
            }));
        });
    }

    /** A manager lifts a pause, saying why. The reply rate is judged again from now. */
    async resume(mailboxId: string, note: string): Promise<PausedMailboxView[]> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const mailbox = await tx.mailbox.findUnique({ where: { id: mailboxId } });
            if (!mailbox) throw new NotFoundException('mailbox not found');
            if (!mailbox.pausedAt) throw new ConflictException(`${mailbox.email} is not paused`);
            const now = new Date();
            await tx.mailbox.update({
                where: { id: mailboxId },
                data: {
                    pausedAt: null,
                    pauseReason: Prisma.DbNull,
                    resumedAt: now,
                    resumedByMemberId: context.memberId ?? null,
                    resumeNote: note,
                },
            });
            await this.events.record(tx, {
                type: 'mailbox.resumed',
                object: 'mailbox',
                workspaceId: context.workspaceId,
                actor: context.memberId ? { kind: 'member', id: context.memberId } : { kind: 'system', id: null },
                occurredAt: now.toISOString(),
                recordId: mailboxId,
                pause: mailbox.pauseReason as unknown as MailboxPause,
            });
        });
        return this.paused();
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('ReputationService is used inside a workspace scope');
        return context;
    }
}
