import {
    GUARDRAIL_KINDS,
    NOTIFICATION_KINDS,
    RECORD_OBJECTS,
    TASK_STATUSES,
    TRANSFER_STATUSES,
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

const transferMember = z.object({ memberId: id, name: z.string().nullable() });
const transferSummary = z.object({
    id,
    object: z.enum(RECORD_OBJECTS),
    recordId: id,
    recordLabel: z.string(),
    from: transferMember.nullable(),
    to: transferMember,
    status: z.enum(TRANSFER_STATUSES),
    reason: z.string().nullable(),
});

const guardrailSummary = z.object({
    id,
    kind: z.enum(GUARDRAIL_KINDS),
    actor: transferMember.nullable(),
    count: z.number().int(),
});

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
                        '`task_assigned`: someone else assigned the task to you (a sequence’s task step included). `task_due`: it came due. `transfer_*` (OWN-1): a record offered to you, your offer decided, or a manager moved a record to or from you. `guardrail_repeat_blocks` (GUARD-1): a member was stopped three times in a day from mailing others’ leads.',
                }),
                task: z.object(taskSummary).nullable().meta({ description: 'For a `task_*` kind.' }),
                transfer: transferSummary.nullable().meta({ description: 'For a `transfer_*` kind.' }),
                guardrail: guardrailSummary.nullable().meta({
                    description: 'For a `guardrail_*` kind (GUARD-1): the event, who it is about, and the day’s count.',
                }),
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
