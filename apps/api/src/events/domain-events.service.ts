import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { DomainEvent } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { afterCommit } from '../infra/transaction-scope';
import { OutboxRelay } from './outbox-relay.service';

/**
 * The one place a domain event is published (P1-6). A service calls `record` **inside** the
 * transaction that makes the change, with that transaction's client: the event is a row in
 * `outbox_events`, so it exists exactly when the change committed — a rollback takes it with it,
 * and a crash after the commit cannot lose it. The relay delivers it to the consumers
 * (`OutboxConsumerOf`) once the commit is through; this process wakes the relay at that moment.
 */
@Injectable()
export class DomainEvents {
    constructor(private readonly relay: OutboxRelay) {}

    /** Records `event` in `tx`. Throws outside a tenant transaction. */
    record(tx: WorkspaceClient, event: DomainEvent): Promise<void> {
        return this.recordAll(tx, [event]);
    }

    /** Records each of `events` in `tx` with one insert (a bulk action's hundreds). */
    async recordAll(tx: WorkspaceClient, events: readonly DomainEvent[]): Promise<void> {
        if (events.length === 0) return;
        // Registered first, so a call outside a transaction fails before it writes anything.
        afterCommit('DomainEvents.record', () => this.relay.kick());
        await tx.outboxEvent.createMany({
            data: events.map((event) => ({
                id: randomUUID(),
                workspaceId: event.workspaceId,
                type: event.type,
                payload: event as unknown as Prisma.InputJsonValue,
            })),
        });
    }
}
