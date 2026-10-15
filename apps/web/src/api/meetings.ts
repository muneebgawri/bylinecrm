import { useQuery } from '@tanstack/react-query';
import { request } from './client';
import { query, workspacePath } from './endpoints';
import { keys } from './queries';
import type { MeetingKpisView, MeetingPage } from './types';

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
