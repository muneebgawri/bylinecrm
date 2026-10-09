import type { RecordObject } from '@bylinecrm/shared';
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { search, views, type ListParams } from './endpoints';
import { keys, recordEndpoints, type RecordInputOf, type RecordViewOf } from './queries';
import type { CompanyView, CreateViewInput, PersonView, UpdateViewInput } from './types';

/**
 * The query hooks only the lazily loaded data views use (P1-UI-2): a list read by cursor, saved
 * views, search, names for ids, create and bulk change. Kept out of `queries.ts`, which the shell
 * imports, so they load with the pages that use them rather than in every first paint (the
 * `.size-limit.json` budget). The cache keys stay in `queries.ts` — one place for the cache's shape.
 */

// ─────────────────────────────────────────────────────────────────────────────

/** The query a list page sends, minus the cursor the pages supply. */
export type ListQuery = Omit<ListParams, 'cursor'>;

/**
 * A list read by cursor, page after page, as the table scrolls (desktop) or the cards reach the
 * end (phone). The API gives no total, so the list knows "more" or "no more", never "page 3 of 9".
 */
export function useRecordPages<O extends RecordObject>(workspaceId: string, object: O, params: ListQuery) {
    return useInfiniteQuery({
        queryKey: [...keys.records(workspaceId, object), 'pages', params] as const,
        queryFn: ({ pageParam, signal }) =>
            recordEndpoints[object].list(workspaceId, { ...params, cursor: pageParam }, signal) as Promise<{
                items: RecordViewOf<O>[];
                nextCursor: string | null;
            }>,
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
    });
}

export const useViews = (workspaceId: string, object: RecordObject) =>
    useQuery({
        queryKey: keys.views(workspaceId, object),
        queryFn: ({ signal }) => views.list(workspaceId, object, signal),
    });

export function useCreateView(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CreateViewInput) => views.create(workspaceId, input),
        onSuccess: (view) => client.invalidateQueries({ queryKey: keys.views(workspaceId, view.object) }),
    });
}

export function useUpdateView(workspaceId: string, object: RecordObject) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: { viewId: string } & UpdateViewInput) => {
            const { viewId, ...rest } = input;
            return views.update(workspaceId, viewId, rest);
        },
        onSuccess: () => client.invalidateQueries({ queryKey: keys.views(workspaceId, object) }),
    });
}

export function useDeleteView(workspaceId: string, object: RecordObject) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (viewId: string) => views.remove(workspaceId, viewId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.views(workspaceId, object) }),
    });
}

/** Global search narrowed to some objects; nothing is asked until there is something to ask. */
export function useSearch(workspaceId: string, q: string, objects: readonly RecordObject[], limit?: number) {
    const term = q.trim();
    return useQuery({
        queryKey: [...keys.search(workspaceId, term, objects.join(',')), limit ?? 0] as const,
        queryFn: ({ signal }) => search.run(workspaceId, { q: term, objects, limit }, signal),
        enabled: term.length > 0,
        staleTime: 10_000,
    });
}

/**
 * Display names for the records a page shows by id (a person row's company). One cached read per
 * distinct id, deduplicated with the record pages' own reads. The list API carries the id only,
 * and no route takes many ids at once — when one does, this hook is the one place that changes.
 */
export function useRecordNames(workspaceId: string, object: 'company' | 'person', ids: readonly string[]) {
    const unique = [...new Set(ids)];
    const results = useQueries({
        queries: unique.map((id) => ({
            queryKey: keys.record(workspaceId, object, id),
            queryFn: ({ signal }: { signal: AbortSignal }) => recordEndpoints[object].get(workspaceId, id, signal),
            staleTime: 5 * 60_000,
        })),
    });
    const names = new Map<string, string>();
    results.forEach((result, i) => {
        const view = result.data as PersonView | CompanyView | undefined;
        const id = unique[i];
        if (!view || !id) return;
        names.set(id, 'name' in view ? view.name : `${view.nameFirst} ${view.nameLast}`.trim());
    });
    return names;
}

/** Creates a person or a company; every list of that object refetches. */
export function useCreateRecord<O extends 'person' | 'company'>(workspaceId: string, object: O) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: RecordInputOf<O>) =>
            recordEndpoints[object].create(workspaceId, input as never) as Promise<RecordViewOf<O>>,
        onSuccess: () => client.invalidateQueries({ queryKey: keys.records(workspaceId, object) }),
    });
}

/** What a change to many records came to: those the API refused, with the reason for each. */
export interface BulkResult {
    succeeded: number;
    failed: { id: string; error: unknown }[];
}

/** How many of a bulk change's requests are in flight at once — the browser's per-host budget. */
export const BULK_CONCURRENCY = 6;

/** Runs `task` over `items`, at most `limit` at a time, settling every one. */
async function settleAll<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>) {
    const results: PromiseSettledResult<R>[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            try {
                results[index] = { status: 'fulfilled', value: await task(items[index] as T) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * The same change to many records — one request each, `BULK_CONCURRENCY` at a time; there is no
 * bulk route. A refusal of one does not stop the others: the result names what failed so the page
 * can say so.
 */
export function useBulkChange<O extends 'person' | 'company'>(workspaceId: string, object: O) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: async (input: {
            ids: readonly string[];
            patch: RecordInputOf<O> | 'delete';
        }): Promise<BulkResult> => {
            const endpoint = recordEndpoints[object];
            const outcomes = await settleAll<string, unknown>(input.ids, BULK_CONCURRENCY, (id) =>
                input.patch === 'delete'
                    ? endpoint.remove(workspaceId, id)
                    : endpoint.update(workspaceId, id, input.patch as never),
            );
            const failed = outcomes.flatMap((o, i) =>
                o.status === 'rejected' ? [{ id: input.ids[i] ?? '', error: o.reason as unknown }] : [],
            );
            return { succeeded: outcomes.length - failed.length, failed };
        },
        onSettled: () => client.invalidateQueries({ queryKey: keys.records(workspaceId, object) }),
    });
}
