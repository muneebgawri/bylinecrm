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
 * Mail the CRM sends (P2-3, P2-5) and where it stands. `scheduled`: accepted for a later time
 * (`sendAt`); it is built and checked again when that time comes. `queued`: accepted, waiting for
 * the send job; `sending`: an attempt has started (Gmail may or may not have it — the next attempt
 * checks first); `sent`: Gmail accepted it; `failed`: it will not be sent (a check failed at send
 * time, the mailbox stopped working, Gmail refused it, or the queue's attempts ran out);
 * `cancelled`: its sender or an admin called a scheduled send off. A message is sent from its
 * sender's own personal mailbox.
 */
export const MAIL_OUTBOUND_STATUSES = ['scheduled', 'queued', 'sending', 'sent', 'failed', 'cancelled'] as const;
export type MailOutboundStatus = (typeof MAIL_OUTBOUND_STATUSES)[number];

/** At most this many recipients (to, cc and bcc together) on one message. */
export const MAIL_SEND_RECIPIENTS_MAX = 50;

/**
 * A scheduled send (P2-5, FR-CRMS-4) is for at least this long from now — less is a send now — and
 * at most `MAIL_SEND_HORIZON_DAYS` ahead. The web app's time picker reads the same numbers.
 */
export const MAIL_SEND_MIN_LEAD_SECONDS = 60;
export const MAIL_SEND_HORIZON_DAYS = 90;

/**
 * What `email.replied` says about the reply (P2-3): the inbound message, the CRM message it answers,
 * its thread, the people who wrote it and the deals it concerns. The stage rules read `related`;
 * this is for webhooks and the timeline's readers.
 */
export type EmailReply = {
    /** The reply: the CRM's id of the inbound message (`recordId` of the event). */
    messageId: string;
    /** The CRM's send it answers (`GET /mail/messages/:id`). */
    inReplyToOutboundId: string;
    /** The stored copy of that send, as sync's writer made it; `null` only in the moment before it is stored. */
    inReplyToMessageId: string | null;
    /** The CRM thread the reply is in. */
    threadId: string;
    /** People the reply is from. */
    personIds: string[];
    /** Open deals those people are the point of contact for, and the deal the sent message was about. */
    dealIds: string[];
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
