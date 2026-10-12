import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import { keys } from './queries';
import type {
    EmailVerificationSettingsView,
    PutTrackingDomainInput,
    PutVerificationSettingsInput,
    TrackingSettingsView,
    RegionPolicyChangeView,
    RegionPolicyEntryView,
    SetRegionPolicyInput,
} from './types';

/**
 * Outreach compliance (P3-3, FR-CRMS-12): the workspace's region policy and its change history (#141),
 * and how long an address's verification stands (P3-5, FR-CRMS-16). Apart from `queries.ts` so it
 * loads with the settings chunk (FR-CRMS-UI-10, #131).
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

export const verificationSettings = {
    get: (workspaceId: string, signal?: AbortSignal) =>
        request<EmailVerificationSettingsView>('GET', workspacePath(workspaceId, '/outreach/verification'), { signal }),
    put: (workspaceId: string, input: PutVerificationSettingsInput) =>
        request<EmailVerificationSettingsView>('PUT', workspacePath(workspaceId, '/outreach/verification'), {
            body: input,
        }),
};

export const useVerificationSettings = (workspaceId: string) =>
    useQuery({
        queryKey: keys.verificationSettings(workspaceId),
        queryFn: ({ signal }) => verificationSettings.get(workspaceId, signal),
    });

export function usePutVerificationSettings(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: PutVerificationSettingsInput) => verificationSettings.put(workspaceId, input),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.verificationSettings(workspaceId) }),
    });
}

// ---- Tracking (P3-4, FR-CRMS-8) ---------------------------------------------------------------

export const trackingSettings = {
    get: (workspaceId: string, signal?: AbortSignal) =>
        request<TrackingSettingsView>('GET', workspacePath(workspaceId, '/tracking/domain'), { signal }),
    put: (workspaceId: string, input: PutTrackingDomainInput) =>
        request<TrackingSettingsView>('PUT', workspacePath(workspaceId, '/tracking/domain'), { body: input }),
    remove: (workspaceId: string) => request<void>('DELETE', workspacePath(workspaceId, '/tracking/domain')),
    check: (workspaceId: string) =>
        request<TrackingSettingsView>('POST', workspacePath(workspaceId, '/tracking/domain/check')),
};

export const useTrackingSettings = (workspaceId: string) =>
    useQuery({
        queryKey: keys.trackingSettings(workspaceId),
        queryFn: ({ signal }) => trackingSettings.get(workspaceId, signal),
    });

export function usePutTrackingDomain(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: PutTrackingDomainInput) => trackingSettings.put(workspaceId, input),
        onSuccess: (data) => client.setQueryData(keys.trackingSettings(workspaceId), data),
    });
}

export function useCheckTrackingDomain(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: () => trackingSettings.check(workspaceId),
        onSuccess: (data) => client.setQueryData(keys.trackingSettings(workspaceId), data),
    });
}

export function useRemoveTrackingDomain(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: () => trackingSettings.remove(workspaceId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.trackingSettings(workspaceId) }),
    });
}
