import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isClientError } from './client';
import { apiKeys, auth, invites, me, members, roles } from './endpoints';
import type {
    CreateApiKeyInput,
    CreateInviteInput,
    CreateRoleInput,
    LoginInput,
    SignupInput,
    UpdateRoleInput,
} from './types';

/**
 * Query keys, once. A key is an array whose first element names the resource and whose later
 * elements scope it; invalidation by prefix (`keys.roles(id)` after a role mutation) follows.
 */
export const keys = {
    me: ['me'] as const,
    workspaces: ['me', 'workspaces'] as const,
    members: (workspaceId: string) => ['w', workspaceId, 'members'] as const,
    roles: (workspaceId: string) => ['w', workspaceId, 'roles'] as const,
    apiKeys: (workspaceId: string) => ['w', workspaceId, 'api-keys'] as const,
    invites: (workspaceId: string) => ['w', workspaceId, 'invites'] as const,
    providers: ['auth', 'providers'] as const,
};

/** The app's one QueryClient. A 4xx is the API's answer, so it is not retried. */
export function createQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                retry: (failureCount, error) => !isClientError(error) && failureCount < 2,
                staleTime: 30_000,
                refetchOnWindowFocus: false,
            },
            mutations: { retry: false },
        },
    });
}

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: ({ signal }) => me.profile(signal) });
export const useWorkspaces = () =>
    useQuery({ queryKey: keys.workspaces, queryFn: ({ signal }) => me.workspaces(signal) });
export const useProviders = () =>
    useQuery({ queryKey: keys.providers, queryFn: () => auth.providers(), staleTime: Infinity });

export const useMembers = (workspaceId: string) =>
    useQuery({ queryKey: keys.members(workspaceId), queryFn: ({ signal }) => members.list(workspaceId, signal) });
export const useRoles = (workspaceId: string) =>
    useQuery({ queryKey: keys.roles(workspaceId), queryFn: ({ signal }) => roles.list(workspaceId, signal) });
export const useApiKeys = (workspaceId: string) =>
    useQuery({ queryKey: keys.apiKeys(workspaceId), queryFn: ({ signal }) => apiKeys.list(workspaceId, signal) });
export const useInvites = (workspaceId: string) =>
    useQuery({ queryKey: keys.invites(workspaceId), queryFn: ({ signal }) => invites.list(workspaceId, signal) });

/** Sign-in and sign-up replace whatever the cache held about the previous person. */
export function useSignup() {
    const client = useQueryClient();
    return useMutation({ mutationFn: (input: SignupInput) => auth.signup(input), onSuccess: () => client.clear() });
}

export function useLogin() {
    const client = useQueryClient();
    return useMutation({ mutationFn: (input: LoginInput) => auth.login(input), onSuccess: () => client.clear() });
}

export function useLogout() {
    const client = useQueryClient();
    return useMutation({ mutationFn: () => auth.logout(), onSettled: () => client.clear() });
}

export function useCreateWorkspace() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (name: string) => me.createWorkspace(name),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.workspaces }),
    });
}

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
        mutationFn: (input: { roleId: string } & UpdateRoleInput) =>
            roles.update(workspaceId, input.roleId, { name: input.name, capabilities: input.capabilities }),
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
