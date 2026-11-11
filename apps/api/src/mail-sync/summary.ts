import type { DomainEvent, EmailSummary } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { MAIL_INITIAL_SYNC_DAYS } from './mail-sync.constants';

type MessageRow = Prisma.MailMessageGetPayload<object>;

/**
 * A stored message as events describe it (P2-2) — never its body. One definition: the import's
 * `email.received` / `email.sent` and a later match's `email.linked` carry the same summary.
 * `mailboxId` is the mailbox whose copy of it first stored it (#107).
 */
export function emailSummaryOf(row: MessageRow, mailboxId: string, historical = false): EmailSummary {
    return {
        ...(historical ? { historical: true } : {}),
        messageId: row.id,
        threadId: row.threadId,
        mailboxId,
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

/**
 * An `email.sent` / `email.received` about old mail: stored by the history backfill, or sent longer ago than the first
 * import reaches (an event queued before the backfill flagged its mail). Re-deriving a person's contact status or a
 * deal's cadence for each of them one by one is what fell hours behind on 2026-11-11 (~134k events); the backfill
 * refreshes the people of each window once, and cadence has its hourly run.
 */
export function isHistoricalMail(event: DomainEvent, now = Date.now()): boolean {
    if (event.type !== 'email.sent' && event.type !== 'email.received') return false;
    const email = event.email;
    if (!email) return false;
    if (email.historical) return true;
    return now - new Date(email.sentAt).getTime() > HISTORICAL_AFTER_MS;
}

/** Older than the first import reaches (`MAIL_INITIAL_SYNC_DAYS`), with a day's slack: only a backfill stores it. */
const HISTORICAL_AFTER_MS = (MAIL_INITIAL_SYNC_DAYS + 1) * 24 * 60 * 60 * 1000;
