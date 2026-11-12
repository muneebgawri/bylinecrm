import { UnprocessableEntityException } from '@nestjs/common';
import { isSystemSender } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * Who is not a contact (#383), in one place: a workspace member (their sign-in address), a connected mailbox (a
 * member's own, a pool's or a service inbox's), or an automated sender (`isSystemSender`: mailer-daemon, postmaster,
 * no-reply, notifications…). A person record with such a primary address is refused on create and on edit, and
 * `retire-non-contacts` retires the ones that got in before the rule — so mail between colleagues, and bounces and
 * notifications, is never "mail about a contact", and no colleague shows in People as an engaged lead.
 */

/** The workspace's own addresses, lower case: every member's sign-in address and every connected mailbox's. */
export async function staffAddresses(tx: WorkspaceClient): Promise<Set<string>> {
    const [members, mailboxes] = await Promise.all([
        tx.$queryRaw<{ email: string }[]>`
            SELECT u.email FROM workspace_members m JOIN users u ON u.id = m.user_id`,
        tx.mailbox.findMany({ select: { email: true } }),
    ]);
    return new Set([...members, ...mailboxes].map((r) => r.email.toLowerCase()));
}

/** Why an address is not a contact's, or `null` when it may be one. */
export function notAContactReason(address: string, staff: ReadonlySet<string>): string | null {
    const normalised = address.trim().toLowerCase();
    if (staff.has(normalised)) return "a workspace member's or mailbox's address, not a contact's";
    if (isSystemSender(normalised)) return "an automated sender's address (bounces, notifications), not a contact's";
    return null;
}

/** Refuses (422) a primary address that is not a contact's; nothing to check when there is no address. */
export async function assertContactAddress(tx: WorkspaceClient, address: string | null | undefined): Promise<void> {
    if (!address) return;
    const reason = notAContactReason(address, await staffAddresses(tx));
    if (reason) throw new UnprocessableEntityException(`${address} is ${reason}`);
}
