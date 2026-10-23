import type { DomainEvent, EmailReply, EmailSummary, RecordTarget } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { recordTargetsForPeople } from './matching';

/**
 * What sync's writer does about mail the CRM sent (P2-3), at the moment a message is stored — so it
 * happens exactly once, whichever path stored it (the send job's import, or a later sync).
 *
 * - An **outbound** message that is one of our sends is linked to it (`mail_outbound.mail_message_id`)
 *   and the send records Gmail's own Message-ID (`provider_rfc822_message_id`): Gmail replaces the one
 *   we set (#87), so the copy is recognised by our `X-BylineCRM-Id` header, by Gmail's message id, or
 *   — where Gmail kept it — by our Message-ID.
 * - A message that answers one of our sends is a **reply**: it names our Message-ID or Gmail's (both
 *   on the send row — one source) in `In-Reply-To` / `References`, or it is in the send's conversation
 *   (the send's mailbox maps the send's Gmail thread to the message's thread), after it. It is judged
 *   once, when the message is first stored — never for another mailbox's later copy (#107) — and a
 *   message from the send's own mailbox never answers it. One reply, one `email.replied`.
 */

type MailboxRef = { id: string; workspaceId: string };

/** The stored copy of a message the mailbox sent, as the writer has it. */
export interface StoredOutbound {
    id: string;
    rfc822MessageId: string | null;
    providerMessageId: string;
    providerThreadId: string;
    /** Our `X-BylineCRM-Id`, when the copy carries it. */
    crmId: string | null;
}

/**
 * Links a stored message to the send it is a copy of — called for this mailbox's outbound copy,
 * whether or not another mailbox stored the message first (#107) — and records Gmail's ids on the send.
 */
export async function linkOutbound(tx: WorkspaceClient, mailbox: MailboxRef, message: StoredOutbound): Promise<void> {
    const send = await tx.mailOutbound.findFirst({
        where: {
            mailboxId: mailbox.id,
            mailMessageId: null,
            OR: [
                ...(message.crmId ? [{ id: message.crmId }] : []),
                { providerMessageId: message.providerMessageId },
                ...(message.rfc822MessageId ? [{ rfc822MessageId: message.rfc822MessageId }] : []),
            ],
        },
        select: { id: true, providerMessageId: true },
    });
    if (!send) return;
    await tx.mailOutbound.update({
        where: { id: send.id },
        data: {
            mailMessageId: message.id,
            providerRfc822MessageId: message.rfc822MessageId,
            // A send whose answer was lost learns Gmail's ids here, from the copy.
            ...(send.providerMessageId
                ? {}
                : { providerMessageId: message.providerMessageId, providerThreadId: message.providerThreadId }),
        },
    });
}

interface AnsweredSend {
    id: string;
    mail_message_id: string | null;
    deal_id: string | null;
}

/**
 * The `email.replied` a newly stored message causes, or `null` when it answers none of our sends.
 * `fromPeople` are the people the reply is from (its `From`, matched).
 */
export async function replyEventFor(
    tx: WorkspaceClient,
    mailbox: MailboxRef,
    inbound: {
        id: string;
        threadId: string;
        /** Its `From`: a message the send's own mailbox sent is never a reply to the send. */
        from: string;
        inReplyTo: string | null;
        references: string[];
        sentAt: Date;
    },
    email: EmailSummary,
    fromPeople: readonly string[],
): Promise<DomainEvent | null> {
    const ids = [...new Set([inbound.inReplyTo, ...inbound.references].filter((x): x is string => !!x))];
    // With no ids the comparison is simply false — an expression, so it may also order the rows.
    // Ours, or Gmail's replacement for it (#87): both live on the send row.
    const byHeader = Prisma.sql`(o.rfc822_message_id = ANY(${ids}::text[]) OR o.provider_rfc822_message_id = ANY(${ids}::text[]))`;
    const [send] = await tx.$queryRaw<AnsweredSend[]>`
        SELECT o.id, o.mail_message_id, o.deal_id
        FROM mail_outbound o
        JOIN mailboxes b ON b.id = o.mailbox_id
        WHERE o.status IN ('sending', 'sent')
          AND b.email <> ${inbound.from}
          AND ((${byHeader})
               OR (EXISTS (
                       SELECT 1 FROM mailbox_threads mt
                       WHERE mt.mailbox_id = o.mailbox_id
                         AND mt.provider_thread_id = o.provider_thread_id
                         AND mt.thread_id = ${inbound.threadId}::uuid)
                   -- In the thread is not enough: mail sync stores late may predate our send.
                   -- A Date header has whole seconds (RFC 5322), so compare at that precision.
                   AND ${inbound.sentAt} >= date_trunc('second', o.created_at)))
        ORDER BY (${byHeader}) DESC, o.sent_at DESC NULLS LAST, o.id
        LIMIT 1`;
    if (!send) return null;

    const people = [...new Set(fromPeople)];
    const targets = await recordTargetsForPeople(tx, people);
    const dealIds = targets.filter((t) => t.type === 'opportunity').map((t) => t.id);
    if (send.deal_id && !dealIds.includes(send.deal_id)) {
        const open = await tx.opportunity.findFirst({
            where: { id: send.deal_id, deletedAt: null, stage: { kind: 'open' } },
            select: { id: true },
        });
        if (open) dealIds.push(open.id);
    }
    const related: RecordTarget[] = targets.filter((t) => t.type === 'person' || t.type === 'company');
    const reply: EmailReply = {
        messageId: inbound.id,
        inReplyToOutboundId: send.id,
        inReplyToMessageId: send.mail_message_id,
        threadId: inbound.threadId,
        personIds: targets.filter((t) => t.type === 'person').map((t) => t.id),
        dealIds,
    };
    return {
        type: 'email.replied',
        object: 'email',
        workspaceId: mailbox.workspaceId,
        actor: { kind: 'sync', id: mailbox.id },
        occurredAt: email.sentAt,
        recordId: inbound.id,
        related,
        email,
        reply,
    };
}

/**
 * Whether any of `addresses` has written since `since` — in one thread when `threadId` is given, anywhere
 * otherwise. The backstop a sequence (before every step) and a queued follow-up (at its time) both read, in case
 * the `email.replied` that stops them is still on its way.
 */
export async function hasReplyFrom(
    tx: WorkspaceClient,
    where: { addresses: readonly string[]; since: Date; threadId?: string | undefined },
): Promise<boolean> {
    if (where.addresses.length === 0) return false;
    const reply = await tx.mailMessage.findFirst({
        where: {
            fromAddress: { in: [...where.addresses], mode: 'insensitive' },
            sentAt: { gt: where.since },
            ...(where.threadId ? { threadId: where.threadId } : {}),
        },
        select: { id: true },
    });
    return reply !== null;
}
