import type { WorkspaceClient } from '../infra/rls-prisma.service';

/** A thread's count, last message and subject come from its rows after every write (one writer). */
export async function recountThread(tx: WorkspaceClient, threadId: string): Promise<void> {
    await tx.$executeRaw`
        UPDATE mail_threads t SET
            message_count = s.count,
            last_message_at = s.last_at,
            subject = COALESCE(s.first_subject, t.subject),
            updated_at = now()
        FROM (
            SELECT count(*)::int AS count, max(sent_at) AS last_at,
                   (SELECT subject FROM mail_messages f WHERE f.thread_id = ${threadId}::uuid ORDER BY f.sent_at ASC, f.id ASC LIMIT 1) AS first_subject
            FROM mail_messages WHERE thread_id = ${threadId}::uuid
        ) s
        WHERE t.id = ${threadId}::uuid`;
}
