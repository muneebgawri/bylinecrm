/**
 * Every number transactional mail runs on (#93), in one place. A value here is a decision; the code
 * that uses it says what it is for.
 */

/** The BullMQ queue mail waits in between the commit that caused it and the transport. */
export const TRANSACTIONAL_MAIL_QUEUE = 'transactional-mail';

/** Delivery attempts for a transient failure (network, 429, 5xx), exponential from the backoff. */
export const TRANSACTIONAL_MAIL_JOB_ATTEMPTS = 5;
export const TRANSACTIONAL_MAIL_JOB_BACKOFF_MS = 30_000;

/** A failed job is kept this long for diagnosis (its payload stays sealed), then removed. */
export const TRANSACTIONAL_MAIL_FAILED_RETENTION_S = 7 * 24 * 60 * 60;

/** Jobs the worker runs at once: mail is small and the provider rate-limits per key. */
export const TRANSACTIONAL_MAIL_WORKER_CONCURRENCY = 2;

/** Resend's send endpoint, and how long one request may take before it counts as failed. */
export const RESEND_SEND_URL = 'https://api.resend.com/emails';
export const RESEND_TIMEOUT_MS = 10_000;

/** Messages the memory transport keeps (newest last) for the test suite and a developer. */
export const MEMORY_OUTBOX_CAPACITY = 200;
