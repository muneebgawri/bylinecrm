import { blocklistCovers, type MailboxPurpose } from '@bylinecrm/shared';

/**
 * The blocklist rule, in one place: the importer passes a message over with it, and a new entry
 * purges stored mail with it (P2-2).
 *
 * Which entries apply to a mailbox: the workspace's (no member) always; a member's personal entries
 * only to that member's **personal** mailboxes — a pool mailbox is the workspace's outreach, and a
 * service inbox (SVC-1) a shared address, not anyone's own inbox.
 */
export interface BlocklistEntryLike {
    value: string;
    memberId: string | null;
}

export interface MailboxLike {
    email: string;
    ownerMemberId: string;
    purpose: MailboxPurpose;
}

export function entriesFor(mailbox: MailboxLike, entries: readonly BlocklistEntryLike[]): string[] {
    return entries
        .filter((e) => e.memberId === null || (mailbox.purpose === 'personal' && e.memberId === mailbox.ownerMemberId))
        .map((e) => e.value);
}

/**
 * Whether every outside participant (any address other than the mailbox's own) is covered by one
 * of `values`. A message with no outside participant is never "blocked": it is the mailbox's own.
 */
export function everyOutsideBlocked(
    mailboxEmail: string,
    addresses: readonly string[],
    values: readonly string[],
): boolean {
    const outside = [...new Set(addresses)].filter((a) => a !== mailboxEmail);
    return outside.length > 0 && outside.every((a) => values.some((entry) => blocklistCovers(entry, a)));
}
