import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DomainEvent } from '@bylinecrm/shared';

/**
 * The one place a domain event is published. A service calls `publish` **after** the transaction
 * that made the change has committed — after `withWorkspace` returned — so no subscriber ever
 * learns of a write that rolled back. Subscribers (the timeline, webhooks, tests) listen with
 * `@OnEvent('<type>')` or `@OnEvent('person.*')`; the event's `type` is the channel.
 */
@Injectable()
export class DomainEvents {
    constructor(private readonly emitter: EventEmitter2) {}

    publish(event: DomainEvent): void {
        this.emitter.emit(event.type, event);
    }
}
