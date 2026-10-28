import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import type { AddSmtp2GoMailboxInput, Smtp2GoMailboxView, Smtp2GoTestResult } from './types';

/**
 * SMTP2Go pool mailboxes (TRANS-1): the outreach pool's second transport, an admin's to add. The API key is sent
 * once and never comes back; the hook URL and its Authorization header are what the admin gives SMTP2Go.
 */

const keys = {
    list: (workspaceId: string) => ['w', workspaceId, 'smtp2go', 'mailboxes'] as const,
    mailboxes: (workspaceId: string) => ['w', workspaceId, 'mailboxes'] as const,
};

const path = (workspaceId: string, rest = '') => workspacePath(workspaceId, `/smtp2go/mailboxes${rest}`);

const smtp2go = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<Smtp2GoMailboxView[]>('GET', path(workspaceId), { signal }),
    add: (workspaceId: string, input: AddSmtp2GoMailboxInput) =>
        request<Smtp2GoMailboxView>('POST', path(workspaceId), { body: input }),
    putKey: (workspaceId: string, mailboxId: string, apiKey: string) =>
        request<Smtp2GoMailboxView>('PUT', path(workspaceId, `/${mailboxId}/api-key`), { body: { apiKey } }),
    rotate: (workspaceId: string, mailboxId: string) =>
        request<Smtp2GoMailboxView>('POST', path(workspaceId, `/${mailboxId}/rotate-secret`)),
    test: (workspaceId: string, mailboxId: string) =>
        request<Smtp2GoTestResult>('POST', path(workspaceId, `/${mailboxId}/test`)),
};

export const useSmtp2GoMailboxes = (workspaceId: string) =>
    useQuery({ queryKey: keys.list(workspaceId), queryFn: ({ signal }) => smtp2go.list(workspaceId, signal) });

function useSmtp2GoWrite<I>(workspaceId: string, write: (input: I) => Promise<Smtp2GoMailboxView>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: () => {
            void client.invalidateQueries({ queryKey: keys.list(workspaceId) });
            void client.invalidateQueries({ queryKey: keys.mailboxes(workspaceId) });
        },
    });
}

export const useAddSmtp2GoMailbox = (workspaceId: string) =>
    useSmtp2GoWrite(workspaceId, (input: AddSmtp2GoMailboxInput) => smtp2go.add(workspaceId, input));
export const usePutSmtp2GoKey = (workspaceId: string) =>
    useSmtp2GoWrite(workspaceId, (input: { mailboxId: string; apiKey: string }) =>
        smtp2go.putKey(workspaceId, input.mailboxId, input.apiKey),
    );
export const useRotateSmtp2GoSecret = (workspaceId: string) =>
    useSmtp2GoWrite(workspaceId, (mailboxId: string) => smtp2go.rotate(workspaceId, mailboxId));

/** "Send test": one message through the mailbox's SMTP2Go key to the admin's own address. */
export function useSendSmtp2GoTest(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (mailboxId: string) => smtp2go.test(workspaceId, mailboxId),
        onSuccess: () => void client.invalidateQueries({ queryKey: keys.list(workspaceId) }),
    });
}
