import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { OwnershipPushService } from './ownership-push.service';

/**
 * PNW-765: every completed ownership transfer becomes a delivery to NewswireOS, when the workspace turned the push
 * on. Nothing is sent from here — the worker sends. An import's owner fill (`internal`, `import_fill`) is skipped.
 * A failure is thrown to the relay, which retries; deliveries are keyed on the event, so a retry never sends twice.
 */
@Injectable()
@OutboxConsumerOf('newswireos-ownership')
export class OwnershipPushSubscriber implements OutboxConsumer {
    constructor(private readonly push: OwnershipPushService) {}

    accepts(event: DomainEvent): boolean {
        return OwnershipPushService.accepts(event);
    }

    async consume(delivered: DeliveredEvent): Promise<void> {
        await this.push.enqueueForEvent(delivered);
    }
}
