/**
 * Every number and fixed string the Twenty importer (P4-4) runs on, in one place. A value here is
 * a decision; the code that uses it says what it is for, never repeats it.
 */

/** The queue an import run is driven on; a job's id is the run's, so one run has at most one job. */
export const TWENTY_IMPORT_QUEUE = 'twenty-import';
/** A run whose job threw (the database, Redis, Twenty down for good) is retried from its cursor this many times. */
export const TWENTY_IMPORT_JOB_ATTEMPTS = 3;
export const TWENTY_IMPORT_JOB_BACKOFF_MS = 30_000;
/** A page takes seconds; the lock is renewed well inside this. */
export const TWENTY_IMPORT_LOCK_MS = 5 * 60_000;

/** Twenty's REST root under a workspace's URL. */
export const TWENTY_REST_PATH = '/rest';
/** One Twenty request may take this long before it is abandoned. */
export const TWENTY_HTTP_TIMEOUT_MS = 30_000;
/** Attempts per request on `429` or a `5xx` (or no answer) before the run gives up on it. */
export const TWENTY_RETRY_ATTEMPTS = 5;
/** The first retry's wait; each next doubles, up to the cap. */
export const TWENTY_RETRY_BASE_MS = 1_000;
export const TWENTY_RETRY_CAP_MS = 30_000;

/** How many of a workspace's runs the screen lists. */
export const TWENTY_IMPORT_RUNS_SHOWN = 20;
/** The last characters of an API key the screen shows, to tell keys apart. */
export const TWENTY_API_KEY_SHOWN_CHARS = 4;
/** The note on an exclusion the importer ends because Twenty no longer assigns the address. */
export const TWENTY_RELEASE_NOTE = 'Unassigned in Twenty';
