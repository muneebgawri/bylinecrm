import { companyDomain } from '../records/company-domain';

/** Who a Bigin Contact held, as Bigin had it: its full name and primary email. */
export interface ContactIdentity {
    name: string;
    email: string | null;
}

const normalEmail = (email: string | null | undefined): string => (email ?? '').trim().toLowerCase();
const normalName = (name: string | null | undefined): string => (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const domainOfEmail = (email: string): string | null => {
    const at = email.lastIndexOf('@');
    if (at === -1) return null;
    const host = email.slice(at + 1);
    return companyDomain(host) ?? host;
};

/**
 * Whether a linked Bigin Contact now holds a different person (BIGIN-1). Bigin caps contacts, so people edit
 * an existing Contact into someone else: one Bigin id, several real people over time. The sync must never
 * overwrite one person with another.
 *
 * - The same person: the primary email is unchanged (case and whitespace aside), or there was none before,
 *   or there is none now (an address removed is an edit, not someone else).
 * - Reused: the primary email changed to another address AND either the name changed or the address's
 *   registrable domain did (a person moving from `dana@acme.com` to `dana@acme.co.uk` keeps their name and
 *   is still the same person; `dana@acme.com` → `lee@acme.com` with a new name is not).
 */
export function isContactReused(before: ContactIdentity, after: ContactIdentity): boolean {
    const was = normalEmail(before.email);
    const now = normalEmail(after.email);
    if (was === '' || now === '' || was === now) return false;
    const renamed = normalName(before.name) !== normalName(after.name);
    const moved = domainOfEmail(was) !== domainOfEmail(now);
    return renamed || moved;
}

/** The note left on the earlier person when their Bigin Contact is reused. */
export function reuseNoteText(at: Date): string {
    return `This Bigin contact was reused for another person on ${at.toISOString().slice(0, 10)}`;
}
