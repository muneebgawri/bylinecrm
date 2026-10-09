import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DomainEvents } from './domain-events.service';

/**
 * The in-process event bus. Wildcards are on so a subscriber can take every event of one object
 * (`person.*`). Delivery is in-process and synchronous to the emitter; anything that must survive
 * a restart (webhook delivery, P1-5) goes from a subscriber onto a queue, not from here.
 */
@Global()
@Module({
    imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
    providers: [DomainEvents],
    exports: [DomainEvents],
})
export class EventsModule {}
