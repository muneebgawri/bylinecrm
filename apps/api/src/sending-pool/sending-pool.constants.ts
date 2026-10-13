/**
 * Every fixed number the sending pool (P3-2) runs on that is not a workspace setting. The settings
 * and their defaults are `@bylinecrm/shared`'s (`SENDING_POOL_DEFAULTS`); why each is what it is:
 * docs/design-notes/P3-2.md.
 */

/** Gmail sends from Google's servers: a passing SPF record includes this. */
export const GOOGLE_SPF_INCLUDE = '_spf.google.com';

/** One DNS lookup is given up after this long (and the step fails, saying so). */
export const DNS_LOOKUP_TIMEOUT_MS = 5_000;

/** The maintenance job that re-checks sending domains, and how often it looks for domains due. */
export const SENDING_DOMAIN_CHECK_JOB = 'sending-domain-check';
export const SENDING_DOMAIN_CHECK_EVERY_MS = 5 * 60 * 1000;
/** Domains one pass checks, the most overdue first. */
export const SENDING_DOMAIN_CHECK_BATCH = 50;

/** The longest a resume note may be. */
export const MAILBOX_RESUME_NOTE_MAX = 500;

/** The Postmaster Tools API (#129). The HTTP adapter is the only code that calls it. */
export const POSTMASTER_ENDPOINT = 'https://gmailpostmastertools.googleapis.com/v1';
/** One Postmaster request may take this long before it is abandoned. */
export const POSTMASTER_HTTP_TIMEOUT_MS = 10_000;
/** Redis key for the one process refreshing a workspace's Postmaster token at a time. */
export const POSTMASTER_TOKEN_LOCK_KEY_PREFIX = 'postmaster-token-lock:';
