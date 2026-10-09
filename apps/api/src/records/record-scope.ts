import { ForbiddenException } from '@nestjs/common';
import type { WorkspaceRunContext } from '../infra/workspace-context';

/**
 * The filter an own-scoped caller's reads carry, mirrored by the restrictive `owner_scope`
 * policy underneath. Empty for a caller whose role reaches every owner.
 */
export function ownerWhere(context: WorkspaceRunContext): { ownerId?: string } {
    return context.ownerScopeMemberId ? { ownerId: context.ownerScopeMemberId } : {};
}

/**
 * The records a caller can act on in one state: live (`deleted` false) or in the trash, within
 * their owner scope. The base every record read starts from — a list, a single record, a bulk
 * action's check of which named ids it may touch.
 */
export function recordWhere(
    context: WorkspaceRunContext,
    deleted: boolean,
): { deletedAt: null | { not: null }; ownerId?: string } {
    return { deletedAt: deleted ? { not: null } : null, ...ownerWhere(context) };
}

/**
 * Which owner a write may record.
 *
 * `requested` is what the caller asked for: `undefined` when they said nothing, `null` to clear.
 * `current` is the record's owner before the write, or `undefined` when the record is being
 * created. An own-scoped caller owns what they write, always — asking for anyone else is refused
 * (`403`: it is their own record, so nothing is leaked by saying so). Anyone else gets what they
 * asked for, defaulting to themselves on create and to the current owner on patch.
 */
export function resolveOwner(
    context: WorkspaceRunContext,
    requested: string | null | undefined,
    current: string | null | undefined,
): string | null {
    if (context.ownerScopeMemberId) {
        if (requested !== undefined && requested !== context.ownerScopeMemberId) {
            throw new ForbiddenException('your role keeps its own records: the owner must be yourself');
        }
        return context.ownerScopeMemberId;
    }
    if (requested !== undefined) return requested;
    return current === undefined ? (context.memberId ?? null) : current;
}
