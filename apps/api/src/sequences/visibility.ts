import type { Prisma } from '@prisma/client';
import { callerMemberId } from '../infra/caller-member';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';

/**
 * Who sees a sequence (#192), in one place: every member-facing path that reaches a sequence — the
 * list, opening it, changing it, its enrolments, enrolling into it — reads it through
 * `sequenceVisibleWhere`. An admin sees every one; anyone else sees the shared ones and their own.
 * The runner and the sweep (no member) are not callers of this: a private sequence runs as any other.
 */

/** Whether the caller may change who sees a sequence: its owner, or an admin. */
export function mayChangeVisibility(
    context: WorkspaceRunContext,
    caller: string | null,
    sequence: { ownerMemberId: string | null },
): boolean {
    return context.capabilities.has('workspace:admin') || (caller !== null && caller === sequence.ownerMemberId);
}

/** The sequences the caller may see: every one for an admin; otherwise the shared ones and their own. */
export async function sequenceVisibleWhere(
    tx: WorkspaceClient,
    context: WorkspaceRunContext,
): Promise<Prisma.SequenceWhereInput> {
    if (context.capabilities.has('workspace:admin')) return {};
    const me = await callerMemberId(tx, context);
    return me ? { OR: [{ visibility: 'shared' }, { ownerMemberId: me }] } : { visibility: 'shared' };
}
