import type { EmailSummary } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';

type MessageRow = Prisma.MailMessageGetPayload<object>;

/**
 * A stored message as events describe it (P2-2) — never its body. One definition: the import's
 * `email.received` / `email.sent` and a later match's `email.linked` carry the same summary.
 */
export function emailSummaryOf(row: MessageRow): EmailSummary {
    return {
        messageId: row.id,
        threadId: row.threadId,
        mailboxId: row.mailboxId,
        direction: row.direction,
        subject: row.subject,
        snippet: row.snippet,
        from: row.fromAddress,
        sentAt: row.sentAt.toISOString(),
        rfc822MessageId: row.rfc822MessageId,
        inReplyTo: row.inReplyTo,
        references: row.references,
    };
}
