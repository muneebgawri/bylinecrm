import { BIGIN_PAGE_MAX, BIGIN_WINDOW_OVERLAP_MS } from './bigin-import.constants';

/**
 * Where one module's pass is (BIGIN-1), saved on the run with every page so a run that dies resumes
 * where it was. Bigin is read oldest modification first, in windows: a window is `If-Modified-Since`
 * an instant, read page by page; once a page shows later records, the next window starts a second
 * before the latest of them (`since`, page 1). Moving the window instead of the page number keeps a
 * pass inside Zoho's 2,000-record pagination ceiling, and a record modified meanwhile moves to the
 * end rather than shifting the pages under the pass. `seen` holds the ids already read in the
 * overlap, so the second the windows share is not counted twice.
 */
export interface BiginPassCursor {
    since: string | null;
    page: number;
    /** v2's token for the next page while the window cannot move; null otherwise (absent on older runs). */
    pageToken?: string | null;
    /** Past v1's 2,000 records in a window that cannot move: read on by v2's page tokens (absent on older runs). */
    byToken?: boolean;
    seen: string[];
    /** The latest `Modified_Time` this pass wrote: everything at or before it has been read. */
    highWater: string | null;
    /** The earliest `Modified_Time` of a record this pass could not write: the module's cursor never passes it. */
    oldestFailure: string | null;
    done: boolean;
    /** The deletions' pass, after the records': where it reads from and its page. */
    deletedSince: string | null;
    deletedPage: number;
    deletedDone: boolean;
}

export function startPass(since: string | null, deletedSince: string | null): BiginPassCursor {
    return {
        since,
        page: 1,
        pageToken: null,
        byToken: false,
        seen: [],
        highWater: null,
        oldestFailure: null,
        done: false,
        deletedSince,
        deletedPage: 1,
        deletedDone: false,
    };
}

/** A Bigin timestamp (`2026-05-28T11:59:49+05:30`) as an instant, or null when it does not parse. */
export function biginInstant(value: unknown): Date | null {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const at = new Date(value.trim());
    return Number.isNaN(at.getTime()) ? null : at;
}

const earlier = (a: string | null, b: string): string => (a === null || b < a ? b : a);
const later = (a: string | null, b: string): string => (a === null || b > a ? b : a);
const minus = (iso: string, ms: number) => new Date(new Date(iso).getTime() - ms).toISOString();

/** A record was written: the high-water mark moves to it. */
export function noteSuccess(cursor: BiginPassCursor, modified: Date | null): void {
    if (modified) cursor.highWater = later(cursor.highWater, modified.toISOString());
}

/**
 * A record could not be written: the module's cursor must never step over it. A record whose time does
 * not parse pins the cursor at the window it was read in (or the beginning), rather than risk a skip.
 */
export function noteFailure(cursor: BiginPassCursor, modified: Date | null): void {
    const at = modified?.toISOString() ?? cursor.since ?? new Date(0).toISOString();
    cursor.oldestFailure = earlier(cursor.oldestFailure, at);
}

/** After a page: the next window or page to read, or the pass is done. */
export function advanceWindow(
    cursor: BiginPassCursor,
    page: { ids: string[]; latest: Date | null; moreRecords: boolean; nextPageToken?: string | null },
): void {
    if (!page.moreRecords) {
        cursor.done = true;
        cursor.seen = [];
        cursor.pageToken = null;
        cursor.byToken = false;
        return;
    }
    const next = page.latest ? new Date(page.latest.getTime() - BIGIN_WINDOW_OVERLAP_MS).toISOString() : null;
    if (next && (cursor.since === null || next > cursor.since)) {
        cursor.since = next;
        cursor.page = 1;
        cursor.pageToken = null;
        cursor.byToken = false;
        cursor.seen = page.ids;
        return;
    }
    // Every record of the page was modified in the window's first second: the window cannot move, so the page
    // does — by number up to v1's ceiling, then by v2's page tokens from its first page (they page past 2,000).
    cursor.page += 1;
    cursor.seen = [...cursor.seen, ...page.ids];
    if (cursor.byToken) {
        if (!page.nextPageToken) throw new Error('Bigin gave no page token for more records');
        cursor.pageToken = page.nextPageToken;
        return;
    }
    cursor.pageToken = null;
    if (cursor.page > BIGIN_PAGE_MAX) cursor.byToken = true;
}

/**
 * The cursor rule (from the Python sync's `cursor_policy.py`, where the old "advance only when clean"
 * rule deadlocked the sync for months): advance past everything that succeeded, never past the oldest
 * record that failed. A finished pass read everything modified before it started; an unfinished one only
 * up to its high-water mark — so a killed run keeps what it did. Never moves backwards: everything a
 * pass reads was modified after the cursor it started from.
 */
export function settledCursor(input: {
    previous: string | null;
    cursor: BiginPassCursor;
    passStartedAt: Date;
    complete: boolean;
}): string | null {
    const { cursor } = input;
    let candidate = input.complete ? input.passStartedAt.toISOString() : cursor.highWater;
    if (candidate === null) return input.previous;
    if (cursor.oldestFailure) candidate = earlier(candidate, cursor.oldestFailure);
    const settled = minus(candidate, BIGIN_WINDOW_OVERLAP_MS);
    return input.previous === null ? settled : later(input.previous, settled);
}
