import type { DomainEvent, EmailReply, EmailSummary, RecordTarget } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { recordTargetsForPeople } from './matching';

/**
 * What sync's writer does about mail the CRM sent (P2-3), at the moment a message is stored — so it
 * happens exactly once, whichever path stored it (the send job's import, or a later sync).
 *
 * - An **outbound** message that is one of our sends is linked to it (`mail_outbound.mail_message_id`).
 * - An **inbound** message that answers one of our sends is a **reply**: it names our send's
 *   Message-ID (or its stored copy's — Gmail's — Message-ID) in `In-Reply-To` / `References`, or it
 *   arrived in the same mailbox's Gmail thread as the send, after it. One reply, one `email.replied`.
 */

type MailboxRef = { id: string; workspaceId: string };

/** Links a stored outbound message to the send it is a copy of: by our Message-ID, or by Gmail's id. */
export async function linkOutbound(
    tx: WorkspaceClient,
    mailbox: MailboxRef,
    message: { id: string; rfc822MessageId: string | null; providerMessageId: string },
): Promise<void> {
    await tx.mailOutbound.updateMany({
        where: {
            mailMessageId: null,
            OR: [
                ...(message.rfc822MessageId ? [{ rfc822MessageId: message.rfc822MessageId }] : []),
                { mailboxId: mailbox.id, providerMessageId: message.providerMessageId },
            ],
        },
        data: { mailMessageId: message.id },
    });
}

interface AnsweredSend {
    id: string;
    mail_message_id: string | null;
    deal_id: string | null;
}

/**
 * The `email.replied` an inbound message causes, or `null` when it answers none of our sends.
 * `fromPeople` are the people the reply is from (its `From`, matched).
 */
export async function replyEventFor(
    tx: WorkspaceClient,
    mailbox: MailboxRef,
    inbound: {
        id: string;
        threadId: string;
        providerThreadId: string;
        inReplyTo: string | null;
        references: string[];
        sentAt: Date;
    },
    email: EmailSummary,
    fromPeople: readonly string[],
): Promise<DomainEvent | null> {
    const ids = [...new Set([inbound.inReplyTo, ...inbound.references].filter((x): x is string => !!x))];
    // With no ids the comparison is simply false — an expression, so it may also order the rows.
    const byHeader = Prisma.sql`(o.rfc822_message_id = ANY(${ids}::text[]) OR m.rfc822_message_id = ANY(${ids}::text[]))`;
    const [send] = await tx.$queryRaw<AnsweredSend[]>`
        SELECT o.id, o.mail_message_id, o.deal_id
        FROM mail_outbound o
        LEFT JOIN mail_messages m ON m.id = o.mail_message_id
        WHERE o.status IN ('sending', 'sent')
          AND ((${byHeader})
               OR (o.mailbox_id = ${mailbox.id}::uuid
                   AND o.provider_thread_id = ${inbound.providerThreadId}
                   -- In the thread is not enough: mail sync stores late may predate our send.
                   AND ${inbound.sentAt} >= o.created_at))
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
