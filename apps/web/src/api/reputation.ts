import type { ReputationSettings, ReputationSettingsView } from '@bylinecrm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';

/** Sender-reputation thresholds (REP-1, #204): read by reviewers, set by admins. */

const keys = {
    settings: (workspaceId: string) => ['w', workspaceId, 'reputation', 'settings'] as const,
};

export const reputation = {
    settings: (workspaceId: string, signal?: AbortSignal) =>
        request<ReputationSettingsView>('GET', workspacePath(workspaceId, '/reputation/settings'), { signal }),
    updateSettings: (workspaceId: string, input: ReputationSettings) =>
        request<ReputationSettingsView>('PUT', workspacePath(workspaceId, '/reputation/settings'), { body: input }),
};

export function useReputationSettings(workspaceId: string, enabled = true) {
    return useQuery({
        queryKey: keys.settings(workspaceId),
        queryFn: ({ signal }) => reputation.settings(workspaceId, signal),
        enabled,
    });
}

export function useUpdateReputationSettings(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: ReputationSettings) => reputation.updateSettings(workspaceId, input),
        onSuccess: (saved) => client.setQueryData(keys.settings(workspaceId), saved),
    });
}
