import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { query, workspacePath } from './endpoints';
import { keys } from './queries';
import type { MeetingKpisView, MeetingPage, PutSlotlineSettingsInput, SlotlineSettingsView } from './types';

/** How many meetings the Team page lists for a period; the rest are a "Load more" away in a later package. */
export const MEETINGS_SHOWN = 50;

/**
 * Meetings from members' Google Calendars and each member's meeting KPIs (CAL-1). An admin reads every
 * member's; anyone else, their own — the API decides, the page shows what it answers.
 */
export const meetings = {
    list: (workspaceId: string, params: { from: string; to: string; limit?: number }, signal?: AbortSignal) =>
        request<MeetingPage>(
            'GET',
            workspacePath(workspaceId, `/meetings${query({ from: params.from, to: params.to, limit: params.limit })}`),
            { signal },
        ),
    kpis: (workspaceId: string, params: { from: string; to: string }, signal?: AbortSignal) =>
        request<MeetingKpisView>('GET', workspacePath(workspaceId, `/meetings/kpis${query(params)}`), { signal }),
};

export const useMeetingKpis = (workspaceId: string, params: { from: string; to: string }) =>
    useQuery({
        queryKey: keys.meetingKpis(workspaceId, params),
        queryFn: ({ signal }) => meetings.kpis(workspaceId, params, signal),
    });

export const useMeetings = (workspaceId: string, params: { from: string; to: string }) =>
    useQuery({
        queryKey: keys.meetingList(workspaceId, params),
        queryFn: ({ signal }) => meetings.list(workspaceId, { ...params, limit: MEETINGS_SHOWN }, signal),
    });

/** The workspace's Slotline booking site (CAL-2): an admin's. */
export const slotline = {
    get: (workspaceId: string, signal?: AbortSignal) =>
        request<SlotlineSettingsView>('GET', workspacePath(workspaceId, '/integrations/slotline'), { signal }),
    put: (workspaceId: string, input: PutSlotlineSettingsInput) =>
        request<SlotlineSettingsView>('PUT', workspacePath(workspaceId, '/integrations/slotline'), { body: input }),
    rotate: (workspaceId: string) =>
        request<SlotlineSettingsView>('POST', workspacePath(workspaceId, '/integrations/slotline/rotate')),
    remove: (workspaceId: string) => request<void>('DELETE', workspacePath(workspaceId, '/integrations/slotline')),
};

export const useSlotlineSettings = (workspaceId: string) =>
    useQuery({
        queryKey: keys.slotlineSettings(workspaceId),
        queryFn: ({ signal }) => slotline.get(workspaceId, signal),
    });

/** A write answers with the settings as they now stand; that is what the page shows. */
function useSlotlineWrite<I>(workspaceId: string, write: (input: I) => Promise<SlotlineSettingsView | void>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: (view) =>
            view
                ? client.setQueryData(keys.slotlineSettings(workspaceId), view)
                : client.invalidateQueries({ queryKey: keys.slotlineSettings(workspaceId) }),
    });
}

export const usePutSlotline = (workspaceId: string) =>
    useSlotlineWrite(workspaceId, (input: PutSlotlineSettingsInput) => slotline.put(workspaceId, input));
export const useRotateSlotline = (workspaceId: string) =>
    useSlotlineWrite(workspaceId, () => slotline.rotate(workspaceId));
export const useRemoveSlotline = (workspaceId: string) =>
    useSlotlineWrite(workspaceId, () => slotline.remove(workspaceId));
