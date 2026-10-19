/** Who a Bigin Contact held, as Bigin had it: its full name and primary email. */
export interface ContactIdentity {
    name: string;
    email: string | null;
}

const normalEmail = (email: string | null | undefined): string => (email ?? '').trim().toLowerCase();
const normalName = (name: string | null | undefined): string => (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Whether a linked Bigin Contact now holds a different person (BIGIN-1). Bigin caps contacts, so people edit
 * an existing Contact into someone else: one Bigin id, several real people over time. The sync must never
 * overwrite one person with another.
 *
 * - The same person: the primary email is unchanged (case and whitespace aside), or there was none before,
 *   or there is none now (an address removed is an edit, not someone else).
 * - Reused: the primary email changed to another address AND the name changed. A new address alone — even
 *   at another domain (`jane@gmail.com` → `jane@acme.com`, a job change) — is the same person moving, never
 *   someone else: splitting her would strand her history on a record she no longer holds (audit, #217).
 */
export function isContactReused(before: ContactIdentity, after: ContactIdentity): boolean {
    const was = normalEmail(before.email);
    const now = normalEmail(after.email);
    if (was === '' || now === '' || was === now) return false;
    return normalName(before.name) !== normalName(after.name);
}

/** The note left on the earlier person when their Bigin Contact is reused. */
export function reuseNoteText(at: Date): string {
    return `This Bigin contact was reused for another person on ${at.toISOString().slice(0, 10)}`;
}
