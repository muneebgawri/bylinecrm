/**
 * Every number and fixed string sending (P2-3) runs on, in one place. Gmail's own numbers — its
 * quota, per-method units and the per-request retry schedule — are mail sync's
 * (`mail-sync.constants.ts`), shared, not repeated.
 */

/** The right-hand side of every Message-ID the CRM writes: `<uuid>@bylinecrm`. Not a real domain, on purpose. */
export const MAIL_MESSAGE_ID_DOMAIN = 'bylinecrm';

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
