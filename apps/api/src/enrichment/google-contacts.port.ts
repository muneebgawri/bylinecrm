/**
 * What the Google Contacts source (AVATAR-1) asks Google's People API, behind one interface. The HTTP
 * adapter (`google-contacts.http.ts`) is the only code that calls it; tests bind a fake, so no test
 * reaches Google.
 */

/** Which of a member's contact lists to search: the ones they saved, or Gmail's "other contacts". */
export type ContactList = 'contacts' | 'other';

/** One match as Google returns it, trimmed to what the source reads. */
export interface GoogleContactMatch {
    emails: string[];
    /** The contact's pictures; `default` marks Google's generated letter, never a real picture. */
    photos: { url: string; default: boolean; primary: boolean }[];
}

/**
 * Google answered with an error or not at all. `status` is the HTTP status (`null` for a network failure
 * or a timeout); `reason` is Google's (`PERMISSION_DENIED`, `SERVICE_DISABLED`, …) or the adapter's own.
 * The message never holds a token.
 */
export class GoogleContactsError extends Error {
    constructor(
        readonly status: number | null,
        readonly reason: string,
        message: string,
    ) {
        super(message);
        this.name = 'GoogleContactsError';
    }

    /**
     * This mailbox cannot be asked, and asking again will not change that: the grant lacks the scope, or
     * the workspace's Google Cloud project has not turned the People API on (an admin's setup step).
     */
    get notAllowed(): boolean {
        return (
            this.status === 401 || (this.status === 403 && !/rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(this.reason))
        );
    }
}

export interface GoogleContactsPort {
    /**
     * The contacts in one list matching `query` (an address). An empty query is Google's "warm-up": the
     * search reads a cache that only a warm-up request fills, so one is sent before the first search.
     */
    search(accessToken: string, list: ContactList, query: string): Promise<GoogleContactMatch[]>;
}

/** Injection token for the port. */
export const GOOGLE_CONTACTS_PORT = Symbol('GOOGLE_CONTACTS_PORT');
