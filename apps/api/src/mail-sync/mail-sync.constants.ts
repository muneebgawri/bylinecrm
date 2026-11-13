/**
 * Every number and fixed string mail sync (P2-2) runs on, in one place. A value here is a
 * decision; the code that uses it says what it is for, never repeats it.
 */

/** How far back the first import of a mailbox reaches. */
export const MAIL_INITIAL_SYNC_DAYS = 30;

/**
 * The mail history backfill: a mailbox's sync reaches back past its first import to a history floor, once, so mail
 * account managers sent from Gmail before the CRM — and the replies — is on the records and counts toward contact
 * status. Product decision (2026-11): every connected mailbox, back to this date.
 */
export const MAIL_HISTORY_FLOOR_DEFAULT = '2023-04-01';
/** The backfill walks back this many calendar months (UTC) per step, newest first: a step is one window. */
export const MAIL_BACKFILL_WINDOW_MONTHS = 1;
/**
 * What a backfilled message is first read with (`format=metadata`, a third of a full read): enough to tell whether
 * it concerns a person. Only one that does is read whole and stored — the disk is the limit (2026-11: 92% full).
 */
export const MAIL_BACKFILL_METADATA_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Date', 'Subject', 'Message-ID'] as const;
/** A backfill step holds its mailbox this long, renewed after every chunk: the CLI and the worker never race. */
export const MAIL_BACKFILL_LEASE_MS = 15 * 60 * 1000;
/** Backfill steps the worker keeps queued at once: they share its slots with every mailbox's incremental sync. */
export const MAIL_BACKFILL_JOBS_AT_ONCE = 2;
/**
 * People whose contact status a backfill window re-derives per transaction. A window's correspondents can number in
 * the hundreds, and a refresh reads all of each one's mail — a frequent correspondent's takes seconds on a cold cache
 * (2026-11: 4 s for one with 14k participant rows; 165 people took 12 s cold, 0.8 s warm) — so they are refreshed
 * this many at a time, each batch its own transaction, well inside the transaction's 15 s.
 */
export const MAIL_BACKFILL_REFRESH_BATCH = 5;
/**
 * Participants a person change re-points per transaction (#389). A staff or system address can be on 10k–27k
 * participant rows; re-pointing them all in one transaction ran past the 15 s and, retried, out of memory. Each batch
 * is its own short transaction, and what it re-points is reconciled with it, so a killed run leaves the rest done.
 */
export const MAIL_REMATCH_BATCH = 200;
/**
 * How long one delivery of a person change keeps re-matching before it hands the rest to the next delivery: a third
 * of the outbox lease (`OUTBOX_LEASE_MS`, 60 s), so one person with a huge mailbox never holds the relay's slot past
 * its claim, and the other events keep flowing between its passes.
 */
export const MAIL_REMATCH_BUDGET_MS = 20_000;
/**
 * Added to a stored message's own bytes (bodies, subject, snippet; uncompressed) for its participants, its copy, its
 * thread rows and their index entries, when the budget counts what the backfill wrote: an over-estimate on purpose.
 */
export const MAIL_BACKFILL_ROW_OVERHEAD_BYTES = 2048;
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
 * Gmail's per-user quota, as the Google project enforces it: "Units per minute per user". Google lowered it from
 * 15,000 to 6,000 in October 2026 and its console allows no higher value (PNW-1125), so it is a ceiling, not a setting.
 */
export const GMAIL_USER_UNITS_PER_MINUTE = 6000;
/**
 * The units a mailbox may spend in one second: a tenth of the minute held back for the same mailbox's sending (P2-3)
 * and Google's sliding window. Any 60 s then holds at most 61 of these seconds, under the minute.
 */
export const GMAIL_QUOTA_UNITS_PER_S = Math.floor((GMAIL_USER_UNITS_PER_MINUTE * 0.9) / 60);
/**
 * What Google bills each request, in quota units, for the format the client asks (gmail.http.ts). Google re-priced the
 * API on 2026-05-01 for projects created since (https://developers.google.com/workspace/gmail/api/reference/quota): a
 * message read costs 60 with `format=full`, 20 with `format=metadata` — no longer 5 (PNW-1125).
 */
export const GMAIL_UNITS = {
    getProfile: 1,
    listMessages: 5,
    listHistory: 2,
    /** `messages.get` with `format=full`. */
    getMessage: 60,
    /** `messages.get` with `format=metadata` (sending's lookup of a lost send, P2-3a). */
    getMessageMetadata: 20,
    send: 100,
    /** `messages.insert` (TRACK-2: a relayed send's copy in Sent). */
    insert: 25,
    /** `users.settings.sendAs.list` (#193). */
    listSendAs: 1,
} as const;
/** Redis key prefix of a mailbox's per-second quota window. */
export const GMAIL_QUOTA_KEY_PREFIX = 'mail-sync:quota:';
/**
 * Google bills a project's Gmail use above this many units a day (projects created since 2026-05-01, PNW-1194). The
 * Google project is BylineCRM's OAuth client, so its day is what GmailQuota grants.
 */
export const GMAIL_PROJECT_BILLED_UNITS_PER_DAY = 80_000_000;
/** The day's total at which the platform admins are told, once that day: half the billed line, time to act. */
export const GMAIL_DAILY_ALERT_UNITS = GMAIL_PROJECT_BILLED_UNITS_PER_DAY / 2;
/** Google's daily quotas run midnight to midnight Pacific time. */
export const GMAIL_QUOTA_DAY_ZONE = 'America/Los_Angeles';
/** Redis key prefix of the project's units for one quota day (`<prefix><YYYY-MM-DD>`), kept this long. */
export const GMAIL_DAY_KEY_PREFIX = 'mail-sync:units-day:';
export const GMAIL_DAY_KEY_TTL_S = 3 * 24 * 60 * 60;

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
/**
 * Gmail's per-user rate limits (`403 rateLimitExceeded` / `userRateLimitExceeded`): a request refused with one is retried
 * with the backoff, and a mailbox whose run still ends rate-limited is not synced again by the tick until it has cooled
 * down — BASE after the first such run, doubling with each consecutive one, at most CAP. Gmail asks for exponential
 * backoff; retrying every tick kept the limit tripped for days.
 */
export const GMAIL_RATE_LIMIT_REASONS: ReadonlySet<string> = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
export const MAIL_SYNC_RATE_LIMIT_COOLDOWN_BASE_MS = 5 * 60 * 1000;
export const MAIL_SYNC_RATE_LIMIT_COOLDOWN_CAP_MS = 2 * 60 * 60 * 1000;
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

/** An integration's page of service-inbox mail (SVC-1). */
export const SERVICE_MAIL_LIMIT_DEFAULT = 100;
export const SERVICE_MAIL_LIMIT_MAX = 200;
/** How many sender addresses one integration read may name (SVC-1). */
export const INTEGRATION_SENDERS_MAX = 200;
