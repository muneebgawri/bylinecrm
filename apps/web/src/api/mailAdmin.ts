import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { query, workspacePath } from './endpoints';
import { keys } from './queries';
import type {
    BlocklistEntryCreatedView,
    BlocklistEntryView,
    CalendarSyncTriggeredView,
    CalendarSyncView,
    ConnectMailboxInput,
    CreateBlocklistEntryInput,
    CreateSuppressionInput,
    DelegationAuditEntryView,
    DelegationMemberView,
    DelegationView,
    PatchDelegationInput,
    GoogleOAuthClientStatusView,
    GoogleOAuthClientView,
    MailSettingsView,
    MailboxCheckView,
    MailboxConnectStartView,
    MailboxDisconnectedView,
    MailboxSyncTriggeredView,
    MailboxSyncView,
    MailboxView,
    PutMailSettingsInput,
    PutOAuthClientInput,
    RemoveSuppressionInput,
    SuppressionListQuery,
    SuppressionPage,
    SuppressionView,
    UnsubscribeStatusView,
} from './types';

/**
 * Mail set-up: mail settings, the Google OAuth client, mailboxes, suppression, unsubscribe and the blocklist.
 * They live apart from `queries.ts` so they load with the settings and mailbox chunks (FR-CRMS-UI-10, #131).
 */

export const mailSettings = {
    get: (workspaceId: string, signal?: AbortSignal) =>
        request<MailSettingsView>('GET', workspacePath(workspaceId, '/settings/mail'), { signal }),
    put: (workspaceId: string, input: PutMailSettingsInput) =>
        request<MailSettingsView>('PUT', workspacePath(workspaceId, '/settings/mail'), { body: input }),
};

/**
 * The workspace's own Google OAuth client (P2-1, D-237). `describe`/`put`/`remove`/`verify` are an
 * admin's; `status` is every member's — whether Google is set up, without the client's details.
 */
export const oauthClient = {
    describe: (workspaceId: string, signal?: AbortSignal) =>
        request<GoogleOAuthClientView>('GET', workspacePath(workspaceId, '/mail/oauth-client'), { signal }),
    status: (workspaceId: string, signal?: AbortSignal) =>
        request<GoogleOAuthClientStatusView>('GET', workspacePath(workspaceId, '/mail/oauth-client/status'), {
            signal,
        }),
    put: (workspaceId: string, input: PutOAuthClientInput) =>
        request<GoogleOAuthClientView>('PUT', workspacePath(workspaceId, '/mail/oauth-client'), { body: input }),
    remove: (workspaceId: string) => request<void>('DELETE', workspacePath(workspaceId, '/mail/oauth-client')),
    verify: (workspaceId: string) =>
        request<GoogleOAuthClientView>('POST', workspacePath(workspaceId, '/mail/oauth-client/verify')),
};

/** The workspace's Google Workspace service account with domain-wide delegation (#225); an admin's. */
export const delegation = {
    describe: (workspaceId: string, signal?: AbortSignal) =>
        request<DelegationView>('GET', workspacePath(workspaceId, '/mail/google-workspace'), { signal }),
    update: (workspaceId: string, input: PatchDelegationInput) =>
        request<DelegationView>('PATCH', workspacePath(workspaceId, '/mail/google-workspace'), { body: input }),
    putKey: (workspaceId: string, key: string) =>
        request<DelegationView>('PUT', workspacePath(workspaceId, '/mail/google-workspace/key'), { body: { key } }),
    removeKey: (workspaceId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, '/mail/google-workspace/key')),
    check: (workspaceId: string) =>
        request<DelegationView>('POST', workspacePath(workspaceId, '/mail/google-workspace/check')),
    members: (workspaceId: string, signal?: AbortSignal) =>
        request<DelegationMemberView[]>('GET', workspacePath(workspaceId, '/mail/google-workspace/members'), {
            signal,
        }),
    setMember: (workspaceId: string, memberId: string, excluded: boolean) =>
        request<DelegationMemberView>('PUT', workspacePath(workspaceId, `/mail/google-workspace/members/${memberId}`), {
            body: { excluded },
        }),
    audit: (workspaceId: string, signal?: AbortSignal) =>
        request<DelegationAuditEntryView[]>('GET', workspacePath(workspaceId, '/mail/google-workspace/audit'), {
            signal,
        }),
};

/** Connected Google mailboxes (P2-1) and their sync (P2-2). */
export const mailboxes = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<MailboxView[]>('GET', workspacePath(workspaceId, '/mailboxes'), { signal }),
    /** Starts a connect: the answer's `authorizeUrl` is where the browser goes next. */
    connect: (workspaceId: string, input: ConnectMailboxInput) =>
        request<MailboxConnectStartView>('POST', workspacePath(workspaceId, '/mailboxes/connect'), { body: input }),
    check: (workspaceId: string, mailboxId: string) =>
        request<MailboxCheckView>('POST', workspacePath(workspaceId, `/mailboxes/${mailboxId}/check`)),
    disconnect: (workspaceId: string, mailboxId: string) =>
        request<MailboxDisconnectedView>('DELETE', workspacePath(workspaceId, `/mailboxes/${mailboxId}`)),
    syncState: (workspaceId: string, mailboxId: string, signal?: AbortSignal) =>
        request<MailboxSyncView>('GET', workspacePath(workspaceId, `/mailboxes/${mailboxId}/sync`), { signal }),
    sync: (workspaceId: string, mailboxId: string) =>
        request<MailboxSyncTriggeredView>('POST', workspacePath(workspaceId, `/mailboxes/${mailboxId}/sync`)),
    /** A personal mailbox's calendar sync (CAL-1): whether the grant reads the calendar, and how its reads go. */
    calendarState: (workspaceId: string, mailboxId: string, signal?: AbortSignal) =>
        request<CalendarSyncView>('GET', workspacePath(workspaceId, `/mailboxes/${mailboxId}/calendar`), { signal }),
    calendarSync: (workspaceId: string, mailboxId: string) =>
        request<CalendarSyncTriggeredView>('POST', workspacePath(workspaceId, `/mailboxes/${mailboxId}/calendar/sync`)),
};

/** Addresses and domains whose mail is never imported, and removed when added (P2-2). */
/** The workspace's suppression list (P3-1, FR-CRMS-7). */
export const suppressions = {
    list: (workspaceId: string, params: SuppressionListQuery, signal?: AbortSignal) =>
        request<SuppressionPage>(
            'GET',
            workspacePath(
                workspaceId,
                `/suppressions${query({ q: params.q, reason: params.reason, cursor: params.cursor, limit: params.limit })}`,
            ),
            { signal },
        ),
    create: (workspaceId: string, input: CreateSuppressionInput) =>
        request<SuppressionView>('POST', workspacePath(workspaceId, '/suppressions'), { body: input }),
    remove: (workspaceId: string, suppressionId: string, input: RemoveSuppressionInput) =>
        request<void>('POST', workspacePath(workspaceId, `/suppressions/${suppressionId}/remove`), { body: input }),
};

/** A recipient's unsubscribe link (P3-1): public, no session — the token is the proof. */
export const unsubscribe = {
    status: (token: string, signal?: AbortSignal) =>
        request<UnsubscribeStatusView>('GET', `/unsubscribe/${encodeURIComponent(token)}/status`, { signal }),
    confirm: (token: string) => request<UnsubscribeStatusView>('POST', `/unsubscribe/${encodeURIComponent(token)}`),
};

export const blocklist = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<BlocklistEntryView[]>('GET', workspacePath(workspaceId, '/mail/blocklist'), { signal }),
    create: (workspaceId: string, input: CreateBlocklistEntryInput) =>
        request<BlocklistEntryCreatedView>('POST', workspacePath(workspaceId, '/mail/blocklist'), { body: input }),
    remove: (workspaceId: string, entryId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/mail/blocklist/${entryId}`)),
};

export const useMailSettings = (workspaceId: string) =>
    useQuery({
        queryKey: keys.mailSettings(workspaceId),
        queryFn: ({ signal }) => mailSettings.get(workspaceId, signal),
    });

export function usePutMailSettings(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: PutMailSettingsInput) => mailSettings.put(workspaceId, input),
        onSuccess: (saved) => client.setQueryData(keys.mailSettings(workspaceId), saved),
    });
}

// ---- Google OAuth client, mailboxes, sync and blocklist (P2-1, P2-2) ---------------------------

/** The client as an admin sees it; never the secret, only its last four characters. */
export const useOAuthClient = (workspaceId: string, enabled = true) =>
    useQuery({
        queryKey: keys.oauthClient(workspaceId),
        queryFn: ({ signal }) => oauthClient.describe(workspaceId, signal),
        enabled,
    });

/** Whether Google is set up — what every member may read. */
export const useOAuthClientStatus = (workspaceId: string) =>
    useQuery({
        queryKey: keys.oauthClientStatus(workspaceId),
        queryFn: ({ signal }) => oauthClient.status(workspaceId, signal),
    });

/**
 * A write answers with the client as it now stands, so that is what the page shows — no second
 * request; its status is derived from the same row, so it is refreshed alongside.
 */
function useOAuthClientWrite<I>(workspaceId: string, write: (input: I) => Promise<GoogleOAuthClientView>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: (view) => {
            client.setQueryData(keys.oauthClient(workspaceId), view);
            return client.invalidateQueries({ queryKey: keys.oauthClientStatus(workspaceId) });
        },
    });
}

export const usePutOAuthClient = (workspaceId: string) =>
    useOAuthClientWrite(workspaceId, (input: PutOAuthClientInput) => oauthClient.put(workspaceId, input));

export const useVerifyOAuthClient = (workspaceId: string) =>
    useOAuthClientWrite(workspaceId, () => oauthClient.verify(workspaceId));

/** Removing the client leaves nothing to show but "not configured", which the server says on the next read. */
export function useRemoveOAuthClient(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: () => oauthClient.remove(workspaceId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.oauthClient(workspaceId) }),
    });
}

export const useDelegation = (workspaceId: string) =>
    useQuery({
        queryKey: keys.delegation(workspaceId),
        queryFn: ({ signal }) => delegation.describe(workspaceId, signal),
    });

export const useDelegationMembers = (workspaceId: string, enabled = true) =>
    useQuery({
        queryKey: keys.delegationMembers(workspaceId),
        queryFn: ({ signal }) => delegation.members(workspaceId, signal),
        enabled,
    });

export const useDelegationAudit = (workspaceId: string, enabled = true) =>
    useQuery({
        queryKey: keys.delegationAudit(workspaceId),
        queryFn: ({ signal }) => delegation.audit(workspaceId, signal),
        enabled,
    });

/** Any delegation write changes who syncs: the settings, the members, the audit log and the mailboxes. */
function useDelegationWrite<I, O>(workspaceId: string, write: (input: I) => Promise<O>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: () =>
            Promise.all([
                client.invalidateQueries({ queryKey: keys.delegation(workspaceId) }),
                client.invalidateQueries({ queryKey: keys.mailboxes(workspaceId) }),
            ]),
    });
}

export const usePutDelegationKey = (workspaceId: string) =>
    useDelegationWrite(workspaceId, (key: string) => delegation.putKey(workspaceId, key));
export const useRemoveDelegationKey = (workspaceId: string) =>
    useDelegationWrite(workspaceId, () => delegation.removeKey(workspaceId));
export const useCheckDelegation = (workspaceId: string) =>
    useDelegationWrite(workspaceId, () => delegation.check(workspaceId));
export const useUpdateDelegation = (workspaceId: string) =>
    useDelegationWrite(workspaceId, (input: PatchDelegationInput) => delegation.update(workspaceId, input));
export const useSetDelegationMember = (workspaceId: string) =>
    useDelegationWrite(workspaceId, (input: { memberId: string; excluded: boolean }) =>
        delegation.setMember(workspaceId, input.memberId, input.excluded),
    );

export const useMailboxes = (workspaceId: string) =>
    useQuery({
        queryKey: keys.mailboxes(workspaceId),
        queryFn: ({ signal }) => mailboxes.list(workspaceId, signal),
    });

/** Each mailbox's sync state, one request per mailbox — a workspace connects a handful. */
export function useMailboxSyncs(workspaceId: string, list: readonly MailboxView[]) {
    return useQueries({
        queries: list.map((mailbox) => ({
            queryKey: keys.mailboxSync(workspaceId, mailbox.id),
            queryFn: ({ signal }: { signal: AbortSignal }) => mailboxes.syncState(workspaceId, mailbox.id, signal),
            enabled: mailbox.status !== 'disconnected',
        })),
    });
}

/** Each connected personal mailbox's calendar sync (CAL-1); a pool mailbox has no calendar the CRM reads. */
export function useCalendarSyncs(workspaceId: string, list: readonly MailboxView[]) {
    return useQueries({
        queries: list.map((mailbox) => ({
            queryKey: keys.calendarSync(workspaceId, mailbox.id),
            queryFn: ({ signal }: { signal: AbortSignal }) => mailboxes.calendarState(workspaceId, mailbox.id, signal),
            enabled: mailbox.purpose === 'personal' && mailbox.status === 'connected',
        })),
    });
}

export function useSyncCalendar(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (mailboxId: string) => mailboxes.calendarSync(workspaceId, mailboxId),
        onSuccess: (result, mailboxId) => client.setQueryData(keys.calendarSync(workspaceId, mailboxId), result.sync),
    });
}

/** Starts a connect; the caller sends the browser to the answer's `authorizeUrl`. */
export const useConnectMailbox = (workspaceId: string) =>
    useMutation({ mutationFn: (input: ConnectMailboxInput) => mailboxes.connect(workspaceId, input) });

/** A write that changes a mailbox refreshes the list (its status may have changed). */
function useMailboxWrite<O>(workspaceId: string, write: (mailboxId: string) => Promise<O>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: () => client.invalidateQueries({ queryKey: keys.mailboxes(workspaceId), exact: true }),
    });
}

export const useCheckMailbox = (workspaceId: string) =>
    useMailboxWrite(workspaceId, (mailboxId) => mailboxes.check(workspaceId, mailboxId));

export const useDisconnectMailbox = (workspaceId: string) =>
    useMailboxWrite(workspaceId, (mailboxId) => mailboxes.disconnect(workspaceId, mailboxId));

export function useSyncMailbox(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (mailboxId: string) => mailboxes.sync(workspaceId, mailboxId),
        onSuccess: (result, mailboxId) => client.setQueryData(keys.mailboxSync(workspaceId, mailboxId), result.sync),
    });
}

export const SUPPRESSION_PAGE_SIZE = 50;

/** The suppression list, newest first, searched and filtered by reason; pages on demand. */
export function useSuppressions(workspaceId: string, params: SuppressionListQuery) {
    return useInfiniteQuery({
        queryKey: keys.suppressionList(workspaceId, params),
        queryFn: ({ pageParam, signal }) =>
            suppressions.list(workspaceId, { ...params, cursor: pageParam, limit: SUPPRESSION_PAGE_SIZE }, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
    });
}

export function useAddSuppression(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CreateSuppressionInput) => suppressions.create(workspaceId, input),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.suppressions(workspaceId) }),
    });
}

export function useLiftSuppression(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ id, note }: { id: string; note: string }) => suppressions.remove(workspaceId, id, { note }),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.suppressions(workspaceId) }),
    });
}

/** What an unsubscribe link's page shows; public, no session. */
export const useUnsubscribeStatus = (token: string) =>
    useQuery({
        queryKey: keys.unsubscribeStatus(token),
        queryFn: ({ signal }) => unsubscribe.status(token, signal),
        retry: false,
    });

export function useConfirmUnsubscribe(token: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: () => unsubscribe.confirm(token),
        onSuccess: (status) => client.setQueryData(keys.unsubscribeStatus(token), status),
    });
}

export const useBlocklist = (workspaceId: string) =>
    useQuery({
        queryKey: keys.blocklist(workspaceId),
        queryFn: ({ signal }) => blocklist.list(workspaceId, signal),
    });

/** Adding an entry removes stored mail it covers, so threads and timelines are refreshed with it. */
export function useAddBlocklistEntry(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CreateBlocklistEntryInput) => blocklist.create(workspaceId, input),
        onSuccess: () =>
            Promise.all([
                client.invalidateQueries({ queryKey: keys.blocklist(workspaceId) }),
                client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline'] }),
            ]),
    });
}

export function useRemoveBlocklistEntry(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (entryId: string) => blocklist.remove(workspaceId, entryId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.blocklist(workspaceId) }),
    });
}
