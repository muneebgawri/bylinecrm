import type { RecordObject, RecordTarget, TaskStatus } from '@bylinecrm/shared';
import { QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isClientError } from './client';
import {
    apiKeys,
    attachments,
    auth,
    companies,
    customFields,
    invites,
    me,
    members,
    membersSummary,
    membership,
    notes,
    opportunities,
    people,
    pipelines,
    roles,
    tasks,
    timeline,
} from './endpoints';
import type {
    CompanyInput,
    CompanyView,
    CreateApiKeyInput,
    CreateInviteInput,
    CreateRoleInput,
    LoginInput,
    MoveDealInput,
    NoteInput,
    OpportunityInput,
    OpportunityView,
    PersonInput,
    PersonView,
    SignupInput,
    TaskInput,
    UpdateRoleInput,
} from './types';

/**
 * Query keys, once. A key is an array whose first element names the resource and whose later
 * elements scope it; invalidation by prefix (`keys.roles(id)` after a role mutation) follows.
 */
export const keys = {
    me: ['me'] as const,
    workspaces: ['me', 'workspaces'] as const,
    membership: (workspaceId: string) => ['w', workspaceId, 'me'] as const,
    members: (workspaceId: string) => ['w', workspaceId, 'members'] as const,
    roles: (workspaceId: string) => ['w', workspaceId, 'roles'] as const,
    apiKeys: (workspaceId: string) => ['w', workspaceId, 'api-keys'] as const,
    invites: (workspaceId: string) => ['w', workspaceId, 'invites'] as const,
    providers: ['auth', 'providers'] as const,
    membersSummary: (workspaceId: string) => ['w', workspaceId, 'members-summary'] as const,
    record: (workspaceId: string, object: RecordObject, id: string) => ['w', workspaceId, object, id] as const,
    records: (workspaceId: string, object: RecordObject) => ['w', workspaceId, object] as const,
    customFields: (workspaceId: string, object: RecordObject) => ['w', workspaceId, 'custom-fields', object] as const,
    pipelines: (workspaceId: string) => ['w', workspaceId, 'pipelines'] as const,
    notes: (workspaceId: string, target: RecordTarget) => ['w', workspaceId, 'notes', target.type, target.id] as const,
    tasks: (workspaceId: string, target: RecordTarget) => ['w', workspaceId, 'tasks', target.type, target.id] as const,
    attachments: (workspaceId: string, target: RecordTarget) =>
        ['w', workspaceId, 'attachments', target.type, target.id] as const,
    timeline: (workspaceId: string, target: RecordTarget, kinds: string | undefined) =>
        ['w', workspaceId, 'timeline', target.type, target.id, kinds ?? ''] as const,
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

/** The caller's standing in the workspace; `CapabilitiesProvider` is fed from this. */
export const useMembershipQuery = (workspaceId: string) =>
    useQuery({
        queryKey: keys.membership(workspaceId),
        queryFn: ({ signal }) => membership.me(workspaceId, signal),
    });
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

// ─────────────────────────────────────────────────────────────────────────────
// Records, notes, tasks, attachments, timeline (P1-UI-3).
// ─────────────────────────────────────────────────────────────────────────────

/** The three record objects' routes, picked by object so one hook serves every record page. */
const recordEndpoints = { person: people, company: companies, opportunity: opportunities } as const;
type RecordViewOf<O extends RecordObject> = O extends 'person'
    ? PersonView
    : O extends 'company'
      ? CompanyView
      : OpportunityView;
type RecordInputOf<O extends RecordObject> = O extends 'person'
    ? PersonInput
    : O extends 'company'
      ? CompanyInput
      : OpportunityInput;

export function useRecord<O extends RecordObject>(workspaceId: string, object: O, id: string) {
    return useQuery({
        queryKey: keys.record(workspaceId, object, id),
        queryFn: ({ signal }) => recordEndpoints[object].get(workspaceId, id, signal) as Promise<RecordViewOf<O>>,
    });
}

export function useRecordList<O extends RecordObject>(
    workspaceId: string,
    object: O,
    params: { q?: string; sort?: string; limit?: number } = {},
    enabled = true,
) {
    return useQuery({
        queryKey: [...keys.records(workspaceId, object), 'list', params] as const,
        queryFn: ({ signal }) =>
            recordEndpoints[object].list(workspaceId, params, signal) as Promise<{
                items: RecordViewOf<O>[];
                nextCursor: string | null;
            }>,
        enabled,
    });
}

/**
 * An inline edit's mutation: the cache shows the new value at once, the request follows, and a
 * refusal puts the old value back and surfaces the API's field error (FR-CRMS-UI-2). The record
 * list queries are invalidated so a table shows the change on return.
 */
export function usePatchRecord<O extends RecordObject>(workspaceId: string, object: O, id: string) {
    const client = useQueryClient();
    const key = keys.record(workspaceId, object, id);
    return useMutation({
        mutationFn: (patch: RecordInputOf<O>) =>
            recordEndpoints[object].update(workspaceId, id, patch as never) as Promise<RecordViewOf<O>>,
        onMutate: async (patch) => {
            await client.cancelQueries({ queryKey: key });
            const previous = client.getQueryData<RecordViewOf<O>>(key);
            if (previous) client.setQueryData<RecordViewOf<O>>(key, { ...previous, ...patch });
            return { previous };
        },
        onError: (_error, _patch, context) => {
            if (context?.previous) client.setQueryData(key, context.previous);
        },
        onSuccess: (view) => client.setQueryData(key, view),
        onSettled: () => {
            void client.invalidateQueries({ queryKey: keys.records(workspaceId, object), exact: false });
            void client.invalidateQueries({ queryKey: key });
        },
    });
}

export const useMembersSummary = (workspaceId: string) =>
    useQuery({
        queryKey: keys.membersSummary(workspaceId),
        queryFn: ({ signal }) => membersSummary.list(workspaceId, signal),
        staleTime: 5 * 60_000,
    });

export const useCustomFields = (workspaceId: string, object: RecordObject) =>
    useQuery({
        queryKey: keys.customFields(workspaceId, object),
        queryFn: ({ signal }) => customFields.list(workspaceId, object, signal),
        staleTime: 5 * 60_000,
    });

export const usePipeline = (workspaceId: string, pipelineId: string) =>
    useQuery({
        queryKey: [...keys.pipelines(workspaceId), pipelineId] as const,
        queryFn: ({ signal }) => pipelines.get(workspaceId, pipelineId, signal),
        staleTime: 5 * 60_000,
    });

export const useDealHistory = (workspaceId: string, id: string) =>
    useQuery({
        queryKey: [...keys.record(workspaceId, 'opportunity', id), 'history'] as const,
        queryFn: ({ signal }) => opportunities.history(workspaceId, id, signal),
    });

/** A stage move; the returned deal replaces the cached one and the deal's history and timeline refetch. */
export function useMoveDeal(workspaceId: string, id: string) {
    const client = useQueryClient();
    const key = keys.record(workspaceId, 'opportunity', id);
    return useMutation({
        mutationFn: (input: MoveDealInput) => opportunities.move(workspaceId, id, input),
        onSuccess: (result) => {
            client.setQueryData(key, result.deal);
            void client.invalidateQueries({ queryKey: [...key, 'history'] });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', 'opportunity', id] });
            void client.invalidateQueries({ queryKey: keys.records(workspaceId, 'opportunity'), exact: false });
        },
    });
}

export const useNotes = (workspaceId: string, target: RecordTarget) =>
    useInfiniteQuery({
        queryKey: keys.notes(workspaceId, target),
        queryFn: ({ pageParam, signal }) => notes.list(workspaceId, target, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });

export function useSaveNote(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    const invalidate = () => {
        void client.invalidateQueries({ queryKey: keys.notes(workspaceId, target) });
        void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
    };
    return useMutation({
        mutationFn: (input: { id?: string; title: string; body: NoteInput['body'] }) =>
            input.id
                ? notes.update(workspaceId, input.id, { title: input.title, body: input.body })
                : notes.create(workspaceId, { title: input.title, body: input.body, targets: [target] }),
        onSuccess: invalidate,
    });
}

export function useDeleteNote(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => notes.remove(workspaceId, id),
        onSuccess: () => {
            void client.invalidateQueries({ queryKey: keys.notes(workspaceId, target) });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
        },
    });
}

export const useTasks = (workspaceId: string, target: RecordTarget, status?: TaskStatus) =>
    useInfiniteQuery({
        queryKey: [...keys.tasks(workspaceId, target), status ?? 'any'] as const,
        queryFn: ({ pageParam, signal }) => tasks.list(workspaceId, { target, status, cursor: pageParam }, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });

export function useSaveTask(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    const invalidate = () => {
        void client.invalidateQueries({ queryKey: keys.tasks(workspaceId, target) });
        void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
    };
    return useMutation({
        mutationFn: (input: { id?: string } & TaskInput & { title: string }) =>
            input.id
                ? tasks.update(workspaceId, input.id, {
                      title: input.title,
                      body: input.body,
                      status: input.status,
                      dueAt: input.dueAt,
                      assigneeId: input.assigneeId,
                  })
                : tasks.create(workspaceId, { ...input, targets: [target] }),
        onSuccess: invalidate,
    });
}

export function useDeleteTask(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => tasks.remove(workspaceId, id),
        onSuccess: () => {
            void client.invalidateQueries({ queryKey: keys.tasks(workspaceId, target) });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
        },
    });
}

export const useAttachments = (workspaceId: string, target: RecordTarget) =>
    useQuery({
        queryKey: keys.attachments(workspaceId, target),
        queryFn: ({ signal }) => attachments.list(workspaceId, target, signal),
    });

export function useUploadAttachment(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (file: File) => attachments.upload(workspaceId, target, file),
        onSuccess: () => {
            void client.invalidateQueries({ queryKey: keys.attachments(workspaceId, target) });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
        },
    });
}

export function useDeleteAttachment(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => attachments.remove(workspaceId, id),
        onSuccess: () => {
            void client.invalidateQueries({ queryKey: keys.attachments(workspaceId, target) });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
        },
    });
}

/** The record's activity, newest first, a page at a time; `kinds` narrows by prefix. */
export const useTimeline = (workspaceId: string, target: RecordTarget, kinds: string | undefined) =>
    useInfiniteQuery({
        queryKey: keys.timeline(workspaceId, target, kinds),
        queryFn: ({ pageParam, signal }) => timeline.list(workspaceId, { target, kinds, cursor: pageParam }, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
