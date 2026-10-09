import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { isDomainEventType, type DomainEvent } from '@bylinecrm/shared';
import { TimelineService } from './timeline.service';

/**
 * The one listener that turns domain events into timeline entries. It subscribes to every
 * channel and keeps only catalogue events, so an event a later package adds to the catalogue
 * (P1-2's stage moves) is on the timeline the day it is published, with no edit here.
 *
 * The bus delivers synchronously to the request that published, so a failure here is caught
 * and logged rather than thrown: the write that caused the event has already committed, and a
 * timeline entry that could not be written is a defect to fix, not a reason to fail a request
 * after the fact. `timeline.*` is never published, so nothing here can loop.
 */
@Injectable()
export class TimelineSubscriber {
    private readonly logger = new Logger(TimelineSubscriber.name);

    constructor(private readonly timeline: TimelineService) {}

    @OnEvent('**')
    async onDomainEvent(event: unknown): Promise<void> {
        if (!isDomainEvent(event)) return;
        try {
            await this.timeline.writeFor(event);
        } catch (error) {
            this.logger.error(
                `timeline entry not written for ${event.type} ${event.recordId} in ${event.workspaceId}`,
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
