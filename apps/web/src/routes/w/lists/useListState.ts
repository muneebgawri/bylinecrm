import { SORT_MAX_FIELDS, type FilterGroup, type ViewSort } from '@bylinecrm/shared';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { decodeFilter, encodeFilter } from '../../../lib/filterParam';

/**
 * A list's state lives in its URL, so a link, a refresh and the Back button all reproduce it:
 * `view` (a saved view's id), `filter` (the P1-4 grammar, base64url — `lib/filterParam.ts`),
 * `sort` (`field:asc,field:desc`, the API's own spelling), `q` (search). Every other parameter
 * on the URL (the record drawer's `open`) is left as it is.
 */
export const LIST_PARAMS = { view: 'view', filter: 'filter', sort: 'sort', q: 'q' } as const;

export interface ListState {
    viewId: string | undefined;
    /** The inline filter; when absent the saved view's (if any) applies on the server. */
    filter: FilterGroup | null;
    /** The inline sort; empty means the view's or the API's default. */
    sorts: ViewSort[];
    q: string;
}

/** `field:asc,field:desc` — the API's sort parameter. */
export function formatSort(sorts: readonly ViewSort[]): string | undefined {
    return sorts.length ? sorts.map((s) => `${s.field}:${s.direction}`).join(',') : undefined;
}

export function parseSort(raw: string | null): ViewSort[] {
    if (!raw) return [];
    return raw
        .split(',')
        .map((part) => part.split(':'))
        .filter((pair): pair is [string, string] => pair.length === 2 && Boolean(pair[0]))
        .map(([field, dir]) => ({ field, direction: dir === 'desc' ? ('desc' as const) : ('asc' as const) }))
        .slice(0, SORT_MAX_FIELDS);
}

export function useListState() {
    const [params, setParams] = useSearchParams();

    const state: ListState = useMemo(
        () => ({
            viewId: params.get(LIST_PARAMS.view) ?? undefined,
            filter: decodeFilter(params.get(LIST_PARAMS.filter)),
            sorts: parseSort(params.get(LIST_PARAMS.sort)),
            q: params.get(LIST_PARAMS.q) ?? '',
        }),
        [params],
    );

    const update = useCallback(
        (patch: Partial<ListState>) =>
            setParams(
                (current) => {
                    const next = new URLSearchParams(current);
                    const set = (key: string, value: string | undefined) =>
                        value ? next.set(key, value) : next.delete(key);
                    if ('viewId' in patch) set(LIST_PARAMS.view, patch.viewId);
                    if ('filter' in patch)
                        set(LIST_PARAMS.filter, patch.filter ? encodeFilter(patch.filter) : undefined);
                    if ('sorts' in patch) set(LIST_PARAMS.sort, formatSort(patch.sorts ?? []));
                    if ('q' in patch) set(LIST_PARAMS.q, patch.q?.trim() ? patch.q : undefined);
                    return next;
                },
                { replace: true },
            ),
        [setParams],
    );

    /** Choosing a view starts from that view: the inline filter and sort it would replace are dropped. */
    const selectView = useCallback(
        (viewId: string | undefined) => update({ viewId, filter: null, sorts: [] }),
        [update],
    );

    return { state, update, selectView, encodedFilter: params.get(LIST_PARAMS.filter) ?? undefined };
}
