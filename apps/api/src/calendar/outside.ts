import { blocklistCovers } from '@bylinecrm/shared';
import { isFreeMailDomain } from '../enrichment/email-domain';
import { CALENDAR_NON_PERSON_DOMAIN } from './calendar.constants';
import type { ParsedAttendee } from './parse-event';

/**
 * Who on a meeting is outside the workspace (CAL-1) — the people a meeting is *with*, who make it count
 * and who become leads. One rule, in one place. An attendee is inside, and passed over, when they are:
 *
 * - the calendar's owner, or a room or equipment, or one of Google's own group and resource calendars;
 * - a member of the workspace (their sign-in address) or one of its connected mailboxes;
 * - at one of the workspace's own work domains — any domain its members sign in with or its mailboxes
 *   are at (`insideDomains`): a colleague who is not a member yet is still a colleague. A free-mail
 *   domain such as gmail.com says nothing about who is a colleague, so it is never one of them;
 * - covered by the blocklist that applies to the owner's mail (`entriesFor`): an address or a domain a
 *   member keeps out of the CRM is kept out of meetings too.
 */
export function outsideAttendees(input: {
    ownerAddress: string;
    attendees: readonly ParsedAttendee[];
    /** Members' sign-in addresses and the workspace's mailboxes, lower case. */
    insiders: ReadonlySet<string>;
    blocklist: readonly string[];
}): ParsedAttendee[] {
    const insideDomains = workDomains(input.insiders);
    return input.attendees.filter((attendee) => {
        if (attendee.self || attendee.resource || attendee.address === input.ownerAddress) return false;
        const domain = domainOf(attendee.address);
        if (!domain || CALENDAR_NON_PERSON_DOMAIN.test(domain)) return false;
        if (input.insiders.has(attendee.address)) return false;
        if (insideDomains.has(domain)) return false;
        return !input.blocklist.some((entry) => blocklistCovers(entry, attendee.address));
    });
}

/**
 * A new person's name from what the invitation shows: the display name split at its last space (a single
 * word is a first name); none when the invitation shows only the address, or shows the address as the name.
 */
export function nameFromDisplay(displayName: string, address: string): { nameFirst: string; nameLast: string } {
    const name = displayName.replace(/\s+/g, ' ').trim();
    if (!name || name.toLowerCase() === address || name.includes('@')) return { nameFirst: '', nameLast: '' };
    const space = name.lastIndexOf(' ');
    return space > 0
        ? { nameFirst: name.slice(0, space), nameLast: name.slice(space + 1) }
        : { nameFirst: name, nameLast: '' };
}

/** The work domains of a set of addresses: their domains, free mail left out. */
export function workDomains(addresses: Iterable<string>): Set<string> {
    const domains = new Set<string>();
    for (const address of addresses) {
        const domain = domainOf(address);
        if (domain && !isFreeMailDomain(domain)) domains.add(domain);
    }
    return domains;
}

export function domainOf(address: string): string | null {
    const at = address.lastIndexOf('@');
    const domain = at > 0 ? address.slice(at + 1).toLowerCase() : '';
    return domain.includes('.') ? domain : null;
}
