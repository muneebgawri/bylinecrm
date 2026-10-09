/**
 * Every number and fixed string mail accounts (P2-1) run on, in one place. A value here is a
 * decision; the code that uses it says what it is for, never repeats it.
 */

/** Where Google sends the browser back after consent; the redirect URI is `APP_URL` + this. */
export const MAIL_OAUTH_CALLBACK_PATH = '/api/mail/oauth/callback';

/** How long a connect request (state, PKCE verifier, who and what for) stays valid. */
export const CONNECT_STATE_TTL_S = 10 * 60;
/** Redis key prefix for a pending connect request; read and deleted in one step, so a state is used once. */
export const CONNECT_STATE_KEY_PREFIX = 'mailbox-connect:';
/** Random bytes in a connect state and in a PKCE verifier (RFC 7636 asks for 32 or more). */
export const CONNECT_RANDOM_BYTES = 32;

/** An access token this close to expiry is refreshed before use rather than handed out. */
export const TOKEN_REFRESH_SKEW_S = 120;
/** Redis key prefix for the per-mailbox refresh lock. */
export const TOKEN_LOCK_KEY_PREFIX = 'mailbox-token-lock:';
/**
 * How long one process may hold a mailbox's refresh lock — longer than a token request can take
 * (`GOOGLE_HTTP_TIMEOUT_MS`), so a lock is never lost mid-refresh, and short enough that a
 * crashed holder blocks the mailbox only briefly. A waiter gives up after the same time.
 */
export const TOKEN_LOCK_TTL_MS = 15_000;
/** How often a waiter re-reads the mailbox while another process refreshes it. */
export const TOKEN_LOCK_POLL_MS = 100;

/** Google's endpoints. The HTTP adapter is the only code that calls them. */
export const GOOGLE_ENDPOINTS = {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    revoke: 'https://oauth2.googleapis.com/revoke',
    tokenInfo: 'https://oauth2.googleapis.com/tokeninfo',
    gmailProfile: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
} as const;

/** One Google request may take this long before it is abandoned. */
export const GOOGLE_HTTP_TIMEOUT_MS = 10_000;

/**
 * The shape of a Google OAuth client ID for a web application: a project number, a hyphen, an
 * identifier, and Google's domain. Checked before anything is sent to Google.
 */
export const GOOGLE_CLIENT_ID_PATTERN = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
/** Generous bounds for what a person pastes; Google's secrets are far shorter. */
export const GOOGLE_CLIENT_ID_MAX = 200;
export const GOOGLE_CLIENT_SECRET_MAX = 200;
/** How many trailing characters of the client secret the API shows. */
export const CLIENT_SECRET_SHOWN_CHARS = 4;

/** A mailbox's display label. */
export const MAILBOX_LABEL_MAX = 80;

/**
 * The authorization code sent when checking a client without a person present. It is not a
 * code Google issued, so the exchange always fails; *how* it fails says whether Google knows the
 * client and accepts its secret (see `GoogleOAuthPort.probeClient`).
 */
export const PROBE_AUTHORIZATION_CODE = 'bylinecrm-client-check';
