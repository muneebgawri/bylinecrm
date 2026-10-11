import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import { keys } from './queries';
import type {
    ApiKeyView,
    CreateApiKeyInput,
    CreateInviteInput,
    CreateRoleInput,
    InviteView,
    MemberView,
    RoleView,
    UpdateRoleInput,
} from './types';

/**
 * The team screens' reads and writes: members, roles, API keys and invitations. They live apart from
 * `queries.ts` so they load with the settings chunk, not with every page (FR-CRMS-UI-10, #131).
 */

export const members = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<MemberView[]>('GET', workspacePath(workspaceId, '/members'), { signal }),
    setRole: (workspaceId: string, memberId: string, roleId: string) =>
        request<void>('PATCH', workspacePath(workspaceId, `/members/${memberId}/role`), { body: { roleId } }),
    remove: (workspaceId: string, memberId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/members/${memberId}`)),
};

export const roles = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<RoleView[]>('GET', workspacePath(workspaceId, '/roles'), { signal }),
    create: (workspaceId: string, input: CreateRoleInput) =>
        request<RoleView>('POST', workspacePath(workspaceId, '/roles'), { body: input }),
    update: (workspaceId: string, roleId: string, input: UpdateRoleInput) =>
        request<RoleView>('PATCH', workspacePath(workspaceId, `/roles/${roleId}`), { body: input }),
    remove: (workspaceId: string, roleId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/roles/${roleId}`)),
};

export const apiKeys = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<ApiKeyView[]>('GET', workspacePath(workspaceId, '/api-keys'), { signal }),
    /** The secret in the response is shown once; the API does not keep it. */
    create: (workspaceId: string, input: CreateApiKeyInput) =>
        request<{ key: ApiKeyView; secret: string }>('POST', workspacePath(workspaceId, '/api-keys'), {
            body: input,
        }),
    revoke: (workspaceId: string, apiKeyId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/api-keys/${apiKeyId}`)),
};

export const invites = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<InviteView[]>('GET', workspacePath(workspaceId, '/invites'), { signal }),
    /** The token in the response is shown once so the admin can hand it on; the API keeps a hash. */
    create: (workspaceId: string, input: CreateInviteInput) =>
        request<{ invite: InviteView; token: string }>('POST', workspacePath(workspaceId, '/invites'), {
            body: input,
        }),
    revoke: (workspaceId: string, inviteId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/invites/${inviteId}`)),
};

export const useMembers = (workspaceId: string) =>
    useQuery({ queryKey: keys.members(workspaceId), queryFn: ({ signal }) => members.list(workspaceId, signal) });

export const useRoles = (workspaceId: string) =>
    useQuery({ queryKey: keys.roles(workspaceId), queryFn: ({ signal }) => roles.list(workspaceId, signal) });

export const useApiKeys = (workspaceId: string) =>
    useQuery({ queryKey: keys.apiKeys(workspaceId), queryFn: ({ signal }) => apiKeys.list(workspaceId, signal) });

export const useInvites = (workspaceId: string) =>
    useQuery({ queryKey: keys.invites(workspaceId), queryFn: ({ signal }) => invites.list(workspaceId, signal) });

export function useSetMemberRole(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: { memberId: string; roleId: string }) =>
            members.setRole(workspaceId, input.memberId, input.roleId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.members(workspaceId) }),
    });
}

export function useRemoveMember(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (memberId: string) => members.remove(workspaceId, memberId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.members(workspaceId) }),
    });
}

export function useCreateRole(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CreateRoleInput) => roles.create(workspaceId, input),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.roles(workspaceId) }),
    });
}

export function useUpdateRole(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ roleId, ...patch }: { roleId: string } & UpdateRoleInput) =>
            roles.update(workspaceId, roleId, patch),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.roles(workspaceId) }),
    });
}

export function useRemoveRole(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (roleId: string) => roles.remove(workspaceId, roleId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.roles(workspaceId) }),
    });
}

export function useCreateApiKey(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CreateApiKeyInput) => apiKeys.create(workspaceId, input),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.apiKeys(workspaceId) }),
    });
}

export function useRevokeApiKey(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (apiKeyId: string) => apiKeys.revoke(workspaceId, apiKeyId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.apiKeys(workspaceId) }),
    });
}

export function useCreateInvite(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CreateInviteInput) => invites.create(workspaceId, input),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.invites(workspaceId) }),
    });
}

export function useRevokeInvite(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (inviteId: string) => invites.revoke(workspaceId, inviteId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.invites(workspaceId) }),
    });
}
