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

/** A mailed email-verification link expires after this (#93). */
export const EMAIL_VERIFICATION_TTL_S = 24 * 60 * 60;
/** A mailed password-reset link expires after this (#93): short, because it grants the account. */
export const PASSWORD_RESET_TTL_S = 30 * 60;

/** New verification links one account may ask for per window (#93). */
export const VERIFY_RESEND_MAX = 5;
export const VERIFY_RESEND_WINDOW_S = 60 * 60;
/**
 * Password-reset requests per window (#93): per address+IP, per address from any IP (so rotating
 * IPs cannot flood one inbox), and per IP across addresses (so one host cannot probe many). Over
 * any: `429`. The address+IP cap stays below the address cap, so one noisy IP cannot spend the
 * whole address budget and lock the real person out of resetting.
 */
export const RESET_REQUEST_MAX = 3;
export const RESET_REQUEST_ADDRESS_MAX = 6;
export const RESET_REQUEST_IP_MAX = 5;
export const RESET_REQUEST_WINDOW_S = 60 * 60;

/** `last_used_at` on an API key is written at most this often. */
export const API_KEY_TOUCH_INTERVAL_S = 5 * 60;

/** Password policy: length only; composition rules are not a security control. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Workspace slug: lower-case words joined by hyphens plus a short random suffix. */
export const SLUG_SUFFIX_BYTES = 3;
