import { TODAY_SECTION_PATHS, type TodaySection } from '@bylinecrm/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { request } from './client';
import { query, workspacePath } from './endpoints';
import { keys } from './queries';
import type { TodaySectionView, TodayView } from './types';

/**
 * Today (#360): one member's day — the overview (every section's count and first page) and a section's later
 * pages. The member is the caller unless an admin names someone; "today" ends at the reader's own midnight.
 */

/** The reader's time zone, as the browser knows it. */
export function readerTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export interface TodayParams {
    memberId?: string | undefined;
    timeZone: string;
    limit?: number | undefined;
}

const base = keys.today;
export const todayKeys = {
    all: base,
    overview: (workspaceId: string, params: TodayParams) => [...base(workspaceId), 'overview', params] as const,
    section: (workspaceId: string, section: TodaySection, params: TodayParams) =>
        [...base(workspaceId), section, params] as const,
};

export const today = {
    overview: (workspaceId: string, params: TodayParams, signal?: AbortSignal) =>
        request<TodayView>('GET', workspacePath(workspaceId, `/today${query({ ...params })}`), { signal }),
    section: <S extends TodaySection>(
        workspaceId: string,
        section: S,
        params: TodayParams & { cursor: string },
        signal?: AbortSignal,
    ) =>
        request<TodaySectionView<S>>(
            'GET',
            workspacePath(workspaceId, `/today/${TODAY_SECTION_PATHS[section]}${query({ ...params })}`),
            { signal },
        ),
};

export function useToday(workspaceId: string, params: TodayParams) {
    return useQuery({
        queryKey: todayKeys.overview(workspaceId, params),
        queryFn: ({ signal }) => today.overview(workspaceId, params, signal),
    });
}

/**
 * A section's pages after the overview's first: the first "Show more" turns it on (from the overview's cursor),
 * each later one asks for the page after the last.
 */
export function useTodayMore<S extends TodaySection>(
    workspaceId: string,
    section: S,
    params: TodayParams,
    firstCursor: string | null,
    enabled: boolean,
) {
    return useInfiniteQuery({
        queryKey: [...todayKeys.section(workspaceId, section, params), firstCursor] as const,
        queryFn: ({ pageParam, signal }) =>
            today.section(workspaceId, section, { ...params, cursor: pageParam }, signal),
        initialPageParam: firstCursor ?? '',
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        enabled: enabled && firstCursor !== null,
    });
}
