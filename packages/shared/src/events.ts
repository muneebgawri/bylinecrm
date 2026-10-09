import type { StageHistoryReason } from './pipelines.js';
import { RECORD_OBJECTS, type Actor, type RecordTarget } from './records.js';

/**
 * The objects an event can be about: the record objects, the things attached to them, and the
 * things that happen to them — a deal's stage changing (P1-2), mail (P2) and meetings (P3).
 * One list; `ObjectOfEvent` derives an event's object from its type against it.
 */
export const EVENT_OBJECTS = [...RECORD_OBJECTS, 'note', 'task', 'attachment', 'deal', 'email', 'meeting'] as const;
export type EventObject = (typeof EVENT_OBJECTS)[number];

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
    // A deal's stage (P1-2). `recordId` is the opportunity; `stage` says from where to where and why.
    'deal.stage_changed',
    'deal.won',
    'deal.lost',
    // Things a stage rule reacts to. Mail (P2) and meetings (P3) publish them; `related` names the
    // person and company they concern, which is how the rule engine finds the deals.
    'email.replied',
    'meeting.booked',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** The object an event type is about: the part before the dot. */
export type ObjectOfEvent<T extends DomainEventType> = T extends `${infer O}.${string}`
    ? O extends EventObject
        ? O
        : never
    : never;

/** One field's change, as `updated` events report it. */
export interface FieldChange {
    from: unknown;
    to: unknown;
}

interface DomainEventBase {
    workspaceId: string;
    actor: Actor;
    /** ISO 8601, UTC. */
    occurredAt: string;
    recordId: string;
    /** Present on `updated` events: the fields that changed, by name. */
    diff?: Record<string, FieldChange>;
    /**
     * Present on note, task and attachment events: the records the thing is attached to, so a
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
}

/** One stage change, as `deal.stage_changed` reports it. */
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
