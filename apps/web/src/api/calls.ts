import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import { keys } from './queries';
import type { CallView, LogCallInput, PatchCallInput, QuoSettingsView } from './types';

/**
 * Calls (CALL-1): the workspace's Quo link (an admin's), and a person's calls — Quo's reports and the ones a
 * member logs from the Call panel.
 */

const quoKey = (workspaceId: string) => ['w', workspaceId, 'integrations', 'quo'] as const;
const callsKey = (workspaceId: string, personId: string) => ['w', workspaceId, 'calls', personId] as const;

const api = {
    quo: (workspaceId: string, signal?: AbortSignal) =>
        request<QuoSettingsView>('GET', workspacePath(workspaceId, '/integrations/quo'), { signal }),
    putQuo: (workspaceId: string, apiKey: string) =>
        request<QuoSettingsView>('PUT', workspacePath(workspaceId, '/integrations/quo'), { body: { apiKey } }),
    rematchQuo: (workspaceId: string) =>
        request<QuoSettingsView>('POST', workspacePath(workspaceId, '/integrations/quo/rematch')),
    removeQuo: (workspaceId: string) => request<void>('DELETE', workspacePath(workspaceId, '/integrations/quo')),
    calls: (workspaceId: string, personId: string, signal?: AbortSignal) =>
        request<CallView[]>('GET', workspacePath(workspaceId, `/calls?personId=${encodeURIComponent(personId)}`), {
            signal,
        }),
    log: (workspaceId: string, input: LogCallInput) =>
        request<CallView>('POST', workspacePath(workspaceId, '/calls'), { body: input }),
    patch: (workspaceId: string, id: string, input: PatchCallInput) =>
        request<CallView>('PATCH', workspacePath(workspaceId, `/calls/${id}`), { body: input }),
};

export const useQuoSettings = (workspaceId: string) =>
    useQuery({ queryKey: quoKey(workspaceId), queryFn: ({ signal }) => api.quo(workspaceId, signal) });

function useQuoWrite<I>(workspaceId: string, write: (input: I) => Promise<QuoSettingsView | void>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: (view) =>
            view
                ? client.setQueryData(quoKey(workspaceId), view)
                : client.invalidateQueries({ queryKey: quoKey(workspaceId) }),
    });
}
export const usePutQuo = (workspaceId: string) =>
    useQuoWrite(workspaceId, (apiKey: string) => api.putQuo(workspaceId, apiKey));
export const useRematchQuo = (workspaceId: string) => useQuoWrite(workspaceId, () => api.rematchQuo(workspaceId));
export const useRemoveQuo = (workspaceId: string) => useQuoWrite(workspaceId, () => api.removeQuo(workspaceId));

export const useCalls = (workspaceId: string, personId: string) =>
    useQuery({
        queryKey: callsKey(workspaceId, personId),
        queryFn: ({ signal }) => api.calls(workspaceId, personId, signal),
    });

/** Logs a call; the person's calls and timeline are read again. */
export function useLogCall(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: LogCallInput) => api.log(workspaceId, input),
        onSuccess: (call) => {
            if (call.personId) void client.invalidateQueries({ queryKey: callsKey(workspaceId, call.personId) });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline'] });
            void client.invalidateQueries({ queryKey: keys.today(workspaceId) });
        },
    });
}

export function usePatchCall(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ id, ...input }: PatchCallInput & { id: string }) => api.patch(workspaceId, id, input),
        onSuccess: (call) => {
            if (call.personId) void client.invalidateQueries({ queryKey: callsKey(workspaceId, call.personId) });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline'] });
        },
    });
}
