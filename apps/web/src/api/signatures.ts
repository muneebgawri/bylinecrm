import type {
    ImportedSignature,
    MailboxSignatureInput,
    MailboxSignatureView,
    SignatureProfileInput,
    SignatureProfileView,
    SignatureSettingsInput,
    SignatureSettingsView,
    SlotlineEventTypeView,
    WorkspaceLogoView,
} from '@bylinecrm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';

/**
 * Email signatures (#193): the workspace's settings and logo, each mailbox's signature, and a member's
 * signature details. Apart from `queries.ts`, so they load with Settings and the composer that use them.
 */

const base = (workspaceId: string) => ['w', workspaceId, 'signatures'] as const;
const keys = {
    settings: (workspaceId: string) => [...base(workspaceId), 'settings'] as const,
    mailbox: (workspaceId: string, mailboxId: string) => [...base(workspaceId), 'mailbox', mailboxId] as const,
    profile: (workspaceId: string, memberId: string) => [...base(workspaceId), 'profile', memberId] as const,
    profiles: (workspaceId: string) => [...base(workspaceId), 'profiles'] as const,
    eventTypes: (workspaceId: string, memberId: string) => [...base(workspaceId), 'event-types', memberId] as const,
};

export const signatures = {
    putSlotlineKey: (workspaceId: string, memberId: string, apiKey: string) =>
        request<SignatureProfileView>('PUT', workspacePath(workspaceId, `/members/${memberId}/slotline-key`), {
            body: { apiKey },
        }),
    removeSlotlineKey: (workspaceId: string, memberId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/members/${memberId}/slotline-key`)),
    slotlineEventTypes: (workspaceId: string, memberId: string, signal?: AbortSignal) =>
        request<SlotlineEventTypeView[]>(
            'GET',
            workspacePath(workspaceId, `/members/${memberId}/slotline/event-types`),
            {
                signal,
            },
        ),
    pickSlotlineEvent: (workspaceId: string, memberId: string, slug: string | null) =>
        request<SignatureProfileView>('PUT', workspacePath(workspaceId, `/members/${memberId}/slotline-event`), {
            body: { slug },
        }),
    settings: (workspaceId: string, signal?: AbortSignal) =>
        request<SignatureSettingsView>('GET', workspacePath(workspaceId, '/settings/signatures'), { signal }),
    putSettings: (workspaceId: string, input: SignatureSettingsInput) =>
        request<SignatureSettingsView>('PUT', workspacePath(workspaceId, '/settings/signatures'), { body: input }),
    uploadLogo: (workspaceId: string, file: File) => {
        const body = new FormData();
        body.append('file', file);
        return request<WorkspaceLogoView>('POST', workspacePath(workspaceId, '/settings/signatures/logo'), { body });
    },
    removeLogo: (workspaceId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, '/settings/signatures/logo')),
    mailbox: (workspaceId: string, mailboxId: string, signal?: AbortSignal) =>
        request<MailboxSignatureView>('GET', workspacePath(workspaceId, `/mailboxes/${mailboxId}/signature`), {
            signal,
        }),
    putMailbox: (workspaceId: string, mailboxId: string, input: MailboxSignatureInput) =>
        request<MailboxSignatureView>('PUT', workspacePath(workspaceId, `/mailboxes/${mailboxId}/signature`), {
            body: input,
        }),
    importFromGmail: (workspaceId: string, mailboxId: string) =>
        request<ImportedSignature>('POST', workspacePath(workspaceId, `/mailboxes/${mailboxId}/signature/import`)),
    profiles: (workspaceId: string, signal?: AbortSignal) =>
        request<SignatureProfileView[]>('GET', workspacePath(workspaceId, '/members/signature-profiles'), { signal }),
    profile: (workspaceId: string, memberId: string, signal?: AbortSignal) =>
        request<SignatureProfileView>('GET', workspacePath(workspaceId, `/members/${memberId}/signature-profile`), {
            signal,
        }),
    putProfile: (workspaceId: string, memberId: string, input: SignatureProfileInput) =>
        request<SignatureProfileView>('PUT', workspacePath(workspaceId, `/members/${memberId}/signature-profile`), {
            body: input,
        }),
};

export function useSignatureSettings(workspaceId: string) {
    return useQuery({
        queryKey: keys.settings(workspaceId),
        queryFn: ({ signal }) => signatures.settings(workspaceId, signal),
    });
}

export function usePutSignatureSettings(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: SignatureSettingsInput) => signatures.putSettings(workspaceId, input),
        // Every mailbox's effective signature may follow the default.
        onSuccess: (saved) => {
            client.setQueryData(keys.settings(workspaceId), saved);
            void client.invalidateQueries({ queryKey: [...base(workspaceId), 'mailbox'] });
        },
    });
}

/** Uploads or removes the logo (`null`). */
export function useWorkspaceLogo(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: async (file: File | null): Promise<void> => {
            if (file) await signatures.uploadLogo(workspaceId, file);
            else await signatures.removeLogo(workspaceId);
        },
        onSuccess: () => client.invalidateQueries({ queryKey: keys.settings(workspaceId) }),
    });
}

export function useMailboxSignature(workspaceId: string, mailboxId: string | null) {
    return useQuery({
        queryKey: keys.mailbox(workspaceId, mailboxId ?? ''),
        queryFn: ({ signal }) => signatures.mailbox(workspaceId, mailboxId!, signal),
        enabled: mailboxId !== null && mailboxId !== '',
    });
}

export function usePutMailboxSignature(workspaceId: string, mailboxId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: MailboxSignatureInput) => signatures.putMailbox(workspaceId, mailboxId, input),
        onSuccess: (saved) => client.setQueryData(keys.mailbox(workspaceId, mailboxId), saved),
    });
}

export function useImportSignature(workspaceId: string, mailboxId: string) {
    return useMutation({ mutationFn: () => signatures.importFromGmail(workspaceId, mailboxId) });
}

export function useSignatureProfile(workspaceId: string, memberId: string | null | undefined) {
    return useQuery({
        queryKey: keys.profile(workspaceId, memberId ?? ''),
        queryFn: ({ signal }) => signatures.profile(workspaceId, memberId!, signal),
        enabled: !!memberId,
    });
}

/** Every member's details: an admin's list (#193). */
export function useSignatureProfiles(workspaceId: string) {
    return useQuery({
        queryKey: keys.profiles(workspaceId),
        queryFn: ({ signal }) => signatures.profiles(workspaceId, signal),
    });
}

export function usePutSignatureProfile(workspaceId: string, memberId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: SignatureProfileInput) => signatures.putProfile(workspaceId, memberId, input),
        onSuccess: (saved) => {
            client.setQueryData(keys.profile(workspaceId, memberId), saved);
            void client.invalidateQueries({ queryKey: keys.profiles(workspaceId) });
        },
    });
}

/** Every event type on the member's own Slotline account, hidden ones too (#196); asked only while a key is set. */
export function useSlotlineEventTypes(workspaceId: string, memberId: string, enabled: boolean) {
    return useQuery({
        queryKey: keys.eventTypes(workspaceId, memberId),
        queryFn: ({ signal }) => signatures.slotlineEventTypes(workspaceId, memberId, signal),
        enabled,
        retry: false,
    });
}

/** Connects (`apiKey`) or disconnects (`null`) the member's own Slotline account (#196). */
export function useSlotlineKey(workspaceId: string, memberId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: async (apiKey: string | null) => {
            if (apiKey !== null) return signatures.putSlotlineKey(workspaceId, memberId, apiKey);
            await signatures.removeSlotlineKey(workspaceId, memberId);
            return null;
        },
        onSuccess: (saved) => {
            if (saved) client.setQueryData(keys.profile(workspaceId, memberId), saved);
            else void client.invalidateQueries({ queryKey: keys.profile(workspaceId, memberId) });
            void client.removeQueries({ queryKey: keys.eventTypes(workspaceId, memberId) });
        },
    });
}

export function usePickSlotlineEvent(workspaceId: string, memberId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (slug: string | null) => signatures.pickSlotlineEvent(workspaceId, memberId, slug),
        onSuccess: (saved) => client.setQueryData(keys.profile(workspaceId, memberId), saved),
    });
}
