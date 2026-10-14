import { TWENTY_SYNC_INTERVAL_MS, type TwentySyncEvery } from '@bylinecrm/shared';

/** The longest a schedule waits after failures in a row: a day, so a broken connection is still tried daily. */
const SYNC_WAIT_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * How long the schedule waits after the last scheduled run before it starts another (#185): the
 * interval, doubled per failure in a row, at most a day. The scheduler fires every interval; a tick
 * inside the wait starts nothing, so runs never stack and a failing connection is tried less often.
 */
export function syncWaitMs(interval: TwentySyncEvery, failures: number): number {
    return Math.min(TWENTY_SYNC_INTERVAL_MS[interval] * 2 ** failures, SYNC_WAIT_MAX_MS);
}

/**
 * The precedence rule (#185): Twenty is the source for the fields the importer maps, except a field
 * edited in BylineCRM after Twenty last touched the record — that keeps BylineCRM's value. `edited`
 * names those fields (what the timeline shows changed by someone other than the import, later than
 * Twenty's `updatedAt`); the input loses them, and `kept` names what it lost, for the run report.
 */
export function withoutLocalEdits<T extends object>(
    input: T,
    edited: ReadonlySet<string>,
): { input: T; kept: string[] } {
    const kept = Object.keys(input)
        .filter((field) => edited.has(field))
        .sort();
    if (kept.length === 0) return { input, kept };
    const rest = Object.fromEntries(Object.entries(input).filter(([field]) => !edited.has(field))) as T;
    return { input: rest, kept };
}
