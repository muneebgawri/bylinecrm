import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { isDomainEventType, type DomainEvent } from '@bylinecrm/shared';
import { WebhooksService } from './webhooks.service';

/**
 * The second listener on the bus (the timeline is the first): every catalogue event becomes a
 * delivery row and a queued job for each endpoint subscribed to it. Nothing is sent from here —
 * the bus is in-process and synchronous to the request; what must survive a restart goes onto
 * the queue. A failure to enqueue is logged, not thrown into a request that has already answered.
 */
@Injectable()
export class WebhooksSubscriber {
    private readonly logger = new Logger(WebhooksSubscriber.name);

    constructor(private readonly webhooks: WebhooksService) {}

    @OnEvent('**')
    async onDomainEvent(event: unknown): Promise<void> {
        if (!isDomainEvent(event)) return;
        try {
            await this.webhooks.enqueueForEvent(event);
        } catch (error) {
            this.logger.error(
                `webhook deliveries not enqueued for ${event.type} ${event.recordId} in ${event.workspaceId}`,
                error instanceof Error ? error.stack : String(error),
            );
        }
    }
}

function isDomainEvent(value: unknown): value is DomainEvent {
    return (
        typeof value === 'object' &&
        value !== null &&
        isDomainEventType((value as { type?: unknown }).type) &&
        typeof (value as { workspaceId?: unknown }).workspaceId === 'string' &&
        typeof (value as { recordId?: unknown }).recordId === 'string'
    );
}
