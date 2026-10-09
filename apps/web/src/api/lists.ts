import type { RecordObject } from '@bylinecrm/shared';
import {
    useInfiniteQuery,
    useMutation,
    useQueries,
    useQuery,
    useQueryClient,
    type QueryClient,
} from '@tanstack/react-query';
import { search, type ListParams } from './endpoints';
import { keys, recordEndpoints, type RecordInputOf, type RecordPageOf, type RecordViewOf } from './queries';
import type { BulkInput, BulkResultView } from './types';

/**
 * The query hooks only the lazily loaded data views use (P1-UI-2, P1-UI-6): a list read by cursor,
 * the counts on the view tabs, search, create and bulk change. Kept out of `queries.ts`, which the
 * shell imports, so they load with the pages that use them rather than in every first paint (the
 * `.size-limit.json` budget). The cache keys stay in `queries.ts` — one place for the cache's shape.
 */

// ─────────────────────────────────────────────────────────────────────────────

/** The query a list page sends, minus the cursor the pages supply. */
export type ListQuery = Omit<ListParams, 'cursor'>;

/**
 * A list read by cursor, page after page, as the table scrolls (desktop) or the cards reach the
 * end (phone). Every page carries the whole set's `total` (P1-4a), so the first page already knows
 * "page 1 of 9".
 */
export function useRecordPages<O extends RecordObject>(workspaceId: string, object: O, params: ListQuery) {
    return useInfiniteQuery({
        queryKey: [...keys.records(workspaceId, object), 'pages', params] as const,
        queryFn: ({ pageParam, signal }) =>
            recordEndpoints[object].list(workspaceId, { ...params, cursor: pageParam }, signal) as Promise<
                RecordPageOf<O>
            >,
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
    });
}

/** A count the view tabs show: the total and whether it is exact ("10,000+"). */
export interface ListCount {
    total: number;
    exact: boolean;
}

/**
 * The size of each saved view, for its tab: one `limit=1` read per view (the API counts the whole
 * set on every page). The tab the page is showing takes its count from the page's own query, so it
 * is not asked twice. Kept fresh for a minute — a tab's count is a guide, the open list is the truth.
 */
export function useViewCounts(workspaceId: string, object: RecordObject, viewIds: readonly (string | undefined)[]) {
    const results = useQueries({
        queries: viewIds.map((view) => ({
            queryKey: [...keys.records(workspaceId, object), 'count', view ?? ''] as const,
            queryFn: ({ signal }: { signal: AbortSignal }) =>
                recordEndpoints[object].list(workspaceId, { view, limit: 1 }, signal),
            staleTime: 60_000,
        })),
    });
    const counts = new Map<string | undefined, ListCount>();
    results.forEach((result, i) => {
        if (result.data) counts.set(viewIds[i], { total: result.data.total, exact: result.data.totalIsExact });
    });
    return counts;
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

/** Creates a person or a company; every list of that object refetches. */
export function useCreateRecord<O extends 'person' | 'company'>(workspaceId: string, object: O) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: RecordInputOf<O>) =>
            recordEndpoints[object].create(workspaceId, input as never) as Promise<RecordViewOf<O>>,
        onSuccess: () => client.invalidateQueries({ queryKey: keys.records(workspaceId, object) }),
    });
}

/** Every pipeline's boards in a workspace — what a change to many deals can have moved. */
function invalidateBoards(client: QueryClient, workspaceId: string) {
    return client.invalidateQueries({
        predicate: ({ queryKey }) =>
            queryKey[0] === 'w' &&
            queryKey[1] === workspaceId &&
            queryKey[2] === 'pipelines' &&
            queryKey[4] === 'board',
    });
}

/**
 * One action over many records (P1-4a's `POST …/bulk`): one request, one result per record in the
 * order named. The API runs each record through its single-record write, so a refusal of one does
 * not stop the others and a record already as asked comes back `unchanged`.
 */
export function useBulkChange(workspaceId: string, object: RecordObject) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: BulkInput): Promise<BulkResultView> => recordEndpoints[object].bulk(workspaceId, input),
        onSettled: () => {
            void client.invalidateQueries({ queryKey: keys.records(workspaceId, object) });
            if (object === 'opportunity') void invalidateBoards(client, workspaceId);
        },
    });
}
