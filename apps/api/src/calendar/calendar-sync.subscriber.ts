import { Injectable } from '@nestjs/common';
import type { DomainEvent, Emails } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { addressesOf, PERSON_FOR_ADDRESS } from '../mail-sync/matching';
import { stored } from '../records/references';
import { CalendarSyncWorkers } from './calendar-sync.workers';

/** The person events that can change who an address is. */
const PERSON_CHANGES = new Set<string>(['person.created', 'person.updated', 'person.deleted', 'person.restored']);

/**
 * Keeps calendar sync in step with the rest of the workspace (CAL-1):
 *
 * - a personal mailbox that connects (or reconnects, perhaps now allowing the calendar) has its calendar
 *   queued for a read at once — the run itself decides whether the grant reads it;
 * - a person who is created, restored, deleted, or whose addresses change re-points the meeting
 *   attendees with any address involved (PAR-028's rule, as mail follows it), so a meeting shows the
 *   person it was with — or no one, once they are deleted.
 *
 * Both are idempotent, as an outbox consumer must be (P1-6): a second run of a synced calendar stores
 * nothing new, and re-matching an attendee who already points at the person changes nothing.
 */
@Injectable()
@OutboxConsumerOf('calendar-sync')
export class CalendarSyncSubscriber implements OutboxConsumer {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly workers: CalendarSyncWorkers,
    ) {}

    accepts(event: DomainEvent): boolean {
        if (event.type === 'mailbox.connected') return true;
        if (!PERSON_CHANGES.has(event.type)) return false;
        return event.type !== 'person.updated' || Boolean(event.diff?.['emails']);
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        if (event.type === 'mailbox.connected') {
            await this.workers.enqueue({ workspaceId: event.workspaceId, mailboxId: event.recordId });
            return;
        }
        await this.rls.withWorkspace(event.workspaceId, async (tx) => {
            // A workspace with no meetings has nothing to re-match: a person write costs calendar sync nothing.
            if (!(await tx.calendarEventParticipant.findFirst({ select: { id: true } }))) return;
            const person = await tx.person.findUnique({ where: { id: event.recordId }, select: { emails: true } });
            const before = event.diff?.['emails']?.from as Emails | undefined;
            const addresses = [
                ...new Set([...addressesOf(person ? stored<Emails>(person.emails) : null), ...addressesOf(before)]),
            ];
            await rematchAttendees(tx, addresses);
        });
    }
}

/** Re-points every attendee with one of `addresses` at the person the address belongs to now (or no one). */
export async function rematchAttendees(tx: WorkspaceClient, addresses: readonly string[]): Promise<number> {
    if (addresses.length === 0) return 0;
    return tx.$executeRaw`
        UPDATE calendar_event_participants cp
        SET person_id = x.person_id
        FROM (
            SELECT a.address, (${PERSON_FOR_ADDRESS}) AS person_id
            FROM unnest(${[...new Set(addresses)]}::text[]) AS a(address)
        ) x
        WHERE cp.address = x.address AND cp.person_id IS DISTINCT FROM x.person_id`;
}
