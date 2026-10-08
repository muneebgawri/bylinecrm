/**
 * Sizing and retry for the restricted (RLS) connection pool. These are the only numbers; the
 * service reads them, the design note explains them, nothing else repeats them.
 *
 * Every tenant query runs inside an interactive transaction that pins one connection for its
 * duration, so the pool must be large enough for the concurrency we expect, and a request that
 * finds the pool exhausted must wait and retry rather than fail on the first miss.
 */

/** Connections in the RLS pool when the URL does not set `connection_limit` itself. */
export const RLS_POOL_SIZE = 10;

/** Seconds a query waits for a free connection before Prisma reports the pool exhausted (P2024). */
export const RLS_POOL_TIMEOUT_S = 10;

/** Prisma's error code for "timed out waiting for a connection from the pool". */
export const POOL_EXHAUSTED_CODE = 'P2024';

/** How many times a transaction is retried after the pool reports exhaustion. */
export const POOL_RETRY_ATTEMPTS = 3;

/** First retry waits this long; each later retry doubles it. */
export const POOL_RETRY_BASE_MS = 100;
