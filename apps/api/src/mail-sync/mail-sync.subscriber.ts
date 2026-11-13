import { Injectable } from '@nestjs/common';
import type { DomainEvent, Emails } from '@bylinecrm/shared';
import { DomainEvents } from '../events/domain-events.service';
import {
    ConsumerContinues,
    OutboxConsumerOf,
    type DeliveredEvent,
    type OutboxConsumer,
} from '../events/outbox-consumer';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { stored } from '../records/references';
import { MAIL_REMATCH_BATCH, MAIL_REMATCH_BUDGET_MS } from './mail-sync.constants';
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
 *
 * A re-match is bounded (#389): `MAIL_REMATCH_BATCH` participants per transaction, each batch
 * reconciled and committed with its timeline, until nothing changes — so a staff address on tens of
 * thousands of messages never holds one transaction or the whole set in memory. One delivery works
 * for `MAIL_REMATCH_BUDGET_MS` at most; what is left is handed to the relay's next scan
 * (`ConsumerContinues`, no attempt spent), which resumes where the last commit left off.
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
        const addresses = await this.rls.withWorkspace(event.workspaceId, async (tx) => {
            // A workspace with no synced mail has nothing to re-match: skip the person read
            // entirely, so a person write costs mail sync nothing until a mailbox has synced.
            if (!(await tx.mailParticipant.findFirst({ select: { id: true } }))) return [];
            const person = await tx.person.findUnique({ where: { id: event.recordId }, select: { emails: true } });
            const before = event.diff?.['emails']?.from as Emails | undefined;
            return [
                ...new Set([...addressesOf(person ? stored<Emails>(person.emails) : null), ...addressesOf(before)]),
            ];
        });
        if (addresses.length === 0) return;
        const started = Date.now();
        let messages = 0;
        for (;;) {
            const changed = await this.rls.withWorkspace(event.workspaceId, async (tx) => {
                const changed = await rematchAddresses(tx, addresses, MAIL_REMATCH_BATCH);
                await this.events.recordAll(tx, await reconcileMessageTargets(tx, event.workspaceId, changed));
                return changed.length;
            });
            if (changed === 0) return;
            messages += changed;
            if (Date.now() - started >= MAIL_REMATCH_BUDGET_MS) {
                throw new ConsumerContinues(
                    `re-match of ${addresses.length} address(es) continues: ${messages} messages re-pointed so far`,
                );
            }
        }
    }
}
