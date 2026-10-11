import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sendingPool } from './endpoints';
import { keys } from './queries';
import type {
    ResumeMailboxInput,
    SetMailboxPoolInput,
    UpdateSendingDomainInput,
    UpdateSendingPoolSettingsInput,
} from './types';

/**
 * The sending pool's reads and writes (P3-2). They live apart from `queries.ts` so they load with
 * the Mailboxes chunk. Every write invalidates the one view, which holds settings, mailboxes and
 * domains together.
 */
const poolKey = keys.sendingPool;

export function useSendingPool(workspaceId: string, enabled = true) {
    return useQuery({
        queryKey: poolKey(workspaceId),
        queryFn: ({ signal }) => sendingPool.view(workspaceId, signal),
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
