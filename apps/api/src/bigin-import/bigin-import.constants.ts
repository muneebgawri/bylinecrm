/**
 * Every number and fixed string the Bigin importer (BIGIN-1) runs on, in one place. A value here is a
 * decision; the code that uses it says what it is for, never repeats it.
 */

/** The queue a run is driven on; a job's id is the run's, so one run has at most one job. */
export const BIGIN_IMPORT_QUEUE = 'bigin-import';
/** The schedule's job: one BullMQ job scheduler per workspace, on the same queue, under this id. */
export const BIGIN_SYNC_JOB = 'sync';
export const biginSyncSchedulerId = (workspaceId: string): string => `bigin-sync:${workspaceId}`;
export const BIGIN_IMPORT_JOB_ATTEMPTS = 3;
export const BIGIN_IMPORT_JOB_BACKOFF_MS = 30_000;
export const BIGIN_IMPORT_LOCK_MS = 5 * 60_000;

/** Bigin's REST root under the data centre's API host. */
export const BIGIN_REST_PATH = '/bigin/v1';
/** Zoho's token endpoint under the data centre's accounts host. */
export const ZOHO_TOKEN_PATH = '/oauth/v2/token';
export const BIGIN_HTTP_TIMEOUT_MS = 60_000;
export const BIGIN_RETRY_ATTEMPTS = 5;
export const BIGIN_RETRY_BASE_MS = 1_000;
export const BIGIN_RETRY_CAP_MS = 30_000;
/** An access token is reused until this long before Zoho says it expires (Zoho limits refreshes). */
export const ZOHO_TOKEN_MARGIN_MS = 5 * 60_000;

/**
 * Bigin's `If-Modified-Since` has a resolution of a second: a window starts a second before the last
 * instant a run read through, so nothing modified in that second is stepped over (the links make the
 * re-read idempotent).
 */
export const BIGIN_WINDOW_OVERLAP_MS = 1_000;
/** Page numbers stay well inside Zoho's discrete-pagination ceiling (2,000 records); the window moves instead. */
export const BIGIN_PAGE_MAX = 10;

export const BIGIN_IMPORT_RUNS_SHOWN = 20;
export const BIGIN_SECRET_SHOWN_CHARS = 4;

/**
 * Records written per transaction within a page (production, 2026-10-19): a whole page of 200 in one
 * transaction outlived the 15-second transaction limit, so a page is written 20 at a time.
 */
export const BIGIN_WRITE_CHUNK = 20;
