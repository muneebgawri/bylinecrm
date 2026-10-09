/**
 * Everything mail sync (P2-2) asks Gmail, behind one interface. The HTTP adapter
 * (`gmail.http.ts`) is the only code that calls Gmail; tests bind an in-memory fake
 * (`test/support/fake-gmail.ts`), so no test and no CI run ever reaches Google.
 *
 * The shapes are Gmail's own (users.messages / users.history), trimmed to what sync reads, so
 * `parse-message.ts` turns exactly what Gmail returns into a message — one parser for the adapter
 * and the fake alike.
 */

export interface GmailProfile {
    emailAddress: string;
    /** The mailbox's current history id: where an incremental sync starts. */
    historyId: string;
}

export interface GmailMessageRef {
    id: string;
    threadId: string;
}

export interface GmailMessagePage {
    messages: GmailMessageRef[];
    nextPageToken: string | null;
}

export interface GmailHistoryPage {
    /** Ids of messages added since the start id, in the order Gmail reported them. */
    addedMessageIds: string[];
    /** The history id this page brings the mailbox to. */
    historyId: string;
    nextPageToken: string | null;
}

export interface GmailHeader {
    name: string;
    value: string;
}

/** One MIME part as Gmail returns it (`format=full`); `body.data` is base64url. */
export interface GmailPart {
    mimeType: string;
    filename?: string;
    headers?: GmailHeader[];
    body?: { data?: string; size?: number; attachmentId?: string };
    parts?: GmailPart[];
}

export interface GmailRawMessage {
    id: string;
    threadId: string;
    labelIds?: string[];
    /** Gmail's preview, HTML-entity encoded. */
    snippet?: string;
    /** Milliseconds since the epoch, as a string: when Gmail received the message. */
    internalDate?: string;
    payload: GmailPart;
}

/**
 * Gmail answered with an error or failed to answer. `status` is the HTTP status (`null` for a
 * network failure or a timeout); `reason` is Gmail's (`rateLimitExceeded`, `notFound`, …) or the
 * adapter's own (`network`, `timeout`, `unexpected_response`). The message never holds a token.
 */
export class GmailApiError extends Error {
    constructor(
        readonly status: number | null,
        readonly reason: string,
        message: string,
    ) {
        super(message);
        this.name = 'GmailApiError';
    }

    /** Worth retrying the same request after a wait: throttled, a server error, or no answer. */
    get transient(): boolean {
        return this.status === null || this.status === 429 || this.status >= 500;
    }
}

export interface GmailPort {
    getProfile(accessToken: string): Promise<GmailProfile>;

    /** Message ids matching a Gmail search `query` (e.g. `after:1760000000`), newest first. */
    listMessages(accessToken: string, input: { query: string; pageToken?: string }): Promise<GmailMessagePage>;

    /**
     * Messages added since `startHistoryId`. A start id Gmail no longer keeps history for answers
     * `404` (`GmailApiError` with status 404): the caller re-lists instead.
     */
    listHistory(accessToken: string, input: { startHistoryId: string; pageToken?: string }): Promise<GmailHistoryPage>;

    /** One message in full: headers, MIME parts, labels. */
    getMessage(accessToken: string, id: string): Promise<GmailRawMessage>;
}

/** Injection token for the port. */
export const GMAIL_PORT = Symbol('GMAIL_PORT');
