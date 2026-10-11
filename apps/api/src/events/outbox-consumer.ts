import { DiscoveryService } from '@nestjs/core';
import type { DomainEvent } from '@bylinecrm/shared';

/** A committed domain event as the relay hands it over: the event and its outbox id. */
export interface DeliveredEvent {
    /**
     * The outbox row's id. The same on every delivery of the event, so a consumer keys what it
     * writes on it and a redelivery writes nothing new.
     */
    readonly id: string;
    readonly event: DomainEvent;
}

/**
 * Something that reacts to committed domain events: the timeline, webhooks, the stage rules, mail
 * re-matching. Delivery is **at least once** — after a crash or a failed sibling an event can
 * arrive again — so `consume` must be idempotent on `delivered.id`. A consumer that throws is
 * retried later, alone (the relay remembers which consumers finished); it never fails the request
 * that made the change, which committed before the consumer ran.
 */
export interface OutboxConsumer {
    /** Whether the consumer wants events of this type; the relay skips it otherwise. */
    accepts(event: DomainEvent): boolean;
    consume(delivered: DeliveredEvent): Promise<void>;
}

/**
 * Marks a provider as an outbox consumer under a stable name. The name is stored with each event
 * the consumer finishes, so it must never change once deployed; renaming one redelivers every open
 * event to it under the new name.
 */
export const OutboxConsumerOf = DiscoveryService.createDecorator<string>();
