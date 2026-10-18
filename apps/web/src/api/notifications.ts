import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import type { MyTaskView, NotificationSettingsView, NotificationsView } from './types';

/**
 * A member's task notifications (#192): the bell's list and unread count, marking read, the digest
 * setting, and My tasks. Their own, always — the API answers for the caller only.
 */

/** How often the bell asks again while the app is open. */
export const NOTIFICATIONS_POLL_MS = 60_000;

const base = (workspaceId: string) => ['w', workspaceId, 'notifications'] as const;
const keys = {
    inbox: (workspaceId: string) => [...base(workspaceId), 'inbox'] as const,
    settings: (workspaceId: string) => [...base(workspaceId), 'settings'] as const,
    myTasks: (workspaceId: string) => [...base(workspaceId), 'my-tasks'] as const,
};

export const notifications = {
    inbox: (workspaceId: string, signal?: AbortSignal) =>
        request<NotificationsView>('GET', workspacePath(workspaceId, '/notifications'), { signal }),
    markRead: (workspaceId: string, ids?: readonly string[]) =>
        request<void>('POST', workspacePath(workspaceId, '/notifications/read'), { body: ids ? { ids } : {} }),
    settings: (workspaceId: string, signal?: AbortSignal) =>
        request<NotificationSettingsView>('GET', workspacePath(workspaceId, '/notification-settings'), { signal }),
    updateSettings: (workspaceId: string, input: NotificationSettingsView) =>
        request<NotificationSettingsView>('PUT', workspacePath(workspaceId, '/notification-settings'), { body: input }),
    myTasks: (workspaceId: string, signal?: AbortSignal) =>
        request<MyTaskView[]>('GET', workspacePath(workspaceId, '/my-tasks'), { signal }),
    completeTask: (workspaceId: string, taskId: string) =>
        request<unknown>('PATCH', workspacePath(workspaceId, `/tasks/${taskId}`), { body: { status: 'done' } }),
};

export function useNotifications(workspaceId: string) {
    return useQuery({
        queryKey: keys.inbox(workspaceId),
        queryFn: ({ signal }) => notifications.inbox(workspaceId, signal),
        refetchInterval: NOTIFICATIONS_POLL_MS,
    });
}

export function useMarkNotificationsRead(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (ids?: readonly string[]) => notifications.markRead(workspaceId, ids),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.inbox(workspaceId) }),
    });
}

export function useNotificationSettings(workspaceId: string, enabled = true) {
    return useQuery({
        queryKey: keys.settings(workspaceId),
        queryFn: ({ signal }) => notifications.settings(workspaceId, signal),
        enabled,
    });
}

export function useUpdateNotificationSettings(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: NotificationSettingsView) => notifications.updateSettings(workspaceId, input),
        onSuccess: (saved) => client.setQueryData(keys.settings(workspaceId), saved),
    });
}

export function useMyTasks(workspaceId: string) {
    return useQuery({
        queryKey: keys.myTasks(workspaceId),
        queryFn: ({ signal }) => notifications.myTasks(workspaceId, signal),
    });
}

/** Completes one of my tasks; it leaves My tasks, and the bell is asked again. */
export function useCompleteMyTask(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (taskId: string) => notifications.completeTask(workspaceId, taskId),
        onSuccess: () => client.invalidateQueries({ queryKey: base(workspaceId) }),
    });
}
