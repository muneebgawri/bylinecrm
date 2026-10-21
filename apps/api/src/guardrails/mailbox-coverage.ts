import type { MailboxCoverageView } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/** How a member's mail is seen, when it is. */
export type SyncedVia = NonNullable<MailboxCoverageView['syncedVia']>;

/**
 * One way a member's mail can be seen by sync: given the workspace's active members, those it covers. The
 * detector (GUARD-2) only sees mail that reaches sync, so a member covered by none of these can mail anyone
 * unseen — what the admin view lists.
 */
export type SyncSource = (tx: WorkspaceClient, memberIds: readonly string[]) => Promise<ReadonlySet<string>>;

/** A connected personal mailbox the member owns. */
const ownMailbox: SyncSource = async (tx, memberIds) =>
    new Set(
        (
            await tx.mailbox.findMany({
                where: { ownerMemberId: { in: [...memberIds] }, purpose: 'personal', status: 'connected' },
                select: { ownerMemberId: true },
            })
        ).map((m) => m.ownerMemberId),
    );

/**
 * The sources, in the order a member is credited to one. #225 (Google Workspace delegation) adds
 * `['delegation', delegatedMembers]` here; nothing else changes.
 */
export const SYNC_SOURCES: ReadonlyArray<readonly [SyncedVia, SyncSource]> = [['mailbox', ownMailbox]];

/** For each member, how their mail is seen; absent from the map = not seen at all. */
export async function syncedMembers(
    tx: WorkspaceClient,
    memberIds: readonly string[],
    sources: ReadonlyArray<readonly [SyncedVia, SyncSource]> = SYNC_SOURCES,
): Promise<Map<string, SyncedVia>> {
    const via = new Map<string, SyncedVia>();
    for (const [name, source] of sources) {
        const left = memberIds.filter((id) => !via.has(id));
        if (left.length === 0) break;
        for (const id of await source(tx, left)) via.set(id, name);
    }
    return via;
}

/** The admin view: every active member, whether their mail is seen and how, and their personal mailboxes. */
export async function mailboxCoverage(tx: WorkspaceClient): Promise<MailboxCoverageView[]> {
    const members = await tx.workspaceMember.findMany({
        where: { leftAt: null },
        select: {
            id: true,
            user: { select: { displayName: true, email: true } },
            role: { select: { name: true } },
            mailboxes: {
                where: { purpose: 'personal' },
                select: { email: true, status: true },
                orderBy: { email: 'asc' },
            },
        },
        orderBy: { createdAt: 'asc' },
    });
    const via = await syncedMembers(
        tx,
        members.map((m) => m.id),
    );
    return members
        .map((m) => ({
            memberId: m.id,
            name: m.user.displayName,
            email: m.user.email,
            role: m.role.name,
            syncedVia: via.get(m.id) ?? null,
            mailboxes: m.mailboxes,
        }))
        .sort((a, b) => Number(a.syncedVia !== null) - Number(b.syncedVia !== null));
}
