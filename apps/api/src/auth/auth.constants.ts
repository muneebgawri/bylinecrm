/**
 * Every number the auth layer runs on, in one place. A value here is a decision; the code that
 * uses it says what it is for, never repeats it.
 */

/** argon2id, OWASP's 2023 minimum (19 MiB, 2 passes, 1 lane). */
export const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** A session lasts this long from its last activity (sliding). */
export const SESSION_TTL_S = 30 * 24 * 60 * 60;
/** `last_seen_at` is written at most this often, so a busy user is not a write per request. */
export const SESSION_TOUCH_INTERVAL_S = 5 * 60;
/** Random bytes in a session token, an API-key secret and an invite token. */
export const TOKEN_BYTES = 32;

/** Failed logins allowed per email+IP in the window before `429`. */
export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_S = 15 * 60;

/** How long an OIDC authorization request (state, nonce, PKCE verifier) stays valid. */
export const OIDC_STATE_TTL_S = 10 * 60;

/** An invitation expires after this. */
export const INVITE_TTL_S = 7 * 24 * 60 * 60;

/** `last_used_at` on an API key is written at most this often. */
export const API_KEY_TOUCH_INTERVAL_S = 5 * 60;

/** Password policy: length only; composition rules are not a security control. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Workspace slug: lower-case words joined by hyphens plus a short random suffix. */
export const SLUG_SUFFIX_BYTES = 3;
