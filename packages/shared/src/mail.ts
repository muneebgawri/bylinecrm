/**
 * Mail accounts (P2-1): the Google mailboxes a workspace connects through its own OAuth client
 * (doc 48 FR-CRMS-1, D-237). One vocabulary for the API, the web app and the tests.
 */

/** Send mail as the mailbox. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** Read mail and the mailbox's profile; sync (P2-2) and reply detection (P2-3) need it. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/**
 * Exactly what the service asks Google for — the two narrow scopes (doc 48 §6.1). The setup screen
 * shows this list, the authorization request sends it, and a callback is accepted only if both
 * were granted. One definition.
 */
export const GMAIL_SCOPES = [GMAIL_SEND_SCOPE, GMAIL_READONLY_SCOPE] as const;

/**
 * Full mailbox access — read, write, delete and settings. The service never asks for it, and a
 * connection whose grant includes it is refused: holding it is a liability the product does not
 * need, and it is the scope Google's reviewers object to hardest.
 */
export const GMAIL_BROAD_SCOPE = 'https://mail.google.com/';

/** What a mailbox is for. Fixed when it connects; changing it means disconnecting and connecting again. */
export const MAILBOX_PURPOSES = ['personal', 'pool'] as const;
export type MailboxPurpose = (typeof MAILBOX_PURPOSES)[number];

/**
 * Where a mailbox stands. `reconnect_needed`: Google refused the stored grant (revoked, expired,
 * a scope withdrawn) — sync and sending stop until the owner connects it again. `disconnected`:
 * someone disconnected it; its tokens are gone.
 */
export const MAILBOX_STATUSES = ['connected', 'reconnect_needed', 'disconnected'] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

/**
 * How a connect attempt ended, as the callback reports it to the web app in `?connect=`. The
 * callback never puts a token or a Google error text in a URL — only one of these.
 */
export const MAILBOX_CONNECT_RESULTS = [
    /** The mailbox is connected (or reconnected). */
    'connected',
    /** The person declined on Google's consent screen. */
    'denied',
    /** The request was unknown, expired or already used. */
    'invalid_state',
    /** Signed in as someone other than the person who started the connect, or not signed in. */
    'wrong_user',
    /** The person who started the connect may no longer connect mailboxes in that workspace. */
    'not_permitted',
    /** The workspace has no OAuth client configured (it was removed mid-flow). */
    'no_client',
    /** Google granted full mailbox access; the service refuses to hold it. */
    'scope_too_broad',
    /** Google did not grant one of the two scopes the service needs. */
    'scope_missing',
    /** Google returned no refresh token, so the connection could not be kept. */
    'no_refresh_token',
    /** The mailbox is connected in this workspace by another member. */
    'owned_by_another',
    /** The mailbox is connected with the other purpose; disconnect it first. */
    'purpose_mismatch',
    /** Google refused the code exchange or the profile read. */
    'exchange_failed',
] as const;
export type MailboxConnectResult = (typeof MAILBOX_CONNECT_RESULTS)[number];

/** The query parameter the callback's redirect carries the result in. */
export const MAILBOX_CONNECT_RESULT_PARAM = 'connect';

/** One step of the OAuth-client check the setup screen shows (doc 50 §E). */
export const OAUTH_CHECK_OUTCOMES = ['pass', 'fail', 'unverified'] as const;
export type OAuthCheckOutcome = (typeof OAUTH_CHECK_OUTCOMES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Sync (P2-2): mail a connected mailbox holds, on the records it concerns (FR-CRMS-2).
// ─────────────────────────────────────────────────────────────────────────────

/** A message the mailbox received, or one it sent (from its own address, or labelled SENT). */
export const MAIL_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MailDirection = (typeof MAIL_DIRECTIONS)[number];

/** Where an address appears on a message. */
export const MAIL_PARTICIPANT_ROLES = ['from', 'to', 'cc', 'bcc'] as const;
export type MailParticipantRole = (typeof MAIL_PARTICIPANT_ROLES)[number];

/**
 * Where a mailbox's sync stands. `syncing` while a run is in progress; `failed` when the last run
 * stopped — its reason is kept, and the next scheduled run tries again.
 */
export const MAIL_SYNC_STATUSES = ['idle', 'syncing', 'failed'] as const;
export type MailSyncStatus = (typeof MAIL_SYNC_STATUSES)[number];

/**
 * What an `email.received` / `email.sent` event carries about the message, beside the records it
 * is on (`targets`): enough for the timeline to show it (subject, snippet, direction) and for reply
 * detection (P2-3) to recognise a reply (the RFC 5322 ids). Never the body.
 */
export type EmailSummary = {
    /** The CRM's message id (`recordId` of the event). */
    messageId: string;
    threadId: string;
    mailboxId: string;
    direction: MailDirection;
    subject: string;
    snippet: string;
    /** The sender's address, lower case. */
    from: string;
    /** ISO 8601, UTC. */
    sentAt: string;
    /** The `Message-ID` header, when the message had one. */
    rfc822MessageId: string | null;
    /** The `In-Reply-To` header. */
    inReplyTo: string | null;
    /** The `References` header's ids, oldest first. */
    references: string[];
};

/**
 * A blocklist entry is a full address (`someone@example.com`) or a whole domain (`@example.com`),
 * lower case. A message whose every outside participant is blocklisted is not imported.
 */
export const BLOCKLIST_SCOPES = ['personal', 'workspace'] as const;
export type BlocklistScope = (typeof BLOCKLIST_SCOPES)[number];

const BLOCKLIST_ADDRESS = /^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const BLOCKLIST_DOMAIN = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export const BLOCKLIST_VALUE_MAX = 254;

/** The stored form of a blocklist value, or `null` when it is neither an address nor `@domain`. */
export function normaliseBlocklistValue(raw: string): string | null {
    const value = raw.trim().toLowerCase();
    if (value.length === 0 || value.length > BLOCKLIST_VALUE_MAX) return null;
    return BLOCKLIST_ADDRESS.test(value) || BLOCKLIST_DOMAIN.test(value) ? value : null;
}

/** Whether a (lower-case) address is covered by an entry: the same address, or its domain. */
export function blocklistCovers(entry: string, address: string): boolean {
    return entry.startsWith('@') ? address.endsWith(entry) : address === entry;
}
