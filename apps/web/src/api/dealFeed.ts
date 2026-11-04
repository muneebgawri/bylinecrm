import { useQuery } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import type { DealFeedView } from './types';

/**
 * The live deal feed: what the team is doing with deals, newest first, for everyone in the workspace. Headlines
 * only — a deal the caller may not open says so (`canOpen`).
 */

/** How often an open dashboard asks again. */
export const DEAL_FEED_POLL_MS = 20_000;

export const dealFeed = {
    latest: (workspaceId: string, signal?: AbortSignal) =>
        request<DealFeedView>('GET', workspacePath(workspaceId, '/deal-feed'), { signal }),
};

export function useDealFeed(workspaceId: string) {
    return useQuery({
        queryKey: ['w', workspaceId, 'deal-feed'] as const,
        queryFn: ({ signal }) => dealFeed.latest(workspaceId, signal),
        refetchInterval: DEAL_FEED_POLL_MS,
    });
}
