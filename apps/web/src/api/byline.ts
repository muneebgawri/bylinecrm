import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import type { BylineSettingsView, PutBylineSettingsInput } from './types';

/**
 * The workspace's BylineAI link (BYL-1, an admin's): the secret BylineAI signs lead deliveries with, and the members
 * leads at unowned companies are dealt to.
 */

const key = (workspaceId: string) => ['w', workspaceId, 'integrations', 'byline'] as const;

const byline = {
    get: (workspaceId: string, signal?: AbortSignal) =>
        request<BylineSettingsView>('GET', workspacePath(workspaceId, '/integrations/byline'), { signal }),
    put: (workspaceId: string, input: PutBylineSettingsInput) =>
        request<BylineSettingsView>('PUT', workspacePath(workspaceId, '/integrations/byline'), { body: input }),
    remove: (workspaceId: string) => request<void>('DELETE', workspacePath(workspaceId, '/integrations/byline')),
};

export const useBylineSettings = (workspaceId: string) =>
    useQuery({ queryKey: key(workspaceId), queryFn: ({ signal }) => byline.get(workspaceId, signal) });

function useBylineWrite<I>(workspaceId: string, write: (input: I) => Promise<BylineSettingsView | void>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: (view) =>
            view
                ? client.setQueryData(key(workspaceId), view)
                : client.invalidateQueries({ queryKey: key(workspaceId) }),
    });
}

export const usePutByline = (workspaceId: string) =>
    useBylineWrite(workspaceId, (input: PutBylineSettingsInput) => byline.put(workspaceId, input));
export const useRemoveByline = (workspaceId: string) => useBylineWrite(workspaceId, () => byline.remove(workspaceId));
