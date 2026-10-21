import type { NotificationKind, NotificationTarget, NotificationTargetType } from '@bylinecrm/shared';
import type { Notification, Prisma } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * The one writer of notifications (#192, generalised by GUARD-2): a kind and a polymorphic target. The target's
 * type picks the typed foreign key it is stored in (`notifications` keeps one per type, so a deleted task, transfer,
 * guardrail event or invoice takes its notifications with it, and the database checks exactly one is set). Each
 * (member, kind, target) is told once — a unique row — so an event delivered again tells nobody twice.
 */
const COLUMN: Readonly<Record<NotificationTargetType, 'taskId' | 'transferId' | 'guardrailEventId' | 'invoiceId'>> = {
    task: 'taskId',
    transfer: 'transferId',
    guardrail: 'guardrailEventId',
    invoice: 'invoiceId',
};

/** Tells each member about each target, once per (member, kind, target). Returns how many rows were new. */
export async function notify(
    tx: WorkspaceClient | Prisma.TransactionClient,
    workspaceId: string,
    memberIds: Iterable<string>,
    kind: NotificationKind,
    targets: readonly NotificationTarget[],
): Promise<number> {
    const data: Prisma.NotificationCreateManyInput[] = [];
    for (const memberId of new Set(memberIds)) {
        for (const target of targets) {
            data.push({ workspaceId, memberId, kind, [COLUMN[target.type]]: target.id });
        }
    }
    if (data.length === 0) return 0;
    const { count } = await tx.notification.createMany({ data, skipDuplicates: true });
    return count;
}

/** A stored notification's target, read back from whichever typed column is set. */
export function targetOf(
    row: Pick<Notification, 'taskId' | 'transferId' | 'guardrailEventId' | 'invoiceId'>,
): NotificationTarget {
    for (const type of Object.keys(COLUMN) as NotificationTargetType[]) {
        const id = row[COLUMN[type]];
        if (id) return { type, id };
    }
    throw new Error('a notification has no target');
}
