import type { EmailReply, EmailSummary } from './mail.js';
import type { StageHistoryReason } from './pipelines.js';
import { RECORD_OBJECTS, type Actor, type RecordTarget } from './records.js';
import type { EmailBounce, MailboxPause } from './sending-pool.js';
import type { EmailFailure, EnrolmentEventPayload } from './sequences.js';
import type { EmailTrackingPayload } from './tracking.js';
import type { SuppressionEventPayload } from './suppression.js';

/**
 * The objects an event can be about: the record objects, the things attached to them, and the
 * things that happen to them — a deal's stage changing (P1-2), mail (P2) and meetings (P3) — and
 * the workspace's email templates (P2-4).
 * One list; `ObjectOfEvent` derives an event's object from its type against it.
 */
export const EVENT_OBJECTS = [
    ...RECORD_OBJECTS,
    'note',
    'task',
    'attachment',
    'email',
    'meeting',
    'template',
    'mailbox',
    'suppression',
    'sequence',
    'enrolment',
] as const;
export type EventObject = (typeof EVENT_OBJECTS)[number];

/**
 * Event types whose prefix is a word for the object rather than the object's own name: a
 * `deal.*` event is about an opportunity. One table; `ObjectOfEvent` and `objectOfEvent` read it,
 * so the timeline writes a `deal.stage_changed` entry on the opportunity with no special case.
 */
export const EVENT_PREFIX_OBJECTS = { deal: 'opportunity' } as const satisfies Record<string, EventObject>;

/**
 * The domain events the API publishes after a record mutation commits. One catalogue: the
 * publisher, the timeline (P1-3), outbound webhooks (P1-5) and any test read this list. A string
 * that is not here is not an event.
 */
export const DOMAIN_EVENT_TYPES = [
    'person.created',
    'person.updated',
    'person.deleted',
    'person.restored',
    'company.created',
    'company.updated',
    'company.deleted',
    'company.restored',
    'opportunity.created',
    'opportunity.updated',
    'opportunity.deleted',
    'opportunity.restored',
    'note.created',
    'note.updated',
    'note.deleted',
    'note.restored',
    'task.created',
    'task.updated',
    'task.deleted',
    'task.restored',
    'attachment.created',
    'attachment.deleted',
    'attachment.restored',
    // A deal's stage (P1-2): about the opportunity (`recordId`); `diff.stageId` says from where to
    // where, as any updated field would, and `stage` adds the pipeline and the reason. One move is
    // exactly one of these three (P1-2a): `deal.won` / `deal.lost` for a move into a won / lost
    // stage, `deal.stage_changed` for every other move, reopening included. To see every move,
    // subscribe to all three.
    'deal.stage_changed',
    'deal.won',
    'deal.lost',
    // Email templates (P2-4): about the template (`recordId`). They leave no timeline entry — a
    // template is not on a record — but a webhook endpoint may subscribe to them.
    'template.created',
    'template.updated',
    'template.deleted',
    'template.restored',
    // Mail a connected mailbox synced (P2-2): about the message (`recordId`); `targets` are the
    // records it is on — each matched person, their company and their open deals — so the timeline
    // writes one entry per target, and `email` describes the message (never its body).
    'email.received',
    'email.sent',
    // A message stored earlier now concerns a person (P2-2): they gained its address, or were
    // created or restored with it. Once per newly linked (message, person); `targets` are that
    // person's records not already carrying the message, `link.personId` the person, `email` the
    // message. The timeline writes the same entries an import would; webhooks deliver this event
    // and never a second `email.received` / `email.sent`.
    'email.linked',
    // Things a stage rule reacts to. Mail (P2) and meetings (P3) publish them; `related` names the
    // person and company they concern, which is how the rule engine finds the deals. `email.replied`
    // (P2-3): an inbound message answers one the CRM sent — by its In-Reply-To / References, or in
    // the same Gmail thread — once per reply; `email` describes the reply and `reply` what it answers.
    // It writes no timeline entry of its own: the reply is on the timeline as the `email.received`.
    'email.replied',
    // A send scheduled for later, and one called off before it went (P2-5); `recordId` is the send
    // (the outbound message). No `targets`: nothing is on a record's timeline until it is sent, as
    // `email.sent`. Webhooks deliver them.
    'email.scheduled',
    'email.cancelled',
    // A pool mailbox received a bounce report (P3-2); `recordId` is the report as stored, `bounce`
    // the address that failed and the send. A permanent one suppresses the address and counts
    // towards the mailbox's bounce rate. No timeline entry; webhooks deliver it.
    'email.bounced',
    // A send failed for good (P3-3): the mailbox's or the recipient's state, Gmail's refusal, a check
    // at a scheduled send's time. `recordId` is the send, `failure` why. No timeline entry (nothing was
    // sent); a sequence reads it to reschedule, hold or stop the step; webhooks deliver it.
    'email.failed',
    // Tracking (P3-4, FR-CRMS-8): a tracked link in a sent message was followed, or its open pixel
    // fetched. `recordId` is the send, `tracking` the link, the person and the step; `related` and
    // `targets` the person — the timeline writes `linked-email.clicked` / `linked-email.opened` on
    // them. A click may drive a stage rule like a reply; an open is indicative and never does. A
    // scanner's hit (docs/design-notes/P3-4.md) is recorded as neither.
    'email.clicked',
    'email.opened',
    'meeting.booked',
    // A connected Google mailbox (P2-1); `recordId` is the mailbox. Not a record: the timeline
    // writes nothing for these, webhooks deliver them.
    'mailbox.connected',
    'mailbox.disconnected',
    'mailbox.reconnect_needed',
    // A pool mailbox paused for its bounce or complaint rate, and resumed by an admin (P3-2,
    // FR-CRMS-6, -13); `recordId` is the mailbox, `pause` why.
    'mailbox.paused',
    'mailbox.resumed',
    // An address put on, or lifted from, the workspace's suppression list (P3-1); `recordId` is the
    // entry, `suppression` what it says, `related` and `targets` the person the address belongs to
    // when known — the timeline writes a `linked-suppression.*` entry on that person (#114).
    'suppression.added',
    'suppression.removed',
    // Sequences (P3-3, FR-CRMS-5): `recordId` is the sequence; `sequence.updated` carries the diff
    // (its status included). Not records: no timeline entry; webhooks deliver them.
    'sequence.created',
    'sequence.updated',
    'sequence.archived',
    // A person's enrolment in a sequence (P3-3): `recordId` is the enrolment, `enrolment` the sequence,
    // the person, the step and — for a stop — the reason; `related` the person.
    'enrolment.created',
    'enrolment.step_completed',
    'enrolment.held',
    'enrolment.stopped',
    'enrolment.finished',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

type PrefixOf<T extends string> = T extends `${infer O}.${string}` ? O : never;

/** The object an event type is about: the part before the dot, or what `EVENT_PREFIX_OBJECTS` maps it to. */
export type ObjectOfEvent<T extends DomainEventType> =
    PrefixOf<T> extends keyof typeof EVENT_PREFIX_OBJECTS
        ? (typeof EVENT_PREFIX_OBJECTS)[PrefixOf<T>]
        : PrefixOf<T> extends EventObject
          ? PrefixOf<T>
          : never;

export function objectOfEvent<T extends DomainEventType>(type: T): ObjectOfEvent<T> {
    const prefix = type.slice(0, type.indexOf('.'));
    return ((EVENT_PREFIX_OBJECTS as Record<string, EventObject>)[prefix] ?? prefix) as ObjectOfEvent<T>;
}

/** One field's change, as `updated` events report it. */
export interface FieldChange {
    from: unknown;
    to: unknown;
}

/**
 * Who caused an event: a record's actors, or — for a move the rule engine made — the rule
 * (`id` is the rule's). The timeline shows a rule's move as the rule's, not the system's.
 */
export type EventActor = Actor | { kind: 'rule'; id: string };

interface DomainEventBase {
    workspaceId: string;
    actor: EventActor;
    /** ISO 8601, UTC. */
    occurredAt: string;
    recordId: string;
    /** Present on `updated` events: the fields that changed, by name. */
    diff?: Record<string, FieldChange>;
    /**
     * Present on note, task, attachment and synced-mail events: the records the thing is on, so a
     * subscriber (the timeline, PAR-014) can write an entry on each of them.
     */
    targets?: RecordTarget[];
    /**
     * Present on `email.*` and `meeting.*` events: the records the thing concerns (the person who
     * replied, their company). A stage rule resolves the deals to move from these.
     */
    related?: RecordTarget[];
    /** Present on `deal.*` events: the move that happened. */
    stage?: StageChange;
    /** Present on `email.received`, `email.sent`, `email.linked` and `email.replied`: the message, without its body. */
    email?: EmailSummary;
    /** Present on `email.replied`: what the reply answers, who wrote it and the deals it concerns. */
    reply?: EmailReply;
    /** Present on `email.linked`: the person the message is now linked to. */
    link?: { personId: string };
    /** Present on `suppression.*`: the entry's address, why it is there and who it belongs to. */
    suppression?: SuppressionEventPayload;
    /** Present on `email.bounced`: the address that failed, how, and the send. */
    bounce?: EmailBounce;
    /** Present on `mailbox.paused` (and `mailbox.resumed`, the pause it ends): why. */
    pause?: MailboxPause;
    /** Present on `email.failed`: the send and why. */
    failure?: EmailFailure;
    /** Present on `enrolment.*`. */
    enrolment?: EnrolmentEventPayload;
    /** Present on `email.clicked` and `email.opened`: the send, the person, the link and the step. */
    tracking?: EmailTrackingPayload;
}

/** One stage change, as `deal.stage_changed`, `deal.won` and `deal.lost` all report it. */
export interface StageChange {
    pipelineId: string;
    fromStageId: string | null;
    toStageId: string;
    reason: StageHistoryReason;
}

/** A domain event, discriminated by `type`; `object` is derived from it and never disagrees. */
export type DomainEvent = {
    [T in DomainEventType]: DomainEventBase & { type: T; object: ObjectOfEvent<T> };
}[DomainEventType];

export function isDomainEventType(value: unknown): value is DomainEventType {
    return typeof value === 'string' && (DOMAIN_EVENT_TYPES as readonly string[]).includes(value);
}
