/**
 * Every number and fixed string mail sync (P2-2) runs on, in one place. A value here is a
 * decision; the code that uses it says what it is for, never repeats it.
 */

/** How far back the first import of a mailbox reaches. */
export const MAIL_INITIAL_SYNC_DAYS = 30;
/**
 * When Gmail no longer has the history after the stored cursor (`404`), the mailbox is re-listed
 * from its last good sync less this margin — never further back than the first import's window.
 */
export const MAIL_RESYNC_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Message ids asked for per `messages.list` page (Gmail allows up to 500). */
export const GMAIL_LIST_PAGE_SIZE = 100;
/** Messages fetched at once within one mailbox's run. */
export const GMAIL_FETCH_CONCURRENCY = 5;

/**
 * Gmail's quota is 250 units per user per second; the sync keeps under it with room for the same
 * mailbox's sending (P2-3). Costs are Gmail's published per-method units.
 */
export const GMAIL_QUOTA_UNITS_PER_S = 200;
export const GMAIL_UNITS = {
    getProfile: 1,
    listMessages: 5,
    listHistory: 2,
    getMessage: 5,
    send: 100,
    /** `users.settings.sendAs.list` (#193). */
    listSendAs: 1,
} as const;
/** Redis key prefix of a mailbox's per-second quota window. */
export const GMAIL_QUOTA_KEY_PREFIX = 'mail-sync:quota:';

/** Attempts per Gmail request on `429` or a `5xx` before the run gives up (it is retried later). */
export const GMAIL_RETRY_ATTEMPTS = 5;
/** The first retry's wait; each next doubles, up to the cap, with ± jitter. */
export const GMAIL_RETRY_BASE_MS = 1_000;
export const GMAIL_RETRY_CAP_MS = 32_000;
export const GMAIL_RETRY_JITTER = 0.2;

/** One Gmail request may take this long before it is abandoned. */
export const GMAIL_HTTP_TIMEOUT_MS = 15_000;
/** Gmail's REST base for the signed-in user. The HTTP adapter is the only code that calls it. */
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Labels whose messages are not mail a person exchanged with someone: never imported. */
export const SKIPPED_LABELS = ['DRAFT', 'SPAM', 'TRASH', 'CHAT'] as const;
/** The label Gmail puts on what the mailbox sent. */
export const SENT_LABEL = 'SENT';

/**
 * A body longer than this (characters, per part kept) is stored cut and marked `body_truncated`:
 * the CRM keeps mail to read, not archives.
 */
export const MAIL_BODY_MAX_CHARS = 200_000;
/** A subject or snippet is stored up to this length. */
export const MAIL_LINE_MAX_CHARS = 1_000;

/** The queue every mailbox's sync runs on; a job's id is its mailbox's, so one runs at a time. */
export const MAIL_SYNC_QUEUE = 'mail-sync';
/** How often every connected mailbox is synced incrementally. */
export const MAIL_SYNC_EVERY_MS = 2 * 60 * 1000;
/** Mailbox runs at once in one worker process. */
export const MAIL_SYNC_WORKER_CONCURRENCY = 4;
/** A failed run is retried this many times, with the queue's exponential backoff from this base. */
export const MAIL_SYNC_JOB_ATTEMPTS = 3;
export const MAIL_SYNC_JOB_BACKOFF_MS = 30_000;

/** Page sizes for the thread list. */
export const MAIL_THREADS_LIMIT_DEFAULT = 30;
export const MAIL_THREADS_LIMIT_MAX = 100;

/**
 * Attempts at storing one copy (#107). Two mailboxes may store the first copy of one message at
 * once; the second attempt of the run that lost finds the message and stores its copy beside it.
 */
export const STORE_ATTEMPTS = 2;
