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
/**
 * Records are listed through v2 (production, 2026-10-19): page numbers stop at 2,000 records, and a bulk edit
 * in Bigin leaves more than 2,000 sharing one modification second, which no window can step past. v2's
 * `page_token` pages on past it; v2 needs the fields named, sampled once per module from v1.
 */
export const BIGIN_REST_PATH_V2 = '/bigin/v2';
/** Bigin v2 names at most this many fields per list call. */
export const BIGIN_FIELDS_MAX = 50;
/**
 * The fields the mappers read, by module: asked of v2 (when the sampled v1 page has them) ahead of every other field, so the 50-field cap never
 * drops one (a Contact read without `First_Name` was imported, and updated, with an empty first name).
 */
export const BIGIN_MAPPED_FIELDS: Readonly<Record<string, readonly string[]>> = {
    Accounts: [
        'Account_Name',
        'Website',
        'Billing_Street',
        'Billing_City',
        'Billing_State',
        'Billing_Country',
        'Billing_Code',
        'Owner',
    ],
    Contacts: [
        'First_Name',
        'Last_Name',
        'Email',
        'Secondary_Email',
        'Phone',
        'Mobile',
        'Title',
        'Mailing_City',
        'Account_Name',
        'Owner',
        'PR_LINK',
    ],
    Deals: ['Deal_Name', 'Amount', 'Closing_Date', 'Stage', 'Account_Name', 'Contact_Name', 'Owner'],
    Notes: ['Note_Title', 'Note_Content', 'Parent_Id', 'Owner'],
};
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

/** Applying the stage mapping to imported deals: one job per workspace on the import queue, under this id. */
export const BIGIN_STAGE_APPLY_JOB = 'stage-apply';
export const biginStageApplyJobId = (workspaceId: string): string => `bigin-stage-apply-${workspaceId}`;
/** Deals links read per page while applying (each page is then written `BIGIN_WRITE_CHUNK` at a time). */
export const BIGIN_STAGE_APPLY_PAGE = 500;
