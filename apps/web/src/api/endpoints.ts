import type { RecordObject } from '@bylinecrm/shared';
import { request } from './client';
import type {
    ApiKeyView,
    BoardQuery,
    CreateViewInput,
    BoardView,
    CompanySummary,
    CreateApiKeyInput,
    CreateInviteInput,
    CreateOpportunityInput,
    CreateRoleInput,
    InviteView,
    LoginInput,
    MembershipSummary,
    MemberSummaryView,
    MemberView,
    MoveDealInput,
    MoveResult,
    OpportunityView,
    Page,
    PipelineView,
    RoleView,
    RuleView,
    SavedView,
    SignupInput,
    UpdateOpportunityInput,
    UpdateRoleInput,
    UpdateViewInput,
    UserView,
    WorkspaceView,
} from './types';

/**
 * One function per API route, named for what it does, typed by `types.ts`. Paths are built here
 * and nowhere else; a component never spells `/w/` itself.
 */

const workspacePath = (workspaceId: string, rest: string) => `/w/${workspaceId}${rest}`;

export const auth = {
    signup: (input: SignupInput) =>
        request<{ user: UserView; workspace: WorkspaceView }>('POST', '/auth/signup', { body: input }),
    login: (input: LoginInput) => request<{ user: UserView }>('POST', '/auth/login', { body: input }),
    logout: () => request<void>('POST', '/auth/logout'),
    providers: () => request<{ providers: string[] }>('GET', '/auth/providers'),
    /** Where the browser is sent to start a provider sign-in; a full-page navigation, not a fetch. */
    providerStartUrl: (issuer: string) => `/api/auth/oidc/${encodeURIComponent(issuer)}`,
    acceptInvite: (token: string) =>
        request<WorkspaceView>('POST', `/auth/invites/${encodeURIComponent(token)}/accept`),
    acceptInviteSignup: (token: string, password: string) =>
        request<WorkspaceView>('POST', `/auth/invites/${encodeURIComponent(token)}/signup`, { body: { password } }),
};

export const me = {
    profile: (signal?: AbortSignal) => request<UserView>('GET', '/me', { signal }),
    workspaces: (signal?: AbortSignal) => request<WorkspaceView[]>('GET', '/me/workspaces', { signal }),
    createWorkspace: (name: string) => request<WorkspaceView>('POST', '/workspaces', { body: { name } }),
};

export const membership = {
    /** The caller's own standing in the workspace: what every permission-aware control reads. */
    me: (workspaceId: string, signal?: AbortSignal) =>
        request<MembershipSummary>('GET', workspacePath(workspaceId, '/me'), { signal }),
};

/** `?a=1&b=2` from the defined entries only; empty when none. */
function query(params: { readonly [key: string]: string | number | undefined }): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
        if (value !== undefined && value !== '') search.set(key, String(value));
    const text = search.toString();
    return text ? `?${text}` : '';
}

export const members = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<MemberView[]>('GET', workspacePath(workspaceId, '/members'), { signal }),
    /** Names for owner/assignee pickers; readable by anyone with `record:read`. */
    summary: (workspaceId: string, signal?: AbortSignal) =>
        request<MemberSummaryView[]>('GET', workspacePath(workspaceId, '/members/summary'), { signal }),
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

export const pipelines = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<PipelineView[]>('GET', workspacePath(workspaceId, '/pipelines'), { signal }),
    /** The board: every stage with its deals, count and exact sums under the caller's scope and the query. */
    board: (workspaceId: string, pipelineId: string, params: BoardQuery, signal?: AbortSignal) =>
        request<BoardView>(
            'GET',
            workspacePath(
                workspaceId,
                `/pipelines/${pipelineId}/board${query({ view: params.view, filter: params.filter, sort: params.sort, q: params.q })}`,
            ),
            {
                signal,
            },
        ),
    rules: (workspaceId: string, pipelineId: string, signal?: AbortSignal) =>
        request<RuleView[]>('GET', workspacePath(workspaceId, `/pipelines/${pipelineId}/rules`), { signal }),
};

export const views = {
    /** Shared views and the caller's own, for one object. */
    list: (workspaceId: string, object: RecordObject, signal?: AbortSignal) =>
        request<SavedView[]>('GET', workspacePath(workspaceId, `/views${query({ object })}`), { signal }),
    create: (workspaceId: string, input: CreateViewInput) =>
        request<SavedView>('POST', workspacePath(workspaceId, '/views'), { body: input }),
    update: (workspaceId: string, viewId: string, input: UpdateViewInput) =>
        request<SavedView>('PATCH', workspacePath(workspaceId, `/views/${viewId}`), { body: input }),
    remove: (workspaceId: string, viewId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/views/${viewId}`)),
};

export const deals = {
    create: (workspaceId: string, input: CreateOpportunityInput) =>
        request<OpportunityView>('POST', workspacePath(workspaceId, '/opportunities'), { body: input }),
    update: (workspaceId: string, dealId: string, input: UpdateOpportunityInput) =>
        request<OpportunityView>('PATCH', workspacePath(workspaceId, `/opportunities/${dealId}`), { body: input }),
    /** The one way a deal changes stage; a won/lost target needs `close`. */
    move: (workspaceId: string, dealId: string, input: MoveDealInput) =>
        request<MoveResult>('POST', workspacePath(workspaceId, `/opportunities/${dealId}/move`), { body: input }),
};

export const companies = {
    /** A short search for pickers: name or domain prefix, a handful of rows. */
    search: (workspaceId: string, q: string, signal?: AbortSignal) =>
        request<Page<CompanySummary>>('GET', workspacePath(workspaceId, `/companies${query({ q, limit: 8 })}`), {
            signal,
        }),
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
