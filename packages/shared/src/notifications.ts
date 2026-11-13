import type { RecordObject, TaskStatus } from './records.js';
import type { GuardrailSummary } from './guardrails.js';
import type { InvoiceSummary } from './invoices.js';
import type { TransferSummary } from './transfers.js';
import type { CadenceLapseSummary } from './cadence.js';

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
    // REP-1: a sender-reputation finding — to the mailbox's owner, and at `high` to reviewers too.
    'guardrail_alert',
    // INV-1: an invoice on a deal waits for finance (to holders of `invoice:verify`).
    'invoice_needs_review',
    // INV-1: a refund left a deal's verified invoices short of its amount (to holders of `invoice:verify`).
    'invoice_coverage_lost',
    // GUARD-2: a member mailed another member's lead or a customer (to the owner and reviewers).
    'guardrail_poach_suspected',
    // GUARD-3: a member sent cold mail from Gmail instead of the CRM, several recipients in a day (to reviewers).
    'guardrail_off_crm_cold',
    // CADENCE-1: a lead of theirs missed its cadence and rotates after the grace (to the owner).
    'cadence_warning',
    // CADENCE-1: a lead was rotated to the next rep (to managers; the two owners hear `transfer_*`).
    'cadence_rotated',
    // INV-2: a client paid with several open deals: which one is it on? (to the client's owner).
    'payment_needs_deal',
    // INV-2: a client paid with no open deal, so one was made for the payment (to its owner).
    'payment_created_deal',
    // INV-2: NewswireOS reported a payment from no one in the CRM (to holders of `invoice:verify`).
    'payment_unmatched',
    // A reply to an email the member sent from the CRM (a follow-up or sequence step included): every reply.
    'email_replied',
    // The person clicked a link in it: once per send.
    'email_clicked',
    // The person's mail app fetched its tracking image: once per send; approximate (apps preload images).
    'email_opened',
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

/**
 * What a notification is about (GUARD-2): one polymorphic target, whatever the kind. The typed summaries below
 * carry what the bell shows of each; new kinds add a target type here rather than a model of their own.
 */
export const NOTIFICATION_TARGET_TYPES = [
    'task',
    'transfer',
    'guardrail',
    'invoice',
    'cadence',
    'payment',
    // A send (`MailOutbound`): an `email_clicked` / `email_opened`, once per send.
    'email',
    // An inbound message answering a send (`MailMessage`): an `email_replied`, once per reply.
    'reply',
] as const;
export type NotificationTargetType = (typeof NOTIFICATION_TARGET_TYPES)[number];
export interface NotificationTarget {
    type: NotificationTargetType;
    id: string;
}

export interface NotificationView {
    id: string;
    kind: NotificationKind;
    target: NotificationTarget;
    /** The task, for a `task_*` kind; null otherwise. */
    task: TaskSummary | null;
    /** The transfer, for a `transfer_*` kind; null otherwise. */
    transfer: TransferSummary | null;
    /** The guardrail event, for a `guardrail_*` kind; null otherwise. */
    guardrail: GuardrailSummary | null;
    /** The invoice, for an `invoice_*` kind (INV-1); null otherwise. */
    invoice: InvoiceSummary | null;
    /** The lapse, for `cadence_warning` (CADENCE-1); null otherwise. */
    cadence: CadenceLapseSummary | null;
    /** For a `payment_*` kind (INV-2): the paid invoice NewswireOS reported, and the deal it is on. */
    payment: NewswireosPaymentSummary | null;
    /** For an `email_*` kind: the send it is about, whom to, and (a click) the link. */
    email: EmailEngagementSummary | null;
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
    /** The daily email of tasks due or overdue, and (GUARD-2) guardrail alerts of the last day (on unless turned off). */
    taskDigest: boolean;
    /** A bell notification for each reply to an email the member sent (on unless turned off). */
    notifyEmailReplies: boolean;
    /** A bell notification the first time a send of theirs has a link clicked. */
    notifyEmailClicks: boolean;
    /** A bell notification the first time a send of theirs is opened — approximate: mail apps preload images. */
    notifyEmailOpens: boolean;
    /** A short sound in the app when a notification arrives (on unless turned off). */
    notifySound: boolean;
}

/** A send a member made, as the bell shows a reply to, click in or open of it. */
export interface EmailEngagementSummary {
    /** The send, for `email_clicked` / `email_opened`; null for a reply (see `messageId`). */
    outboundId: string | null;
    /** The reply, for `email_replied`; null otherwise. */
    messageId: string | null;
    /** The send's subject; for a reply, the reply's. */
    subject: string;
    /** The person it went to (a reply: who wrote it); null when not in the CRM or since deleted. */
    personId: string | null;
    personName: string | null;
    /** The link clicked, for `email_clicked`; null otherwise. */
    url: string | null;
}

/** INV-2: a paid invoice NewswireOS reported, as the bell shows it. */
export interface NewswireosPaymentSummary {
    id: string;
    invoiceNumber: string;
    clientName: string | null;
    amount: { amountMinor: number; currency: string } | null;
    /** The deal it is on; null while it waits for someone to choose. */
    opportunityId: string | null;
    opportunityName: string | null;
}
