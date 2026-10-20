import type { PausedMailboxView, ReputationSettings } from '@bylinecrm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';

/** Sender-reputation thresholds (REP-1, #204): read by reviewers, set by admins. */

const keys = {
    settings: (workspaceId: string) => ['w', workspaceId, 'reputation', 'settings'] as const,
    paused: (workspaceId: string) => ['w', workspaceId, 'reputation', 'paused'] as const,
};

export const reputation = {
    settings: (workspaceId: string, signal?: AbortSignal) =>
        request<ReputationSettings>('GET', workspacePath(workspaceId, '/reputation/settings'), { signal }),
    updateSettings: (workspaceId: string, input: ReputationSettings) =>
        request<ReputationSettings>('PUT', workspacePath(workspaceId, '/reputation/settings'), { body: input }),
    paused: (workspaceId: string, signal?: AbortSignal) =>
        request<PausedMailboxView[]>('GET', workspacePath(workspaceId, '/reputation/paused-mailboxes'), { signal }),
    resume: (workspaceId: string, mailboxId: string, note: string) =>
        request<PausedMailboxView[]>(
            'POST',
            workspacePath(workspaceId, `/reputation/paused-mailboxes/${mailboxId}/resume`),
            { body: { note } },
        ),
};

/** REP-2: mailboxes paused by the reply-rate floor or the spam-rate kill switch (reviewers). */
export function usePausedMailboxes(workspaceId: string) {
    return useQuery({
        queryKey: keys.paused(workspaceId),
        queryFn: ({ signal }) => reputation.paused(workspaceId, signal),
    });
}

export function useResumeMailbox(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ mailboxId, note }: { mailboxId: string; note: string }) =>
            reputation.resume(workspaceId, mailboxId, note),
        onSuccess: (list) => client.setQueryData(keys.paused(workspaceId), list),
    });
}

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
