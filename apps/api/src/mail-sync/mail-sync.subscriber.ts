import { Injectable } from '@nestjs/common';
import type { DomainEvent, Emails } from '@bylinecrm/shared';
import { DomainEvents } from '../events/domain-events.service';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { stored } from '../records/references';
import { addressesOf, rematchAddresses } from './matching';
import { MailSyncWorkers } from './mail-sync.workers';
import { reconcileMessageTargets } from './reconcile';

/** The person events that can change who an address is. */
const PERSON_CHANGES = new Set<string>(['person.created', 'person.updated', 'person.deleted', 'person.restored']);

/**
 * Keeps synced mail in step with the rest of the workspace (P2-2):
 *
 * - a mailbox that connects is queued for its first import at once;
 * - a person who is created, restored, deleted, or whose addresses change re-points the mail of
 *   every address involved (PAR-028), so earlier mail follows the person — and a deleted person's
 *   mail goes to whoever else has the address, or no one; the timeline follows (`reconcile.ts`):
 *   entries come off records the mail no longer concerns, and each newly linked person is
 *   announced once as `email.linked`.
 *
 * Both are idempotent, as an outbox consumer must be (P1-6): a redelivered `mailbox.connected`
 * finds the first import already queued or done (a second sync of a synced mailbox imports nothing
 * new), and re-matching a person whose mail already points at them changes no participant, so it
 * links nothing and records no event. A failure is thrown to the relay, which retries.
 */
@Injectable()
@OutboxConsumerOf('mail-sync')
export class MailSyncSubscriber implements OutboxConsumer {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly workers: MailSyncWorkers,
        private readonly events: DomainEvents,
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
            // A workspace with no synced mail has nothing to re-match: skip the person read
            // entirely, so a person write costs mail sync nothing until a mailbox has synced.
            if (!(await tx.mailParticipant.findFirst({ select: { id: true } }))) return;
            const person = await tx.person.findUnique({ where: { id: event.recordId }, select: { emails: true } });
            const before = event.diff?.['emails']?.from as Emails | undefined;
            const addresses = [
                ...new Set([...addressesOf(person ? stored<Emails>(person.emails) : null), ...addressesOf(before)]),
            ];
            const changed = await rematchAddresses(tx, addresses);
            await this.events.recordAll(tx, await reconcileMessageTargets(tx, event.workspaceId, changed));
        });
    }
}
