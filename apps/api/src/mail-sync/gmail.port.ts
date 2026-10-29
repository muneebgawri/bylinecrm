import { GMAIL_RATE_LIMIT_REASONS } from './mail-sync.constants';
/**
 * Everything mail sync (P2-2) and sending (P2-3) ask Gmail, behind one interface. The HTTP adapter
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

/** Some headers of one message (`format=metadata`): enough to recognise it without fetching it whole. */
export interface GmailMessageHeaders {
    id: string;
    threadId: string;
    headers: GmailHeader[];
}

/** What Gmail returns for a sent message: its id, and the thread it went into. */
export interface GmailSent {
    id: string;
    threadId: string;
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
        /** Google's own words (`error.message`) — which limit, and often until when. Never holds a token. (PNW-1125) */
        readonly googleMessage: string | null = null,
        /** When Gmail says the request may be made again — its Retry-After header, or "Retry after <time>". */
        readonly retryAfter: Date | null = null,
    ) {
        super(message);
        this.name = 'GmailApiError';
    }

    /** Gmail's per-user rate limit, which it answers with a 403 rather than a 429. */
    get rateLimited(): boolean {
        return this.status === 429 || (this.status === 403 && GMAIL_RATE_LIMIT_REASONS.has(this.reason));
    }

    /** Worth retrying the same request after a wait: throttled (a 429, or Gmail's 403 rate limits), a server error, or no answer. */
    get transient(): boolean {
        return this.status === null || this.rateLimited || (this.status !== null && this.status >= 500);
    }
}

/** One of a mailbox's send-as addresses (`users.settings.sendAs`), with the signature Gmail holds for it (HTML). */
export interface GmailSendAs {
    sendAsEmail: string;
    isPrimary: boolean;
    signature: string;
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

    /** Only the named headers of one message (`format=metadata`, `metadataHeaders`). */
    getMessageHeaders(accessToken: string, id: string, names: readonly string[]): Promise<GmailMessageHeaders>;

    /**
     * Sends a raw RFC 5322 message as the mailbox (P2-3), in `threadId` when it is a reply. The
     * outcome of a `5xx` or of no answer is unknown — Gmail may have the message — so a caller that
     * retries looks for it first: by our `X-BylineCRM-Id` header among the mailbox's sent messages.
     * Gmail replaces the Message-ID a sender sets, so that cannot be searched for.
     */
    send(accessToken: string, input: { raw: string; threadId?: string }): Promise<GmailSent>;

    /**
     * The mailbox's send-as addresses and their signatures (#193), for importing a signature. Google lists
     * `gmail.readonly` among the scopes `users.settings.sendAs.list` accepts, which every mailbox holds.
     */
    listSendAs(accessToken: string): Promise<GmailSendAs[]>;
}

/** Injection token for the port. */
export const GMAIL_PORT = Symbol('GMAIL_PORT');
