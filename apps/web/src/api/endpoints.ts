import type { FilterGroup, RecordTarget } from '@bylinecrm/shared';
import { request } from './client';
import type {
    AuthProvidersView,
    CreatePlatformWorkspaceInput,
    CreateSignupInviteInput,
    CreatedPlatformWorkspaceView,
    InvitePreviewView,
    LoginInput,
    MembershipSummary,
    PlatformAccessView,
    PlatformInviteView,
    PlatformWorkspaceView,
    ProfileView,
    SignupInput,
    UserView,
    WorkspaceView,
} from './types';

/** `person:<uuid>` — how a target travels in a query string; the API parses the same spelling. */
export function targetParam(target: RecordTarget): string {
    return `${target.type}:${target.id}`;
}

/** Builds `?a=b&c=d` from the defined values only. */
export function query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
    const text = search.toString();
    return text ? `?${text}` : '';
}

/** A type alias (not an interface) so it satisfies `query`'s index signature. */
export type ListParams = {
    cursor?: string | undefined;
    limit?: number | undefined;
    sort?: string | undefined;
    q?: string | undefined;
    /** The P1-4 filter grammar, already encoded (`lib/filterParam.ts`); the API decodes it. */
    filter?: string | undefined;
    /** A saved view's id: its filter and sort are the defaults the inline ones replace. */
    view?: string | undefined;
};

/** What an export takes: the list's query and the columns to write, in order. */
export type ExportParams = Omit<ListParams, 'cursor' | 'limit'> & { columns?: string | undefined };

/** `POST …/export.csv`: the export's query as JSON — the filter as the grammar, not encoded. */
export type ExportBody = {
    filter?: FilterGroup | undefined;
    sort?: string | undefined;
    view?: string | undefined;
    q?: string | undefined;
    columns?: string | undefined;
};

/**
 * One function per API route, named for what it does, typed by `types.ts`. Paths are built here
 * and nowhere else; a component never spells `/w/` itself.
 */

export const workspacePath = (workspaceId: string, rest: string) => `/w/${workspaceId}${rest}`;

export const auth = {
    signup: (input: SignupInput) =>
        request<{ user: UserView; workspace: WorkspaceView }>('POST', '/auth/signup', { body: input }),
    login: (input: LoginInput) => request<{ user: UserView }>('POST', '/auth/login', { body: input }),
    logout: () => request<void>('POST', '/auth/logout'),
    /** The providers, and who may sign up (P0-14): the sign-in and sign-up pages read both. */
    providers: () => request<AuthProvidersView>('GET', '/auth/providers'),
    /** What a workspace invitation is for; anyone holding the token may ask. */
    previewInvite: (token: string, signal?: AbortSignal) =>
        request<InvitePreviewView>('GET', `/auth/invites/${encodeURIComponent(token)}`, { signal }),
    /** Where the browser is sent to start a provider sign-in; a full-page navigation, not a fetch. */
    providerStartUrl: (issuer: string) => `/api/auth/oidc/${encodeURIComponent(issuer)}`,
    acceptInvite: (token: string) =>
        request<WorkspaceView>('POST', `/auth/invites/${encodeURIComponent(token)}/accept`),
    acceptInviteSignup: (token: string, password: string) =>
        request<WorkspaceView>('POST', `/auth/invites/${encodeURIComponent(token)}/signup`, { body: { password } }),
    /** Spends a mailed verification link (#93). */
    verifyEmail: (token: string) => request<void>('POST', '/auth/email/verify', { body: { token } }),
    /** Mails the signed-in person a fresh verification link (#93). */
    resendVerification: () => request<void>('POST', '/auth/email/verification'),
    /** "Forgot password" (#93): the answer is the same whether or not the address has an account. */
    forgotPassword: (email: string) => request<void>('POST', '/auth/password/forgot', { body: { email } }),
    /** Spends a mailed reset link: a new password, and this browser signed in (#93). */
    resetPassword: (token: string, password: string) =>
        request<{ user: UserView }>('POST', '/auth/password/reset', { body: { token, password } }),
};

export const me = {
    current: (signal?: AbortSignal) => request<UserView>('GET', '/me', { signal }),
    /** The person's own profile: the name every workspace shows them under (P1-UI-10). */
    profile: (signal?: AbortSignal) => request<ProfileView>('GET', '/me/profile', { signal }),
    updateProfile: (displayName: string) => request<ProfileView>('PATCH', '/me/profile', { body: { displayName } }),
    workspaces: (signal?: AbortSignal) => request<WorkspaceView[]>('GET', '/me/workspaces', { signal }),
    createWorkspace: (name: string) => request<WorkspaceView>('POST', '/workspaces', { body: { name } }),
};

/** The operator's routes (P0-14): platform admins only, except `access`. */
export const platform = {
    access: (signal?: AbortSignal) => request<PlatformAccessView>('GET', '/platform/access', { signal }),
    workspaces: (signal?: AbortSignal) => request<PlatformWorkspaceView[]>('GET', '/platform/workspaces', { signal }),
    createWorkspace: (input: CreatePlatformWorkspaceInput) =>
        request<CreatedPlatformWorkspaceView>('POST', '/platform/workspaces', { body: input }),
    createSignupInvite: (input: CreateSignupInviteInput) =>
        request<PlatformInviteView>('POST', '/platform/signup-invites', { body: input }),
};

export const membership = {
    /** The caller's own standing in the workspace: what every permission-aware control reads. */
    me: (workspaceId: string, signal?: AbortSignal) =>
        request<MembershipSummary>('GET', workspacePath(workspaceId, '/me'), { signal }),
};
