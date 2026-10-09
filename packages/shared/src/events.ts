import type { StageHistoryReason } from './pipelines.js';
import { RECORD_OBJECTS, type Actor, type RecordTarget } from './records.js';

/**
 * The objects an event can be about: the record objects, the things attached to them, and the
 * things that happen to them — a deal's stage changing (P1-2), mail (P2) and meetings (P3).
 * One list; `ObjectOfEvent` derives an event's object from its type against it.
 */
export const EVENT_OBJECTS = [...RECORD_OBJECTS, 'note', 'task', 'attachment', 'email', 'meeting'] as const;
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
    // Things a stage rule reacts to. Mail (P2) and meetings (P3) publish them; `related` names the
    // person and company they concern, which is how the rule engine finds the deals.
    'email.replied',
    'meeting.booked',
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
