import type { GuardrailSettingsView } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * Settings → Guardrails (GUARD-2), as the guard and the detector read them: whether a `high` poaching alert is
 * emailed at once, and the members that are shared mailboxes. No row means the defaults (off, none).
 */
export async function guardrailSettings(tx: WorkspaceClient): Promise<GuardrailSettingsView> {
    const row = await tx.guardrailSettings.findFirst({
        select: { poachEmailAtOnce: true, sharedMailboxMemberIds: true },
    });
    return {
        poachEmailAtOnce: row?.poachEmailAtOnce ?? false,
        sharedMailboxMemberIds: row?.sharedMailboxMemberIds ?? [],
    };
}

/**
 * An owner as GUARD-1 and GUARD-2 see it: a shared mailbox (outreach@, which owns the leads many people work) is
 * nobody — a lead it owns may be mailed by any member. The record's owner is not changed.
 */
export function effectiveOwner(ownerId: string | null, shared: ReadonlySet<string>): string | null {
    return ownerId !== null && shared.has(ownerId) ? null : ownerId;
}
