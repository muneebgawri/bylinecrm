import type { RecordObject, RecordTarget } from '@bylinecrm/shared';
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isClientError } from './client';
import { auth, me, membership, platform } from './endpoints';
import type {
    BoardQuery,
    CreatePlatformWorkspaceInput,
    CreateSignupInviteInput,
    LoginInput,
    SignupInput,
    SuppressionListQuery,
    TemplateListQuery,
} from './types';

/**
 * Query keys, once. A key is an array whose first element names the resource and whose later
 * elements scope it; invalidation by prefix (`keys.roles(id)` after a role mutation) follows.
 */
export const keys = {
    me: ['me'] as const,
    profile: ['me', 'profile'] as const,
    workspaces: ['me', 'workspaces'] as const,
    membership: (workspaceId: string) => ['w', workspaceId, 'me'] as const,
    members: (workspaceId: string) => ['w', workspaceId, 'members'] as const,
    roles: (workspaceId: string) => ['w', workspaceId, 'roles'] as const,
    apiKeys: (workspaceId: string) => ['w', workspaceId, 'api-keys'] as const,
    invites: (workspaceId: string) => ['w', workspaceId, 'invites'] as const,
    providers: ['auth', 'providers'] as const,
    invitePreview: (token: string) => ['auth', 'invites', token] as const,
    platformAccess: ['platform', 'access'] as const,
    platformWorkspaces: ['platform', 'workspaces'] as const,
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
    rules: (workspaceId: string, pipelineId: string) => ['w', workspaceId, 'pipelines', pipelineId, 'rules'] as const,
    /** Every board of a pipeline, whatever its query — what a move paints into and invalidates. */
    boards: (workspaceId: string, pipelineId: string) => ['w', workspaceId, 'pipelines', pipelineId, 'board'] as const,
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
    search: (workspaceId: string, q: string, objects: string) => ['w', workspaceId, 'search', q, objects] as const,
    /** Every template list of the workspace, whatever its filter — what a template write invalidates. */
    templates: (workspaceId: string) => ['w', workspaceId, 'templates'] as const,
    templateList: (workspaceId: string, params: TemplateListQuery) =>
        ['w', workspaceId, 'templates', 'list', { kind: params.kind ?? '', q: params.q ?? '' }] as const,
    template: (workspaceId: string, templateId: string) => ['w', workspaceId, 'templates', 'one', templateId] as const,
    templateVariables: (workspaceId: string) => ['w', workspaceId, 'templates', 'variables'] as const,
    /** Every sequence query of the workspace — what a sequence write invalidates. */
    sequences: (workspaceId: string) => ['w', workspaceId, 'sequences'] as const,
    sequence: (workspaceId: string, sequenceId: string) => ['w', workspaceId, 'sequences', 'one', sequenceId] as const,
    sequenceEnrolments: (workspaceId: string, sequenceId: string) =>
        ['w', workspaceId, 'sequences', 'enrolments', sequenceId] as const,
    /** A person's enrolments; under `sequences` so an enrolment change refreshes both views. */
    personEnrolments: (workspaceId: string, personId: string) =>
        ['w', workspaceId, 'sequences', 'person', personId] as const,
    mailSettings: (workspaceId: string) => ['w', workspaceId, 'settings', 'mail'] as const,
    oauthClient: (workspaceId: string) => ['w', workspaceId, 'mail', 'oauth-client'] as const,
    twentyImport: (workspaceId: string) => ['w', workspaceId, 'import', 'twenty'] as const,
    twentyImportRuns: (workspaceId: string) => ['w', workspaceId, 'import', 'twenty', 'runs'] as const,
    /** What a reconcile pass flagged as missing in Twenty (#156). */
    twentyImportMissing: (workspaceId: string) => ['w', workspaceId, 'import', 'twenty', 'missing'] as const,
    twentyImportRun: (workspaceId: string, runId: string) =>
        ['w', workspaceId, 'import', 'twenty', 'runs', runId] as const,
    oauthClientStatus: (workspaceId: string) => ['w', workspaceId, 'mail', 'oauth-client', 'status'] as const,
    mailboxes: (workspaceId: string) => ['w', workspaceId, 'mailboxes'] as const,
    mailboxSync: (workspaceId: string, mailboxId: string) =>
        ['w', workspaceId, 'mailboxes', mailboxId, 'sync'] as const,
    blocklist: (workspaceId: string) => ['w', workspaceId, 'mail', 'blocklist'] as const,
    suppressions: (workspaceId: string) => ['w', workspaceId, 'suppressions'] as const,
    sendingPool: (workspaceId: string) => ['w', workspaceId, 'sending-pool'] as const,
    /** The region policy and its change history (#141); one key so a change refreshes both. */
    regionPolicy: (workspaceId: string) => ['w', workspaceId, 'outreach', 'region-policy'] as const,
    /** How long an address's verification stands (P3-5, FR-CRMS-16). */
    verificationSettings: (workspaceId: string) => ['w', workspaceId, 'outreach', 'verification'] as const,
    /** A record's enrichment answers (P4-2), and the workspace's sources and re-ask age. */
    enrichment: (workspaceId: string, object: string, recordId: string) =>
        ['w', workspaceId, 'enrichment', object, recordId] as const,
    enrichmentSettings: (workspaceId: string) => ['w', workspaceId, 'enrichment', 'settings'] as const,
    suppressionList: (workspaceId: string, params: SuppressionListQuery) =>
        ['w', workspaceId, 'suppressions', params] as const,
    unsubscribeStatus: (token: string) => ['unsubscribe', token] as const,
    mailMessage: (workspaceId: string, messageId: string) => ['w', workspaceId, 'mail', 'messages', messageId] as const,
    /** Every record's sends list (#104); one record's is `mailRecordSends(…, target)`. */
    mailRecordSendsAll: (workspaceId: string) => ['w', workspaceId, 'mail', 'record-sends'] as const,
    mailRecordSends: (workspaceId: string, target: RecordTarget) =>
        ['w', workspaceId, 'mail', 'record-sends', target.type, target.id] as const,
    mailThread: (workspaceId: string, threadId: string) => ['w', workspaceId, 'mail', 'threads', threadId] as const,
    /** The sends made in this tab: held by the client so a send shows before the server has stored it. */
    mailSession: (workspaceId: string) => ['w', workspaceId, 'mail', 'session'] as const,
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

/** Who is signed in. `enabled: false` where asking would send a signed-out person to sign-in (a 401 does). */
export const useMe = (enabled = true) =>
    useQuery({ queryKey: keys.me, queryFn: ({ signal }) => me.current(signal), enabled });

export const useProfile = () => useQuery({ queryKey: keys.profile, queryFn: ({ signal }) => me.profile(signal) });

/**
 * Saves the display name. Every list, row and picker that names a member reads it, in every
 * workspace, so everything cached is refreshed — a rename is rare, and a stale name is wrong.
 */
export function useUpdateProfile() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (displayName: string) => me.updateProfile(displayName),
        onSuccess: (profile) => {
            client.setQueryData(keys.profile, profile);
            void client.invalidateQueries({
                predicate: (query) => query.queryKey[0] !== 'me' || query.queryKey[1] !== 'profile',
            });
        },
    });
}

export const useWorkspaces = () =>
    useQuery({ queryKey: keys.workspaces, queryFn: ({ signal }) => me.workspaces(signal) });

export const useProviders = () =>
    useQuery({ queryKey: keys.providers, queryFn: () => auth.providers(), staleTime: Infinity });

/** What a workspace invitation is for (the accept page); a spent or unknown token is a 410/404 answer. */
export const useInvitePreview = (token: string | null) =>
    useQuery({
        queryKey: keys.invitePreview(token ?? ''),
        queryFn: ({ signal }) => auth.previewInvite(token ?? '', signal),
        enabled: Boolean(token),
    });

export function useAcceptInvite() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (token: string) => auth.acceptInvite(token),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.workspaces }),
    });
}

export function useAcceptInviteSignup() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: { token: string; password: string }) =>
            auth.acceptInviteSignup(input.token, input.password),
        onSuccess: () => client.clear(),
    });
}

/** Whether the signed-in person is a platform admin, and the sign-up mode (P0-14). */
export const usePlatformAccess = () =>
    useQuery({ queryKey: keys.platformAccess, queryFn: ({ signal }) => platform.access(signal) });

export const usePlatformWorkspaces = (enabled = true) =>
    useQuery({ queryKey: keys.platformWorkspaces, queryFn: ({ signal }) => platform.workspaces(signal), enabled });

export function useCreatePlatformWorkspace() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CreatePlatformWorkspaceInput) => platform.createWorkspace(input),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.platformWorkspaces }),
    });
}

export function useCreateSignupInvite() {
    return useMutation({ mutationFn: (input: CreateSignupInviteInput) => platform.createSignupInvite(input) });
}

/** The caller's standing in the workspace; `CapabilitiesProvider` is fed from this. */
export const useMembershipQuery = (workspaceId: string) =>
    useQuery({
        queryKey: keys.membership(workspaceId),
        queryFn: ({ signal }) => membership.me(workspaceId, signal),
    });

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

/** Spends a verification link; whoever is signed in is now verified, so `me` is read again (#93). */
export function useVerifyEmail() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (token: string) => auth.verifyEmail(token),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.me }),
    });
}

export function useResendVerification() {
    return useMutation({ mutationFn: () => auth.resendVerification() });
}

export function useForgotPassword() {
    return useMutation({ mutationFn: (email: string) => auth.forgotPassword(email) });
}

/** A reset signs this browser in as the account (and out everywhere else): the cache starts over. */
export function useResetPassword() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: { token: string; password: string }) => auth.resetPassword(input.token, input.password),
        onSuccess: () => client.clear(),
    });
}

export function useCreateWorkspace() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (name: string) => me.createWorkspace(name),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.workspaces }),
    });
}
