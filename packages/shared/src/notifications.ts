import type { RecordObject, TaskStatus } from './records.js';
import type { GuardrailSummary } from './guardrails.js';
import type { TransferSummary } from './transfers.js';

/**
 * What members are told about their tasks (#192): a task someone else assigned them (a sequence's
 * task step included), a task that came due, the open tasks they hold, and whether they get the
 * daily email of what is due. One vocabulary for the API, the web app and the tests.
 */

export const NOTIFICATION_KINDS = [
    'task_assigned',
    'task_due',
    // Ownership transfers (OWN-1): the receiver of a proposal; the proposer when it is decided; both
    // parties when a manager moved the record without asking.
    'transfer_proposed',
    'transfer_accepted',
    'transfer_declined',
    'transfer_received',
    'transfer_taken',
    // GUARD-1: a member was blocked three times in a day from mailing others' leads (to reviewers).
    'guardrail_repeat_blocks',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** A record a task is about, with the name it is known by (a person's name, a company's, a deal's). */
export interface LabelledTarget {
    type: RecordObject;
    id: string;
    label: string;
}

/** A task as the bell, My tasks and the digest show it. */
export interface TaskSummary {
    id: string;
    title: string;
    /** ISO 8601, or null for no due date. */
    dueAt: string | null;
    targets: LabelledTarget[];
}

export interface NotificationView {
    id: string;
    kind: NotificationKind;
    /** The task, for a `task_*` kind; null otherwise. */
    task: TaskSummary | null;
    /** The transfer, for a `transfer_*` kind; null otherwise. */
    transfer: TransferSummary | null;
    /** The guardrail event, for a `guardrail_*` kind; null otherwise. */
    guardrail: GuardrailSummary | null;
    /** ISO 8601. */
    createdAt: string;
    /** ISO 8601; null while unread. */
    readAt: string | null;
}

/** `GET /notifications`: the member's latest, newest first, and how many of all theirs are unread. */
export interface NotificationsView {
    items: NotificationView[];
    unread: number;
}

/** How many notifications `GET /notifications` returns. */
export const NOTIFICATIONS_PAGE = 50;

/** One of the member's open tasks (`GET /my-tasks`): not done, not deleted, soonest due first. */
export interface MyTaskView extends TaskSummary {
    status: TaskStatus;
}

/** A member's notification settings in a workspace. */
export interface NotificationSettings {
    /** The daily email of tasks due or overdue (on unless the member turned it off). */
    taskDigest: boolean;
}
