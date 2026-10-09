import type { Actor, RecordObject } from './records.js';

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
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** The object an event type is about: the part before the dot. */
export type ObjectOfEvent<T extends DomainEventType> = T extends `${infer O}.${string}`
    ? O extends RecordObject
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
}

/** A domain event, discriminated by `type`; `object` is derived from it and never disagrees. */
export type DomainEvent = {
    [T in DomainEventType]: DomainEventBase & { type: T; object: ObjectOfEvent<T> };
}[DomainEventType];

export function isDomainEventType(value: unknown): value is DomainEventType {
    return typeof value === 'string' && (DOMAIN_EVENT_TYPES as readonly string[]).includes(value);
}
