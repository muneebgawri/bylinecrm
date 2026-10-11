import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { TimelineService } from './timeline.service';

/**
 * The one consumer that turns domain events into timeline entries. It takes every event and
 * writes what `writeFor` derives — nothing for a type with no entry (a mailbox's), so an event a
 * later package adds is on the timeline the day it is recorded, with no edit here. A failure is
 * thrown to the relay, which retries; the entry is keyed on the event, so a retry never doubles it.
 */
@Injectable()
@OutboxConsumerOf('timeline')
export class TimelineSubscriber implements OutboxConsumer {
    constructor(private readonly timeline: TimelineService) {}

    accepts(_event: DomainEvent): boolean {
        return true;
    }

    async consume(delivered: DeliveredEvent): Promise<void> {
        await this.timeline.writeFor(delivered);
    }
}
