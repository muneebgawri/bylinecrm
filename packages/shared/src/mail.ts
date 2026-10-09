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
