/**
 * Every number outbound delivery runs on (P1-5), in one place. The code that uses a value says
 * what it is for and never repeats it; the design note explains the choices.
 */

/** The BullMQ queue deliveries wait on, and the one the retention job repeats on. */
export const WEBHOOK_QUEUE = 'webhook-deliveries';
export const WEBHOOK_MAINTENANCE_QUEUE = 'webhook-maintenance';

/** Deliveries in flight at once in one worker process. */
export const WEBHOOK_WORKER_CONCURRENCY = 8;

/** Per endpoint: at most `max` deliveries started in any `perMs` window; the rest wait. */
export const WEBHOOK_ENDPOINT_RATE = { max: 60, perMs: 60_000 } as const;

/** An attempt that gets no 2xx within this is a failure. */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;
/** The response body is read up to here (for the error log) and no further. */
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
export const WEBHOOK_USER_AGENT = 'BylineCRM-Webhooks/1';

/**
 * Retries: after the n-th failed attempt the next waits base · factor^(n−1), capped, ± jitter;
 * after the last attempt the delivery is dead. 1 s, 2 s, 4 s, 8 s between five attempts.
 */
export const WEBHOOK_MAX_ATTEMPTS = 5;
export const WEBHOOK_RETRY_BASE_MS = 1_000;
export const WEBHOOK_RETRY_FACTOR = 2;
export const WEBHOOK_RETRY_MAX_MS = 60_000;
export const WEBHOOK_RETRY_JITTER = 0.2;

/** This many dead deliveries in a row switch the endpoint off; a success resets the count. */
export const WEBHOOK_AUTO_DISABLE_AFTER_DEAD = 5;

/** A signing secret is 32 random bytes; a list shows its first characters only. */
export const WEBHOOK_SECRET_BYTES = 32;
export const WEBHOOK_SECRET_PREFIX_CHARS = 8;
/** After a rotation the previous secret still verifies for this long. */
export const WEBHOOK_ROTATION_GRACE_S = 24 * 60 * 60;

/** Delivery rows are pruned by the retention job: succeeded ones soon, failed and dead ones later. */
export const WEBHOOK_RETENTION_DAYS = { succeeded: 7, failedOrDead: 30 } as const;
export const WEBHOOK_RETENTION_EVERY_MS = 60 * 60 * 1000;

/** How long a failure's message is kept on the delivery row. */
export const WEBHOOK_ERROR_MAX_CHARS = 500;

/**
 * The wait before the next attempt, after `attempt` (1-based) failed. `random` is injectable so
 * the schedule can be asserted; the queue and the delivery row both read this one function.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
    const base = Math.min(
        WEBHOOK_RETRY_BASE_MS * WEBHOOK_RETRY_FACTOR ** Math.max(0, attempt - 1),
        WEBHOOK_RETRY_MAX_MS,
    );
    const jitter = 1 + (random() * 2 - 1) * WEBHOOK_RETRY_JITTER;
    return Math.round(base * jitter);
}
