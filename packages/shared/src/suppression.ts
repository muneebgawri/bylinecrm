/**
 * The suppression list (P3-1, FR-CRMS-7): addresses the workspace never mails. One per workspace;
 * every send and every enrolment checks it.
 */

/**
 * Why an address is on the list. `unsubscribe` and `complaint` are the person's own choice and are
 * never lifted from inside the CRM; a `hard_bounce` (an address can be fixed) or a `manual` entry can
 * be lifted by an admin, with a note.
 */
export const SUPPRESSION_REASONS = ['unsubscribe', 'hard_bounce', 'complaint', 'manual'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Reasons only the person can undo. */
export const PERMANENT_SUPPRESSION_REASONS: readonly SuppressionReason[] = ['unsubscribe', 'complaint'];

export function isLiftable(reason: SuppressionReason): boolean {
    return !PERMANENT_SUPPRESSION_REASONS.includes(reason);
}

/** What put it there: the person (the unsubscribe link), a member, or a provider's bounce or complaint report (P3-2). */
export const SUPPRESSION_SOURCES = ['recipient', 'member', 'provider'] as const;
export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number];

/** The reason in words, as a refused send and the settings page say it. */
export const SUPPRESSION_REASON_LABELS: Readonly<Record<SuppressionReason, string>> = {
    unsubscribe: 'unsubscribed',
    hard_bounce: 'hard bounce',
    complaint: 'spam complaint',
    manual: 'suppressed by a member',
};

/** RFC 5321's limit on an address's length. */
export const SUPPRESSION_ADDRESS_MAX = 254;
export const SUPPRESSION_NOTE_MAX = 500;

const ADDRESS = /^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** The stored form of an address — trimmed, lower case — or `null` when it is not an address. */
export function normaliseSuppressionAddress(raw: string): string | null {
    const value = raw.trim().toLowerCase();
    if (value.length === 0 || value.length > SUPPRESSION_ADDRESS_MAX) return null;
    return ADDRESS.test(value) ? value : null;
}

/** Where a recipient's mail client and the visible link reach the CRM, under the API and the web app. */
export const UNSUBSCRIBE_API_PATH = '/api/unsubscribe';
export const UNSUBSCRIBE_PAGE_PATH = '/unsubscribe';

/** What `suppression.added` / `suppression.removed` carry. */
export interface SuppressionEventPayload {
    address: string;
    reason: SuppressionReason;
    source: SuppressionSource;
    personId: string | null;
}
