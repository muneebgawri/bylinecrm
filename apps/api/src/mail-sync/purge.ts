import type { DomainEvent } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { heldOnlyByServiceInboxes, rematchMessage } from './matching';
import { reconcileMessageTargets } from './reconcile';
import { recountThread } from './threads';

/** A mailbox's copy of a message, as the purge needs it. */
export interface DoomedCopy {
    id: string;
    message: { id: string; threadId: string };
}

export interface Purged {
    purged: { messages: number; threads: number };
    events: DomainEvent[];
}

/**
 * Deletes these mailbox copies, and what nothing holds any more (#107), in one place for every reason a copy goes —
 * a blocklist entry that now covers the mail, a mailbox removed. A message goes (with its participants and timeline
 * entries) only when no mailbox holds a copy of it; one a service inbox alone still holds leaves its people's
 * records (SVC-1); a thread goes when it has no message left, with the mailbox mappings holding no copy.
 */
export async function purgeCopies(
    tx: WorkspaceClient,
    workspaceId: string,
    doomed: readonly DoomedCopy[],
): Promise<Purged> {
    if (doomed.length === 0) return { purged: { messages: 0, threads: 0 }, events: [] };
    await tx.mailMessageCopy.deleteMany({ where: { id: { in: doomed.map((c) => c.id) } } });
    const touched = [...new Set(doomed.map((c) => c.message.id))];
    const orphaned = (
        await tx.mailMessage.findMany({ where: { id: { in: touched }, copies: { none: {} } }, select: { id: true } })
    ).map((m) => m.id);
    const unmatched: string[] = [];
    for (const id of touched) {
        if (!orphaned.includes(id) && (await heldOnlyByServiceInboxes(tx, id))) {
            unmatched.push(...(await rematchMessage(tx, id)));
        }
    }
    const events = await reconcileMessageTargets(tx, workspaceId, unmatched);
    if (orphaned.length === 0) return { purged: { messages: 0, threads: 0 }, events };
    await tx.$queryRaw`SELECT delete_email_timeline_entries(${orphaned}::uuid[], NULL)`;
    await tx.mailMessage.deleteMany({ where: { id: { in: orphaned } } });
    const threadIds = [
        ...new Set(doomed.filter((c) => orphaned.includes(c.message.id)).map((c) => c.message.threadId)),
    ];
    await tx.mailboxThread.deleteMany({
        where: { threadId: { in: threadIds }, copies: { none: {} }, thread: { messages: { none: {} } } },
    });
    const emptied = await tx.mailThread.deleteMany({
        where: { id: { in: threadIds }, messages: { none: {} }, mailboxThreads: { none: {} } },
    });
    for (const threadId of threadIds) await recountThread(tx, threadId);
    return { purged: { messages: orphaned.length, threads: emptied.count }, events };
}
