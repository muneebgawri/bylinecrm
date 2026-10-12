import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { EnrichmentQueue } from './enrichment-queue';

/**
 * A record enriched on its own (P4-2): when a person or a company is created or restored, and when
 * what the sources read changes — a person's address or company, a company's domain — its job is
 * queued (not forced: a source asked within the workspace's age is not asked again). Idempotent:
 * the job is one per record, so a redelivered event queues nothing new.
 */
@Injectable()
@OutboxConsumerOf('enrichment')
export class EnrichmentConsumer implements OutboxConsumer {
    constructor(private readonly queue: EnrichmentQueue) {}

    accepts(event: DomainEvent): boolean {
        switch (event.type) {
            case 'person.created':
            case 'person.restored':
            case 'company.created':
            case 'company.restored':
                return true;
            case 'person.updated':
                return changed(event, ['emails', 'companyId']);
            case 'company.updated':
                return changed(event, ['domain']);
            default:
                return false;
        }
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        const object = event.type.startsWith('person.') ? 'person' : 'company';
        await this.queue.enqueue({ workspaceId: event.workspaceId, object, recordId: event.recordId, force: false });
    }
}

/** Whether an `updated` event's diff names any of these fields. */
function changed(event: DomainEvent, fields: readonly string[]): boolean {
    const diff = (event.diff ?? {}) as Record<string, unknown>;
    return fields.some((f) => f in diff);
}
