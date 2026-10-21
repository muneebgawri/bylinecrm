import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { refreshContactStatus } from './contact-status.service';

const ACCEPTS = new Set<string>([
    'email.sent',
    'email.received',
    'email.replied',
    'email.linked',
    'suppression.added',
    'suppression.removed',
    'meeting.booked',
    'meeting.cancelled',
    'deal.won',
    'deal.lost',
    'deal.stage_changed',
    'opportunity.created',
    'opportunity.updated',
    'opportunity.deleted',
    'opportunity.restored',
    'person.created',
    'person.updated',
    'person.restored',
]);

/**
 * Keeps people's derived contact status (#242) current: whatever a status reads — mail to or from them, a meeting, a
 * suppression of their address, a deal of theirs winning or reopening — re-derives the people it concerns. The
 * refresh is a function of what is stored, so a redelivered event changes nothing.
 */
@Injectable()
@OutboxConsumerOf('contact_status')
export class ContactStatusConsumer implements OutboxConsumer {
    constructor(private readonly rls: RlsPrismaService) {}

    accepts(event: DomainEvent): boolean {
        return ACCEPTS.has(event.type);
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        await this.rls.withWorkspace(event.workspaceId, async (tx) => {
            const ids = await peopleConcerned(tx, event);
            await refreshContactStatus(tx, ids);
        });
    }
}

/** The people whose status an event may change. */
export async function peopleConcerned(tx: WorkspaceClient, event: DomainEvent): Promise<string[]> {
    const ids = new Set<string>();
    for (const t of [...(event.targets ?? []), ...(event.related ?? [])]) if (t.type === 'person') ids.add(t.id);
    if (event.link?.personId) ids.add(event.link.personId);
    for (const id of event.reply?.personIds ?? []) ids.add(id);
    switch (event.object) {
        case 'person':
            if (event.type !== 'person.updated' || 'emails' in (event.diff ?? {})) ids.add(event.recordId);
            break;
        case 'opportunity': {
            if (event.type === 'opportunity.updated' && !('pointOfContactId' in (event.diff ?? {}))) break;
            const deal = await tx.opportunity.findUnique({
                where: { id: event.recordId },
                select: { pointOfContactId: true },
            });
            if (deal?.pointOfContactId) ids.add(deal.pointOfContactId);
            const before = event.diff?.pointOfContactId?.from;
            if (typeof before === 'string') ids.add(before);
            break;
        }
        default:
            break;
    }
    if (event.suppression) {
        if (event.suppression.personId) ids.add(event.suppression.personId);
        const holders = await tx.person.findMany({
            where: { emailPrimary: event.suppression.address },
            select: { id: true },
        });
        for (const p of holders) ids.add(p.id);
    }
    return [...ids];
}
