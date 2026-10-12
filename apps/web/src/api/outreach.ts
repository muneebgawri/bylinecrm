import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import { keys } from './queries';
import type { RegionPolicyChangeView, RegionPolicyEntryView, SetRegionPolicyInput } from './types';

/**
 * Outreach compliance (P3-3, FR-CRMS-12): the workspace's region policy and its change history (#141).
 * Apart from `queries.ts` so it loads with the settings chunk (FR-CRMS-UI-10, #131).
 */
export const regionPolicy = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<RegionPolicyEntryView[]>('GET', workspacePath(workspaceId, '/outreach/region-policy'), { signal }),
    changes: (workspaceId: string, signal?: AbortSignal) =>
        request<RegionPolicyChangeView[]>('GET', workspacePath(workspaceId, '/outreach/region-policy/changes'), {
            signal,
        }),
    set: (workspaceId: string, input: SetRegionPolicyInput) =>
        request<RegionPolicyEntryView[]>('PUT', workspacePath(workspaceId, '/outreach/region-policy'), { body: input }),
};

export const useRegionPolicy = (workspaceId: string) =>
    useQuery({
        queryKey: [...keys.regionPolicy(workspaceId), 'entries'],
        queryFn: ({ signal }) => regionPolicy.list(workspaceId, signal),
    });

export const useRegionPolicyChanges = (workspaceId: string) =>
    useQuery({
        queryKey: [...keys.regionPolicy(workspaceId), 'changes'],
        queryFn: ({ signal }) => regionPolicy.changes(workspaceId, signal),
    });

export function useSetRegionPolicy(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: SetRegionPolicyInput) => regionPolicy.set(workspaceId, input),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.regionPolicy(workspaceId) }),
    });
}
