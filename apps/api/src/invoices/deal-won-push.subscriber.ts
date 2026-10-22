import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { DealWonPushService } from './deal-won-push.service';

/**
 * PNW-766: every won deal becomes a delivery to NewswireOS, when the workspace turned the push on. Nothing is sent
 * from here — the worker sends. A failure is thrown to the relay, which retries; deliveries are keyed on the event,
 * so a retry never sends twice.
 */
@Injectable()
@OutboxConsumerOf('newswireos-deal-won')
export class DealWonPushSubscriber implements OutboxConsumer {
    constructor(private readonly push: DealWonPushService) {}

    accepts(event: DomainEvent): boolean {
        return DealWonPushService.accepts(event);
    }

    async consume(delivered: DeliveredEvent): Promise<void> {
        await this.push.enqueueForEvent(delivered);
    }
}
