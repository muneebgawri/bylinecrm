import { UnprocessableEntityException } from '@nestjs/common';
import { isSystemSender } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * Who is not a contact (#383), in one place: a workspace member (their sign-in address), a connected mailbox (a
 * member's own, a pool's or a service inbox's), anyone at the workspace's own domains (the Google Workspace domains
 * its delegation syncs: former colleagues, aliases, groups — 2026-11: 47 such records, one with 8.9k mail rows, were
 * the last "people" whose contact status took seconds to re-derive), or an automated sender (`isSystemSender`:
 * mailer-daemon, postmaster, no-reply, notifications…). A person record with such a primary address is refused on
 * create and on edit, and `retire-non-contacts` retires the ones that got in before the rule — so mail between
 * colleagues, and bounces and notifications, is never "mail about a contact", and no colleague shows in People as an
 * engaged lead.
 */

/** The workspace's own people and places, lower case. */
export interface Staff {
    /** Every member's sign-in address and every connected mailbox's. */
    addresses: ReadonlySet<string>;
    /** The workspace's own mail domains: those its Google Workspace delegation lists (none without one). */
    domains: ReadonlySet<string>;
}

export async function staffOf(tx: WorkspaceClient): Promise<Staff> {
    const [members, mailboxes, delegation] = await Promise.all([
        tx.$queryRaw<{ email: string }[]>`
            SELECT u.email FROM workspace_members m JOIN users u ON u.id = m.user_id`,
        tx.mailbox.findMany({ select: { email: true } }),
        tx.googleWorkspaceDelegation.findFirst({ select: { allowedDomains: true } }),
    ]);
    return {
        addresses: new Set([...members, ...mailboxes].map((r) => r.email.toLowerCase())),
        domains: new Set((delegation?.allowedDomains ?? []).map((d) => d.toLowerCase())),
    };
}

/** Why an address is not a contact's, or `null` when it may be one. */
export function notAContactReason(address: string, staff: Staff): string | null {
    const normalised = address.trim().toLowerCase();
    if (staff.addresses.has(normalised)) return "a workspace member's or mailbox's address, not a contact's";
    const domain = normalised.slice(normalised.lastIndexOf('@') + 1);
    if (normalised.includes('@') && staff.domains.has(domain)) {
        return "an address at the workspace's own domain, not a contact's";
    }
    if (isSystemSender(normalised)) return "an automated sender's address (bounces, notifications), not a contact's";
    return null;
}

/** Whether the address is the workspace's own (a member's, a mailbox's, or at its domain) rather than automated. */
export function isStaffAddress(address: string, staff: Staff): boolean {
    const normalised = address.trim().toLowerCase();
    return (
        staff.addresses.has(normalised) ||
        (normalised.includes('@') && staff.domains.has(normalised.slice(normalised.lastIndexOf('@') + 1)))
    );
}

/** Refuses (422) a primary address that is not a contact's; nothing to check when there is no address. */
export async function assertContactAddress(tx: WorkspaceClient, address: string | null | undefined): Promise<void> {
    if (!address) return;
    const reason = notAContactReason(address, await staffOf(tx));
    if (reason) throw new UnprocessableEntityException(`${address} is ${reason}`);
}
