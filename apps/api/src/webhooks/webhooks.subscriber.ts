import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { WebhooksService } from './webhooks.service';

/**
 * The webhook consumer (the timeline is another): every recorded event becomes a delivery row and
 * a queued job for each endpoint subscribed to it. Nothing is sent from here — the worker sends.
 * A failure is thrown to the relay, which retries; deliveries are keyed on the event, so a retry
 * never sends twice.
 */
@Injectable()
@OutboxConsumerOf('webhooks')
export class WebhooksSubscriber implements OutboxConsumer {
    constructor(private readonly webhooks: WebhooksService) {}

    /** Every event but one kept in BylineCRM (`internal`: an import's owner fill). */
    accepts(event: DomainEvent): boolean {
        return event.internal !== true;
    }

    async consume(delivered: DeliveredEvent): Promise<void> {
        await this.webhooks.enqueueForEvent(delivered);
    }
}
