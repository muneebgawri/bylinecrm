import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DomainEvents } from './domain-events.service';
import { OutboxRelay } from './outbox-relay.service';

/**
 * Domain events (P1-6): a mutation records its event in its own transaction (`DomainEvents`), and
 * the relay delivers it to every `@OutboxConsumerOf` provider at least once (`OutboxRelay`).
 */
@Global()
@Module({
    imports: [DiscoveryModule],
    providers: [DomainEvents, OutboxRelay],
    exports: [DomainEvents, OutboxRelay],
})
export class EventsModule {}
