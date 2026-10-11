/**
 * The outbox relay's numbers (P1-6). These are the only copies; the relay reads them, the design
 * note (docs/design-notes/P1-6.md) explains them.
 */

/**
 * Milliseconds between the relay's scans for open events. A commit in this process wakes the relay
 * at once, so the scan only matters for what no local commit announced: retries that came due,
 * leases that expired (a relay died mid-delivery), and events another process committed.
 */
export const OUTBOX_POLL_MS = 2_000;

/** Events one scan claims. */
export const OUTBOX_BATCH = 50;

/**
 * Events delivered at once. Each consumer opens its own tenant transaction on the background pool
 * (`BACKGROUND_POOL_SIZE`, 6), so this stays below it and leaves the pool's other workers room.
 */
export const OUTBOX_CONCURRENCY = 4;

/**
 * Milliseconds a claim holds an event. Long enough for every consumer of one event to finish
 * (each is a short transaction, `TRANSACTION_TIMEOUT_MS` at worst); past it the event is free to
 * claim again, which is how an event a dead relay held gets delivered.
 */
export const OUTBOX_LEASE_MS = 60_000;

/** Delivery attempts before an event is marked failed and left for inspection. */
export const OUTBOX_MAX_ATTEMPTS = 12;

/** The first retry's wait; each later one doubles, up to `OUTBOX_RETRY_CAP_MS`. */
export const OUTBOX_RETRY_BASE_MS = 2_000;

/** The longest wait between two attempts. Twelve attempts span about an hour. */
export const OUTBOX_RETRY_CAP_MS = 10 * 60_000;

/** The wait before attempt `attempts + 1`, after `attempts` failed ones. */
export function outboxRetryDelayMs(attempts: number): number {
    return Math.min(OUTBOX_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_RETRY_CAP_MS);
}

/** Days a delivered event is kept (for inspection and replay), and a failed one. */
export const OUTBOX_RETENTION_DAYS = { completed: 7, failed: 30 } as const;

/** Milliseconds between retention passes. */
export const OUTBOX_RETENTION_EVERY_MS = 60 * 60_000;
