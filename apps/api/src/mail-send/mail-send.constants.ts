/**
 * Every number and fixed string sending (P2-3) runs on, in one place. Gmail's own numbers — its
 * quota, per-method units and the per-request retry schedule — are mail sync's
 * (`mail-sync.constants.ts`), shared, not repeated.
 */

/** The right-hand side of every Message-ID the CRM writes: `<uuid>@bylinecrm`. Not a real domain, on purpose. */
export const MAIL_MESSAGE_ID_DOMAIN = 'bylinecrm';

/**
 * Our own header on every send: `X-BylineCRM-Id: <send id>`. Gmail replaces the Message-ID we set
 * with its own (seen against real Gmail, 2026-10-11) but keeps custom `X-` headers, so this is how a
 * send is recognised in the mailbox after an answer was lost (#87).
 */
export const MAIL_CRM_ID_HEADER = 'X-BylineCRM-Id';
/**
 * Before re-sending after an attempt whose answer was lost, the mailbox's sent messages to the first
 * recipient since the send was created (less this skew, for clock drift) are checked for our header,
 * at most this many — newest first. A send is looked for, never assumed.
 */
export const MAIL_SEND_DEDUPE_SKEW_MS = 10 * 60 * 1000;
export const MAIL_SEND_DEDUPE_MAX_CANDIDATES = 25;

/** The queue sends run on; a job's id is its message's, so one message has at most one job. */
export const MAIL_SEND_QUEUE = 'mail-send';
/** Sends at once in one worker process. */
export const MAIL_SEND_WORKER_CONCURRENCY = 4;
/**
 * A send whose Gmail requests all failed transiently is retried by the queue this many times, with
 * exponential backoff from this base; after the last, the message is marked failed.
 */
export const MAIL_SEND_JOB_ATTEMPTS = 3;
export const MAIL_SEND_JOB_BACKOFF_MS = 30_000;

/**
 * Scheduled sends (P2-5). A delayed job is only the trigger; the row decides. A job that fires more
 * than `MAIL_SEND_EARLY_TOLERANCE_MS` before the row's `sendAt` (the send was moved later after its
 * job was set) goes back to wait for the rest.
 */
export const MAIL_SEND_EARLY_TOLERANCE_MS = 5_000;
/**
 * A scheduled send whose time passed this long ago — the workers were down, or Redis lost the job
 * — is failed as `stale` rather than sent: a message meant for 9:00 arriving the next afternoon is
 * worse than one that says it did not go. The sender sees why and can send it again.
 */
export const MAIL_SEND_STALE_MS = 24 * 60 * 60 * 1000;

/** The maintenance queue the send sweep repeats on, and how often. */
export const MAIL_SEND_MAINTENANCE_QUEUE = 'mail-send-maintenance';
export const MAIL_SEND_SWEEP_EVERY_MS = 60_000;
/**
 * The sweep re-enqueues sends whose job is gone: `queued` rows older than this grace (their job
 * should have run long since), and `scheduled` rows due before the next two passes — a send due
 * later is looked at when it comes due, so one pass never scans every future send.
 */
export const MAIL_SEND_SWEEP_GRACE_MS = 60_000;
export const MAIL_SEND_SWEEP_HORIZON_MS = 2 * MAIL_SEND_SWEEP_EVERY_MS;
/** Rows read per sweep query. */
export const MAIL_SEND_SWEEP_BATCH = 200;
/** Rows examined per sweep pass at most (#97); the next pass resumes where this one stopped. */
export const MAIL_SEND_SWEEP_MAX_ROWS_PER_PASS = 10 * MAIL_SEND_SWEEP_BATCH;

/** `GET /mail/scheduled` page size. */
export const MAIL_SCHEDULED_LIMIT_DEFAULT = 25;
export const MAIL_SCHEDULED_LIMIT_MAX = 100;
/** A page of a record's sends (#104, `GET /mail/messages`). */
export const MAIL_RECORD_SENDS_LIMIT_DEFAULT = 25;
export const MAIL_RECORD_SENDS_LIMIT_MAX = 100;
