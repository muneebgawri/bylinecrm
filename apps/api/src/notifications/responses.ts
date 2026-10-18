import {
    NOTIFICATION_KINDS,
    RECORD_OBJECTS,
    TASK_STATUSES,
    type MyTaskView,
    type NotificationSettings,
    type NotificationsView,
} from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named } from '../openapi/responses';

/** Task notifications (#192), as the API returns them. */

const isoTime = z.iso.datetime();

const labelledTarget = named(
    'LabelledTarget',
    z.object({
        type: z.enum(RECORD_OBJECTS),
        id,
        label: z
            .string()
            .meta({ description: 'A person’s name, a company’s, a deal’s; a plain label when unreadable.' }),
    }),
);

const taskSummary = {
    id,
    title: z.string(),
    dueAt: isoTime.nullable(),
    targets: z.array(labelledTarget),
};

export const notificationsView = named(
    'Notifications',
    z.object({
        items: z.array(
            z.object({
                id,
                kind: z.enum(NOTIFICATION_KINDS).meta({
                    description:
                        '`task_assigned`: someone else assigned the task to you (a sequence’s task step included). `task_due`: it came due.',
                }),
                task: z.object(taskSummary),
                createdAt: isoTime,
                readAt: isoTime.nullable(),
            }),
        ),
        unread: z.number().int().meta({ description: 'How many of all your notifications are unread.' }),
    }),
);

export const myTaskView = named('MyTask', z.object({ ...taskSummary, status: z.enum(TASK_STATUSES) }));

export const notificationSettingsView = named(
    'NotificationSettings',
    z.object({
        taskDigest: z.boolean().meta({ description: 'The daily email of tasks due or overdue.' }),
    }),
);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _Checks = [
    Assert<Same<z.output<typeof notificationsView>, NotificationsView>>,
    Assert<Same<z.output<typeof myTaskView>, MyTaskView>>,
    Assert<Same<z.output<typeof notificationSettingsView>, NotificationSettings>>,
];
