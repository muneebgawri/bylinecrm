import { request } from './client';
import type {
    ApiKeyView,
    CreateApiKeyInput,
    CreateInviteInput,
    CreateRoleInput,
    InviteView,
    LoginInput,
    MemberView,
    RoleView,
    SignupInput,
    UpdateRoleInput,
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
