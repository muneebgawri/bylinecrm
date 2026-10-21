import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { peopleConcerned } from '../customers/contact-status.consumer';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { refreshCadence, resolveLapses } from './cadence.service';

/** What may touch a lead, change its stage, owner or scope. */
const ACCEPTS = new Set<string>([
    'email.sent',
    'email.received',
    'email.replied',
    'email.linked',
    'suppression.added',
    'suppression.removed',
    'meeting.booked',
    'meeting.cancelled',
    'note.created',
    'note.deleted',
    'note.restored',
    'task.updated',
    'deal.stage_changed',
    'deal.won',
    'deal.lost',
    'opportunity.created',
    'opportunity.updated',
    'opportunity.deleted',
    'opportunity.restored',
    'person.updated',
    'transfer.completed',
]);

/**
 * Keeps leads' cadence current between hourly runs (CADENCE-1): a touch re-derives the deals it concerns at once, so
 * the overdue badge clears when the owner mails, calls or meets, and an open lapse a touch ended is resolved. A
 * function of what is stored, so a redelivered event changes nothing.
 */
@Injectable()
@OutboxConsumerOf('cadence')
export class CadenceConsumer implements OutboxConsumer {
    constructor(private readonly rls: RlsPrismaService) {}

    accepts(event: DomainEvent): boolean {
        return ACCEPTS.has(event.type);
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        await this.rls.withWorkspace(event.workspaceId, async (tx) => {
            const ids = await dealsConcerned(tx, event);
            if (ids.length === 0) return;
            await refreshCadence(tx, ids);
            await resolveLapses(tx, new Date(), ids);
        });
    }
}

/** The open deals an event may touch: its own, those of the people it concerns. */
async function dealsConcerned(tx: WorkspaceClient, event: DomainEvent): Promise<string[]> {
    const deals = new Set<string>();
    const people = new Set(await peopleConcerned(tx, event));
    for (const t of [...(event.targets ?? []), ...(event.related ?? [])]) {
        if (t.type === 'opportunity') deals.add(t.id);
        if (t.type === 'person') people.add(t.id);
    }
    if (event.object === 'opportunity' || event.type.startsWith('deal.')) deals.add(event.recordId);
    if (people.size > 0) {
        const theirs = await tx.opportunity.findMany({
            where: { pointOfContactId: { in: [...people] }, deletedAt: null, closedAt: null },
            select: { id: true },
        });
        for (const d of theirs) deals.add(d.id);
    }
    return [...deals];
}
