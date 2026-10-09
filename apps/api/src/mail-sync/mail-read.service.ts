import { Injectable } from '@nestjs/common';
import type { MailSyncStatus, RecordTarget } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { MailboxesService } from '../mail-accounts/mailboxes.service';
import { type Page, paginate } from '../records/list-query';
import { readableTargets } from '../records/targets';
import type { MailMessageView, MailThreadSummary, MailThreadView, MailboxSyncView } from './responses';

type MessageWithParticipants = Prisma.MailMessageGetPayload<{ include: { participants: true } }>;

/**
 * Reading synced mail (P2-2). Who sees what:
 *
 * - A thread is listed on a record (`?target=`) the caller can read — the record's own visibility,
 *   `readableTargets`, under the caller's policies — when one of its participants is that person,
 *   one of that company's people, or that deal's point of contact.
 * - Opening a thread: the mailbox's owner sees everything. Anyone else needs to read a person the
 *   thread concerns; then they see the bodies of a **pool** mailbox's mail, and only the subject,
 *   snippet and participants of another member's **personal** mailbox (`bodiesVisible: false`).
 *   A thread they cannot reach that way does not exist for them (`404`).
 */
@Injectable()
export class MailReadService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly mailboxes: MailboxesService,
    ) {}

    listThreads(target: RecordTarget, cursor: string | undefined, limit: number): Promise<Page<MailThreadSummary>> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            if ((await readableTargets(tx, [target])).length === 0) {
                throw new ApiException(404, 'not_found', 'target not found');
            }
            const people = await peopleOf(tx, target);
            if (people.length === 0) return { items: [], nextCursor: null };
            const result = await paginate(limit, cursor, (args) =>
                tx.mailThread.findMany({
                    where: { messages: { some: { participants: { some: { personId: { in: people } } } } } },
                    orderBy: [{ lastMessageAt: 'desc' }, { id: 'asc' }],
                    include: { messages: { orderBy: [{ sentAt: 'desc' }, { id: 'asc' }], take: 1 } },
                    ...args,
                }),
            );
            return {
                items: result.items.map((t) => {
                    const last = t.messages[0]!;
                    return {
                        id: t.id,
                        mailboxId: t.mailboxId,
                        subject: t.subject,
                        messageCount: t.messageCount,
                        lastMessageAt: t.lastMessageAt,
                        lastMessage: {
                            direction: last.direction,
                            from: last.fromAddress,
                            snippet: last.snippet,
                            sentAt: last.sentAt,
                        },
                    };
                }),
                nextCursor: result.nextCursor,
            };
        });
    }

    getThread(threadId: string): Promise<MailThreadView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const thread = await tx.mailThread.findUnique({
                where: { id: threadId },
                include: {
                    mailbox: { select: { ownerMemberId: true, purpose: true } },
                    messages: { orderBy: [{ sentAt: 'asc' }, { id: 'asc' }], include: { participants: true } },
                },
            });
            if (!thread) throw new ApiException(404, 'not_found', 'thread not found');
            const isOwner = context.memberId !== undefined && thread.mailbox.ownerMemberId === context.memberId;
            if (!isOwner) {
                const personIds = [
                    ...new Set(thread.messages.flatMap((m) => m.participants.map((p) => p.personId))),
                ].filter((id): id is string => id !== null);
                const readable = await readableTargets(
                    tx,
                    personIds.map((id) => ({ type: 'person' as const, id })),
                );
                if (readable.length === 0) throw new ApiException(404, 'not_found', 'thread not found');
            }
            const bodiesVisible = isOwner || thread.mailbox.purpose === 'pool';
            return {
                id: thread.id,
                mailboxId: thread.mailboxId,
                subject: thread.subject,
                messageCount: thread.messageCount,
                lastMessageAt: thread.lastMessageAt,
                bodiesVisible,
                messages: thread.messages.map((m) => messageView(m, bodiesVisible)),
            };
        });
    }

    /** The mailbox's sync state, for whoever may see the mailbox (P2-1's rule). */
    async syncState(mailboxId: string): Promise<MailboxSyncView> {
        await this.mailboxes.get(mailboxId);
        return this.rls.withWorkspace(async (tx) => syncView(tx, mailboxId));
    }

    readSyncState(mailboxId: string): Promise<MailboxSyncView> {
        return this.rls.withWorkspace(async (tx) => syncView(tx, mailboxId));
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('mail read used outside a workspace context');
        return context;
    }
}

/** The people whose mail is on a record: the person, a company's live people, a deal's point of contact. */
async function peopleOf(tx: WorkspaceClient, target: RecordTarget): Promise<string[]> {
    switch (target.type) {
        case 'person':
            return [target.id];
        case 'company':
            return (
                await tx.person.findMany({ where: { companyId: target.id, deletedAt: null }, select: { id: true } })
            ).map((p) => p.id);
        case 'opportunity': {
            const deal = await tx.opportunity.findUnique({
                where: { id: target.id },
                select: { pointOfContactId: true },
            });
            return deal?.pointOfContactId ? [deal.pointOfContactId] : [];
        }
    }
}

function messageView(m: MessageWithParticipants, bodiesVisible: boolean): MailMessageView {
    return {
        id: m.id,
        direction: m.direction,
        from: m.fromAddress,
        subject: m.subject,
        snippet: m.snippet,
        sentAt: m.sentAt,
        participants: m.participants.map((p) => ({
            role: p.role,
            address: p.address,
            displayName: p.displayName,
            personId: p.personId,
            memberId: p.memberId,
        })),
        hasAttachments: m.hasAttachments,
        bodyText: bodiesVisible ? m.bodyText : null,
        bodyHtml: bodiesVisible ? m.bodyHtmlSanitized : null,
        bodyTruncated: m.bodyTruncated,
        rfc822MessageId: m.rfc822MessageId,
        inReplyTo: m.inReplyTo,
    };
}

async function syncView(tx: WorkspaceClient, mailboxId: string): Promise<MailboxSyncView> {
    const row = await tx.mailboxSyncState.findUnique({ where: { mailboxId } });
    const lastError = (row?.lastError ?? null) as { code: string; message: string; at: string } | null;
    return {
        mailboxId,
        status: (row?.status ?? 'idle') as MailSyncStatus,
        lastSyncedAt: row?.lastSyncedAt ?? null,
        fullSyncCompletedAt: row?.fullSyncCompletedAt ?? null,
        lastError: lastError ? { code: lastError.code, message: lastError.message, at: new Date(lastError.at) } : null,
    };
}
