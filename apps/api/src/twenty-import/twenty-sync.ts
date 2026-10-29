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
 * Custom values are held back key by key when `edited` names them (`custom.<key>`, BIGIN-1): the
 * other custom fields are still written. Without that detail `custom` is held back whole.
 */
export function withoutLocalEdits<T extends object>(
    input: T,
    edited: ReadonlySet<string>,
): { input: T; kept: string[] } {
    const custom = (input as { custom?: unknown }).custom;
    const perKey =
        edited.has('custom') && custom !== null && typeof custom === 'object' && [...edited].some(isCustomKey);
    const kept = Object.keys(input)
        .filter((field) => edited.has(field) && !(perKey && field === 'custom'))
        .concat(
            perKey
                ? Object.keys(custom)
                      .filter((key) => edited.has(`custom.${key}`))
                      .map((k) => `custom.${k}`)
                : [],
        )
        .sort();
    if (kept.length === 0) return { input, kept };
    const rest = Object.fromEntries(
        Object.entries(input).filter(([field]) => !edited.has(field) || (perKey && field === 'custom')),
    ) as Record<string, unknown>;
    if (perKey) {
        rest.custom = Object.fromEntries(
            Object.entries(custom as Record<string, unknown>).filter(([key]) => !edited.has(`custom.${key}`)),
        );
    }
    return { input: rest as T, kept };
}

const isCustomKey = (field: string) => field.startsWith('custom.');
