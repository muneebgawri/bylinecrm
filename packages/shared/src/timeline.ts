import type { DomainEvent, DomainEventType } from './events.js';
import { ACTOR_KINDS, RECORD_OBJECTS, type Actor, type RecordObject } from './records.js';

/**
 * The timeline (PAR-013/014/015; doc 48 §8): one append-only list of what happened to a record.
 * An entry's `kind` is one of three shapes, and the shape says where it came from:
 *
 * - `<object>.<action>` — the record's own domain event (`person.updated`), written by the
 *   timeline's subscriber from the catalogue; the kind IS the event type, never a second spelling.
 * - `linked-<thing>.<action>` — a note, task or attachment on the record was created, changed,
 *   deleted or restored, or a synced email concerns it; one entry per record the thing is on.
 * - `external.<kind>` — something an integration reported (an order paid elsewhere); the API
 *   knows nothing about the integration beyond the name it gives itself.
 */

/**
 * The things that attach to a record and leave `linked-…` entries on it. Synced mail (P2-2) is one:
 * a message is on every record it concerns, so `email.received` leaves `linked-email.received` on
 * each (doc 50 §A: mail is a timeline entry, one list).
 */
export const LINKED_OBJECTS = ['note', 'task', 'attachment', 'email'] as const;
export type LinkedObject = (typeof LINKED_OBJECTS)[number];

export function isLinkedObject(value: unknown): value is LinkedObject {
    return typeof value === 'string' && (LINKED_OBJECTS as readonly string[]).includes(value);
}

export function isRecordObject(value: unknown): value is RecordObject {
    return typeof value === 'string' && (RECORD_OBJECTS as readonly string[]).includes(value);
}

/** The `kind` of the entry a domain event leaves: the type itself, or its `linked-` form. */
export type OwnKind = DomainEventType;
export type LinkedKind = `linked-${DomainEventType & `${LinkedObject}.${string}`}`;
export type TimelineKind = OwnKind | LinkedKind | `external.${string}`;

/**
 * The kind an event's entry carries. One function: the subscriber writes with it, a reader
 * filters with its prefixes (`kinds=linked-note` matches every linked-note action).
 */
export function timelineKindOf(event: Pick<DomainEvent, 'type' | 'object'>): OwnKind | LinkedKind {
    return (isLinkedObject(event.object) ? `linked-${event.type}` : event.type) as OwnKind | LinkedKind;
}

/** An external kind: `external.` then a short snake-case name the integration chose. */
export const EXTERNAL_KIND_PATTERN = /^external\.[a-z][a-z0-9_]{0,63}$/;
export const EXTERNAL_KIND_PREFIX = 'external.';

/**
 * Who an entry is attributed to: a record's actors, plus the two the timeline adds — a stage
 * rule that moved a deal (P1-2), and an integration (`id` is the source it named).
 */
export const TIMELINE_ACTOR_KINDS = [...ACTOR_KINDS, 'rule', 'external'] as const;
export type TimelineActorKind = (typeof TIMELINE_ACTOR_KINDS)[number];
export type TimelineActor = Actor | { kind: 'rule' | 'external'; id: string | null };

/** Page sizes for the timeline: smaller than a record list, because a page is rendered as prose. */
export const TIMELINE_LIMIT_DEFAULT = 30;
export const TIMELINE_LIMIT_MAX = 100;

/** How long `source` and `idempotencyKey` on an external entry may be. */
export const EXTERNAL_SOURCE_MAX = 64;
export const EXTERNAL_IDEMPOTENCY_KEY_MAX = 128;
