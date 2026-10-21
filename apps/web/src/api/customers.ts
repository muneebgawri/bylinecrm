import type { ContactStatus, CustomerExclusionSettingsView, OutreachExclusionView } from '@bylinecrm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import { keys } from './queries';
import type { PersonView } from './types';

/**
 * #242: a person's contact status set by hand, and won deals as customers — the outreach exclusions (with the ones a
 * reopened or refunded deal flagged for review) and the admin setting for what a won deal excludes.
 */
export const customers = {
    setContactStatus: (workspaceId: string, personId: string, status: ContactStatus | null) =>
        request<PersonView>('PUT', workspacePath(workspaceId, `/people/${personId}/contact-status`), {
            body: { status },
        }),
    exclusions: (workspaceId: string, signal?: AbortSignal) =>
        request<OutreachExclusionView[]>('GET', workspacePath(workspaceId, '/outreach/exclusions'), { signal }),
    dismissReview: (workspaceId: string, id: string) =>
        request<OutreachExclusionView>(
            'POST',
            workspacePath(workspaceId, `/outreach/exclusions/${id}/dismiss-review`),
            {},
        ),
    removeExclusion: (workspaceId: string, id: string, note: string) =>
        request<void>('POST', workspacePath(workspaceId, `/outreach/exclusions/${id}/remove`), { body: { note } }),
    settings: (workspaceId: string, signal?: AbortSignal) =>
        request<CustomerExclusionSettingsView>(
            'GET',
            workspacePath(workspaceId, '/outreach/customer-exclusion-settings'),
            { signal },
        ),
    setSettings: (workspaceId: string, input: CustomerExclusionSettingsView) =>
        request<CustomerExclusionSettingsView>(
            'PUT',
            workspacePath(workspaceId, '/outreach/customer-exclusion-settings'),
            { body: input },
        ),
};

export function useSetContactStatus(workspaceId: string, personId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (status: ContactStatus | null) => customers.setContactStatus(workspaceId, personId, status),
        onSuccess: (view) => client.setQueryData(keys.record(workspaceId, 'person', personId), view),
        onSettled: () => void client.invalidateQueries({ queryKey: keys.records(workspaceId, 'person'), exact: false }),
    });
}

const exclusionsKey = (workspaceId: string) => ['w', workspaceId, 'outreach', 'exclusions'] as const;
const settingsKey = (workspaceId: string) => ['w', workspaceId, 'outreach', 'customer-exclusion-settings'] as const;

export const useExclusions = (workspaceId: string) =>
    useQuery({
        queryKey: exclusionsKey(workspaceId),
        queryFn: ({ signal }) => customers.exclusions(workspaceId, signal),
    });

export function useDismissReview(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => customers.dismissReview(workspaceId, id),
        onSettled: () => void client.invalidateQueries({ queryKey: exclusionsKey(workspaceId) }),
    });
}

export function useRemoveExclusion(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ id, note }: { id: string; note: string }) => customers.removeExclusion(workspaceId, id, note),
        onSettled: () => void client.invalidateQueries({ queryKey: exclusionsKey(workspaceId) }),
    });
}

export const useCustomerExclusionSettings = (workspaceId: string) =>
    useQuery({
        queryKey: settingsKey(workspaceId),
        queryFn: ({ signal }) => customers.settings(workspaceId, signal),
    });

export function useSetCustomerExclusionSettings(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CustomerExclusionSettingsView) => customers.setSettings(workspaceId, input),
        onSuccess: (view) => client.setQueryData(settingsKey(workspaceId), view),
    });
}
