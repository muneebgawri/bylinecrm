/**
 * Names the API and the web app must agree on for a request to be recognised as signed in.
 * Defined once here; neither side spells them out again.
 */

/** The session cookie: httpOnly, so the web app never reads it, only sends it. */
export const SESSION_COOKIE = 'blc_session';

/**
 * CSRF, double-submit: the API sets this readable cookie alongside the session; a state-changing
 * request made with the session cookie must echo its value in `CSRF_HEADER`. A bearer (API key)
 * request carries no ambient credential and is exempt.
 */
export const CSRF_COOKIE = 'blc_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** An API key reads `blc_<prefix>_<secret>`; the prefix identifies the key, the secret proves it. */
export const API_KEY_PREFIX = 'blc';
export const API_KEY_ID_LENGTH = 8;

/**
 * The transaction-local setting that carries the signed-in user to the row-level policies that
 * let a user see their own memberships before a workspace is chosen. Companion to
 * `WORKSPACE_SETTING`.
 */
export const USER_SETTING = 'app.user_id';
