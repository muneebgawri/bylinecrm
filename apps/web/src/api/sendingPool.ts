import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import { keys } from './queries';
import type {
    MailboxConnectStartView,
    PoolMailboxHealthView,
    ResumeMailboxInput,
    SendingDomainView,
    SendingPoolSettingsView,
    SendingPoolView,
    SetMailboxPoolInput,
    UpdateSendingDomainInput,
    UpdateSendingPoolSettingsInput,
} from './types';

/**
 * The sending pool's reads and writes (P3-2), and its endpoints. They live apart from `queries.ts`
 * so they load with the Mailboxes chunk. Every write invalidates the one view, which holds settings,
 * mailboxes and domains together.
 */

/** The sending pool (P3-2): health, settings, a mailbox's cap and resume, sending domains. */
export const sendingPool = {
    view: (workspaceId: string, signal?: AbortSignal) =>
        request<SendingPoolView>('GET', workspacePath(workspaceId, '/sending-pool'), { signal }),
    updateSettings: (workspaceId: string, input: UpdateSendingPoolSettingsInput) =>
        request<SendingPoolSettingsView>('PUT', workspacePath(workspaceId, '/sending-pool/settings'), { body: input }),
    setMailboxCap: (workspaceId: string, mailboxId: string, input: SetMailboxPoolInput) =>
        request<PoolMailboxHealthView>('PUT', workspacePath(workspaceId, `/mailboxes/${mailboxId}/pool`), {
            body: input,
        }),
    resume: (workspaceId: string, mailboxId: string, input: ResumeMailboxInput) =>
        request<PoolMailboxHealthView>('POST', workspacePath(workspaceId, `/mailboxes/${mailboxId}/resume`), {
            body: input,
        }),
    updateDomain: (workspaceId: string, domainId: string, input: UpdateSendingDomainInput) =>
        request<SendingDomainView>('PUT', workspacePath(workspaceId, `/sending-domains/${domainId}`), { body: input }),
    /** Every sending domain (#190): each connected mailbox's, pool or personal, and the Postmaster account's. */
    domains: (workspaceId: string, signal?: AbortSignal) =>
        request<SendingDomainView[]>('GET', workspacePath(workspaceId, '/sending-domains'), { signal }),
    /** One sending domain, for an admin (#190). */
    domain: (workspaceId: string, domainId: string, signal?: AbortSignal) =>
        request<SendingDomainView>('GET', workspacePath(workspaceId, `/sending-domains/${domainId}`), { signal }),
    checkDomain: (workspaceId: string, domainId: string) =>
        request<SendingDomainView>('POST', workspacePath(workspaceId, `/sending-domains/${domainId}/check`)),
    /** Starts connecting the Postmaster Tools account (#129): the answer's `authorizeUrl` is where the browser goes next. */
    connectPostmaster: (workspaceId: string) =>
        request<MailboxConnectStartView>('POST', workspacePath(workspaceId, '/sending-pool/postmaster/connect')),
    disconnectPostmaster: (workspaceId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, '/sending-pool/postmaster')),
};

const poolKey = keys.sendingPool;
/** Under the pool's key, so every pool write (a check, a selector, Postmaster connected) refreshes them too. */
const domainsKey = (workspaceId: string) => [...poolKey(workspaceId), 'domains'] as const;
const domainKey = (workspaceId: string, domainId: string) => [...domainsKey(workspaceId), domainId] as const;

export function useSendingPool(workspaceId: string, enabled = true) {
    return useQuery({
        queryKey: poolKey(workspaceId),
        queryFn: ({ signal }) => sendingPool.view(workspaceId, signal),
        enabled,
    });
}

export function useSendingDomains(workspaceId: string, enabled = true) {
    return useQuery({
        queryKey: domainsKey(workspaceId),
        queryFn: ({ signal }) => sendingPool.domains(workspaceId, signal),
        enabled,
    });
}

export function useSendingDomain(workspaceId: string, domainId: string, enabled = true) {
    return useQuery({
        queryKey: domainKey(workspaceId, domainId),
        queryFn: ({ signal }) => sendingPool.domain(workspaceId, domainId, signal),
        enabled,
    });
}

function usePoolWrite<V, R>(workspaceId: string, write: (input: V) => Promise<R>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: () => client.invalidateQueries({ queryKey: poolKey(workspaceId) }),
    });
}

export const useUpdatePoolSettings = (workspaceId: string) =>
    usePoolWrite(workspaceId, (input: UpdateSendingPoolSettingsInput) =>
        sendingPool.updateSettings(workspaceId, input),
    );

export const useSetMailboxCap = (workspaceId: string) =>
    usePoolWrite(workspaceId, ({ mailboxId, ...input }: SetMailboxPoolInput & { mailboxId: string }) =>
        sendingPool.setMailboxCap(workspaceId, mailboxId, input),
    );

export const useResumeMailbox = (workspaceId: string) =>
    usePoolWrite(workspaceId, ({ mailboxId, ...input }: ResumeMailboxInput & { mailboxId: string }) =>
        sendingPool.resume(workspaceId, mailboxId, input),
    );

export const useUpdateSendingDomain = (workspaceId: string) =>
    usePoolWrite(workspaceId, ({ domainId, ...input }: UpdateSendingDomainInput & { domainId: string }) =>
        sendingPool.updateDomain(workspaceId, domainId, input),
    );

export const useCheckSendingDomain = (workspaceId: string) =>
    usePoolWrite(workspaceId, (domainId: string) => sendingPool.checkDomain(workspaceId, domainId));

/** Starts the Postmaster Tools connect; the caller sends the browser to the answer's `authorizeUrl`. */
export const useConnectPostmaster = (workspaceId: string) =>
    useMutation({ mutationFn: () => sendingPool.connectPostmaster(workspaceId) });

export const useDisconnectPostmaster = (workspaceId: string) =>
    usePoolWrite(workspaceId, () => sendingPool.disconnectPostmaster(workspaceId));
