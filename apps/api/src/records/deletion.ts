import type { DeleteReason, RecordDeletion, RecordObject, Trashed } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import type { CountedPage } from './list-query';

/** What a caller may say when deleting a record: why, and a note. Both optional (an integration says neither). */
export interface DeletionWhy {
    reason?: DeleteReason | undefined;
    note?: string | undefined;
}

/** A record's move to the trash, as its row is written: when, why, and which member did it (null: a key or a job). */
export function trashedNow(context: WorkspaceRunContext, why?: DeletionWhy) {
    return {
        deletedAt: new Date(),
        deletedReason: why?.reason ?? null,
        deletedNote: why?.note ?? null,
        deletedByMemberId: context.memberId ?? null,
    };
}

/** A record's return from the trash: nothing of its deletion is kept on the row (its timeline keeps the events). */
export const RESTORED = { deletedAt: null, deletedReason: null, deletedNote: null, deletedByMemberId: null } as const;

const DELETION = {
    id: true,
    deletedAt: true,
    deletedReason: true,
    deletedNote: true,
    deletedByMemberId: true,
} as const;

/** A page of the trash with each record's deletion: one read for the page, in the caller's scope. */
export async function withDeletions<V extends { id: string }>(
    tx: WorkspaceClient,
    object: RecordObject,
    page: CountedPage<V>,
): Promise<CountedPage<Trashed<V>>> {
    const where = { id: { in: page.items.map((i) => i.id) } };
    const rows =
        object === 'person'
            ? await tx.person.findMany({ where, select: DELETION })
            : object === 'company'
              ? await tx.company.findMany({ where, select: DELETION })
              : await tx.opportunity.findMany({ where, select: DELETION });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const deletion = (id: string): RecordDeletion => {
        const row = byId.get(id);
        return {
            at: (row?.deletedAt ?? new Date()).toISOString(),
            reason: (row?.deletedReason ?? null) as DeleteReason | null,
            note: row?.deletedNote ?? null,
            byMemberId: row?.deletedByMemberId ?? null,
        };
    };
    return { ...page, items: page.items.map((item) => ({ ...item, deletion: deletion(item.id) })) };
}
