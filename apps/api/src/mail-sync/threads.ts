import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { ParsedMessage } from './parse-message';

/**
 * What makes two mailboxes' copies one message (#107): its RFC 822 Message-ID — Gmail's own, which
 * replaces the one we set (#87). A message without one (rare, malformed mail) is its own: keyed by
 * the mailbox and Gmail's id, it never merges.
 */
export function identityKeyOf(
    mailboxId: string,
    parsed: Pick<ParsedMessage, 'rfc822MessageId' | 'providerMessageId'>,
): string {
    return parsed.rfc822MessageId ?? `gmail:${mailboxId}:${parsed.providerMessageId}`;
}

/**
 * The conversation of a message this one names in `In-Reply-To` / `References`, when the workspace
 * has it — so the first message a mailbox sees of a conversation another mailbox started joins it.
 */
export async function threadOfReferenced(
    tx: WorkspaceClient,
    parsed: Pick<ParsedMessage, 'inReplyTo' | 'references'>,
): Promise<string | null> {
    const ids = [...new Set([parsed.inReplyTo, ...parsed.references].filter((x): x is string => !!x))];
    if (ids.length === 0) return null;
    const named = await tx.mailMessage.findFirst({
        where: { identityKey: { in: ids } },
        orderBy: [{ sentAt: 'desc' }, { id: 'asc' }],
        select: { threadId: true },
    });
    return named?.threadId ?? null;
}

/**
 * A thread's count, last message and subject come from its rows after every write (one writer). A
 * `Date` header has whole seconds, so messages of one second are ordered as they were stored.
 */
export async function recountThread(tx: WorkspaceClient, threadId: string): Promise<void> {
    await tx.$executeRaw`
        UPDATE mail_threads t SET
            message_count = s.count,
            last_message_at = s.last_at,
            subject = COALESCE(s.first_subject, t.subject),
            updated_at = now()
        FROM (
            SELECT count(*)::int AS count, max(sent_at) AS last_at,
                   (SELECT subject FROM mail_messages f WHERE f.thread_id = ${threadId}::uuid ORDER BY f.sent_at ASC, f.created_at ASC, f.id ASC LIMIT 1) AS first_subject
            FROM mail_messages WHERE thread_id = ${threadId}::uuid
        ) s
        WHERE t.id = ${threadId}::uuid`;
}
