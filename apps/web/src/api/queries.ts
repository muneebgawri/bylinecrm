import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isClientError } from './client';
import type { RecordObject } from '@bylinecrm/shared';
import {
    apiKeys,
    auth,
    companies,
    deals,
    invites,
    me,
    members,
    membership,
    pipelines,
    roles,
    views,
} from './endpoints';
import type {
    BoardQuery,
    BoardView,
    CreateApiKeyInput,
    CreateInviteInput,
    CreateOpportunityInput,
    CreateRoleInput,
    CreateViewInput,
    LoginInput,
    MoveDealInput,
    OpportunityView,
    SignupInput,
    UpdateOpportunityInput,
    UpdateRoleInput,
    UpdateViewInput,
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
    membersSummary: (workspaceId: string) => ['w', workspaceId, 'members', 'summary'] as const,
    pipelines: (workspaceId: string) => ['w', workspaceId, 'pipelines'] as const,
    rules: (workspaceId: string, pipelineId: string) => ['w', workspaceId, 'pipelines', pipelineId, 'rules'] as const,
    /** The board AND the deal list read this one key: one result set, two renderings (FR-CRMS-UI-3). */
    board: (workspaceId: string, pipelineId: string, params: BoardQuery) =>
        [
            'w',
            workspaceId,
            'pipelines',
            pipelineId,
            'board',
            { view: params.view ?? '', filter: params.filter ?? '', sort: params.sort ?? '', q: params.q ?? '' },
        ] as const,
    views: (workspaceId: string, object: RecordObject) => ['w', workspaceId, 'views', object] as const,
    companySearch: (workspaceId: string, q: string) => ['w', workspaceId, 'companies', 'search', q] as const,
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

export const useMembersSummary = (workspaceId: string) =>
    useQuery({
        queryKey: keys.membersSummary(workspaceId),
        queryFn: ({ signal }) => members.summary(workspaceId, signal),
    });
export const usePipelines = (workspaceId: string) =>
    useQuery({ queryKey: keys.pipelines(workspaceId), queryFn: ({ signal }) => pipelines.list(workspaceId, signal) });
export const useRules = (workspaceId: string, pipelineId: string | undefined) =>
    useQuery({
        queryKey: keys.rules(workspaceId, pipelineId ?? ''),
        queryFn: ({ signal }) => pipelines.rules(workspaceId, pipelineId ?? '', signal),
        enabled: pipelineId !== undefined,
    });

/**
 * The board. Another member's move arrives by refetch when the window regains focus — never by
 * polling (doc 50 §B "stale").
 */
export const useBoard = (workspaceId: string, pipelineId: string | undefined, params: BoardQuery) =>
    useQuery({
        queryKey: keys.board(workspaceId, pipelineId ?? '', params),
        queryFn: ({ signal }) => pipelines.board(workspaceId, pipelineId ?? '', params, signal),
        enabled: pipelineId !== undefined,
        refetchOnWindowFocus: true,
    });

export const useViews = (workspaceId: string, object: RecordObject) =>
    useQuery({
        queryKey: keys.views(workspaceId, object),
        queryFn: ({ signal }) => views.list(workspaceId, object, signal),
    });

export function useCreateView(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CreateViewInput) => views.create(workspaceId, input),
        onSuccess: (view) => client.invalidateQueries({ queryKey: keys.views(workspaceId, view.object) }),
    });
}

export function useUpdateView(workspaceId: string, object: RecordObject) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: { viewId: string } & UpdateViewInput) => {
            const { viewId, ...rest } = input;
            return views.update(workspaceId, viewId, rest);
        },
        onSuccess: () => client.invalidateQueries({ queryKey: keys.views(workspaceId, object) }),
    });
}

export function useDeleteView(workspaceId: string, object: RecordObject) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (viewId: string) => views.remove(workspaceId, viewId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.views(workspaceId, object) }),
    });
}

export const useCompanySearch = (workspaceId: string, q: string) =>
    useQuery({
        queryKey: keys.companySearch(workspaceId, q),
        queryFn: ({ signal }) => companies.search(workspaceId, q, signal),
        enabled: q.trim().length > 0,
        staleTime: 10_000,
    });

/** Every board key for this pipeline, whatever its query. */
const boardPrefix = (workspaceId: string, pipelineId: string) =>
    ['w', workspaceId, 'pipelines', pipelineId, 'board'] as const;

export function useCreateDeal(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CreateOpportunityInput) => deals.create(workspaceId, input),
        onSuccess: (deal) => client.invalidateQueries({ queryKey: boardPrefix(workspaceId, deal.pipelineId) }),
    });
}

export function useUpdateDeal(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: { dealId: string } & UpdateOpportunityInput) =>
            deals.update(workspaceId, input.dealId, { ownerId: input.ownerId }),
        onSuccess: (deal) => client.invalidateQueries({ queryKey: boardPrefix(workspaceId, deal.pipelineId) }),
    });
}

export interface MoveDealVariables extends MoveDealInput {
    dealId: string;
    pipelineId: string;
}

/**
 * A stage move: the card is moved in every cached board of the pipeline before the server
 * answers (the optimistic paint, FR-CRMS-UI-10); a refusal puts the previous board back — the
 * snap-back — and the caller shows the reason. Counts and sums are the API's: they are not
 * adjusted here, and every board is refetched once the server has answered either way.
 */
export function useMoveDeal(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: MoveDealVariables) =>
            deals.move(workspaceId, input.dealId, { stageId: input.stageId, close: input.close }),
        onMutate: async (input) => {
            const prefix = boardPrefix(workspaceId, input.pipelineId);
            await client.cancelQueries({ queryKey: prefix });
            const previous = client.getQueriesData<BoardView>({ queryKey: prefix });
            client.setQueriesData<BoardView>({ queryKey: prefix }, (board) =>
                board ? moveInBoard(board, input.dealId, input.stageId) : board,
            );
            return { previous };
        },
        onError: (_error, _input, context) => {
            for (const [key, board] of context?.previous ?? []) client.setQueryData(key, board);
        },
        onSettled: (_result, _error, input) =>
            client.invalidateQueries({ queryKey: boardPrefix(workspaceId, input.pipelineId) }),
    });
}

/** The same board with one deal in another column; the API's counts and sums are left as they were. */
export function moveInBoard(board: BoardView, dealId: string, stageId: string): BoardView {
    let moving: OpportunityView | undefined;
    const stripped = board.columns.map((column) => {
        const deal = column.deals.find((d) => d.id === dealId);
        if (!deal) return column;
        moving = deal;
        return { ...column, deals: column.deals.filter((d) => d.id !== dealId) };
    });
    if (!moving) return board;
    const moved = { ...moving, stageId };
    return {
        ...board,
        columns: stripped.map((column) =>
            column.stage.id === stageId ? { ...column, deals: [moved, ...column.deals] } : column,
        ),
    };
}

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
