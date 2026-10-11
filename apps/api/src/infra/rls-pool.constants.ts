/**
 * Sizing and retry for the database connection pools. These are the only numbers; the services
 * read them, the design note explains them, nothing else repeats them.
 *
 * Every tenant query runs inside an interactive transaction that pins one connection for its
 * duration. Request handling and background work (BullMQ workers, sweeps, and the event listeners
 * they trigger) get separate tenant pools (#86): an initial mail import once made ordinary
 * requests fail because workers and their listeners took every connection of a shared pool.
 * Background work may wait for its own pool; it can never take a request's connection.
 *
 * Connections one API process opens, at most:
 *
 *     request pool     REQUEST_POOL_SIZE     10
 *     background pool  BACKGROUND_POOL_SIZE   6
 *     owner client     OWNER_POOL_SIZE        5   (migrations, sign-up, admin reads)
 *                                            ──
 *                                            21
 *
 * Postgres allows `max_connections` (100 by default — the local compose stack and CI's service
 * container both use the default). The staging/production compose sets its own `max_connections`
 * and runs one API process, so 21 must stay below that value minus what operators reserve for
 * themselves (`superuser_reserved_connections`, 3 by default). An operator can override any
 * size with `connection_limit` in the URL; the explicit value wins.
 */

/** Connections in the request-path tenant pool when the URL does not set `connection_limit`. */
export const REQUEST_POOL_SIZE = 10;

/** Connections in the background (workers, sweeps, their listeners) tenant pool. */
export const BACKGROUND_POOL_SIZE = 6;

/** Connections in the owner client's pool (migrations, sign-up, administration). */
export const OWNER_POOL_SIZE = 5;

/** Seconds a query waits for a free connection before Prisma reports the pool exhausted (P2024). */
export const POOL_TIMEOUT_S = 10;

/**
 * Milliseconds an interactive transaction may wait for a connection before it starts; past it
 * Prisma reports P2028 ("Unable to start a transaction in the given time"). Prisma's default is
 * 2,000; a burst of background listeners can hold the background pool for longer, and waiting is
 * what background work should do.
 */
export const TRANSACTION_MAX_WAIT_MS = 5_000;

/**
 * Milliseconds an interactive transaction may run, start to commit, before Prisma expires it and
 * rolls it back (P2028 "Transaction already closed"). Prisma's default is 5,000 and counts wall
 * time, so a process paused by GC or a starved CPU expires transactions that did a millisecond of
 * work — the store of a synced message, a listener's timeline entry — and that work is lost, since
 * an expired transaction is not retried. Well-behaved transactions take milliseconds (no network
 * call happens inside one; see `transaction-scope.ts`); this is the ceiling for a stuck one, after
 * which its connection is released.
 */
export const TRANSACTION_TIMEOUT_MS = 15_000;

/** Prisma's error code for "timed out waiting for a connection from the pool". */
export const POOL_EXHAUSTED_CODE = 'P2024';

/**
 * Prisma's error code for a Transaction API error — among them "Unable to start a transaction in
 * the given time". It also covers a transaction that expired or closed while running, so it is
 * retried only when the transaction never started (the callback never ran): retrying after the
 * callback ran could do its work twice.
 */
export const TRANSACTION_API_ERROR_CODE = 'P2028';

/** How many times a transaction is tried in all when it could not get a connection. */
export const POOL_RETRY_ATTEMPTS = 3;

/** First retry waits this long; each later retry doubles it. */
export const POOL_RETRY_BASE_MS = 100;
