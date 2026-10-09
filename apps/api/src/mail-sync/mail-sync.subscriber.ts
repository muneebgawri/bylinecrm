import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { DomainEvent, Emails } from '@bylinecrm/shared';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { stored } from '../records/references';
import { addressesOf, rematchAddresses } from './matching';
import { MailSyncWorkers } from './mail-sync.workers';

/** The person events that can change who an address is. */
const PERSON_CHANGES = new Set<string>(['person.created', 'person.updated', 'person.deleted', 'person.restored']);

/**
 * Keeps synced mail in step with the rest of the workspace (P2-2):
 *
 * - a mailbox that connects is queued for its first import at once;
 * - a person who is created, restored, deleted, or whose addresses change re-points the mail of
 *   every address involved (PAR-028), so earlier mail follows the person — and a deleted person's
 *   mail goes to whoever else has the address, or no one.
 *
 * The bus is synchronous to the request that published; failures are logged, never thrown into a
 * request that already succeeded.
 */
@Injectable()
export class MailSyncSubscriber {
    private readonly logger = new Logger(MailSyncSubscriber.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly workers: MailSyncWorkers,
    ) {}

    @OnEvent('mailbox.connected')
    async onMailboxConnected(event: DomainEvent): Promise<void> {
        try {
            await this.workers.enqueue({ workspaceId: event.workspaceId, mailboxId: event.recordId });
        } catch (error) {
            this.logger.error(`first sync not queued for mailbox ${event.recordId}: ${String(error)}`);
        }
    }

    @OnEvent('person.*')
    async onPersonChanged(event: DomainEvent): Promise<void> {
        if (!PERSON_CHANGES.has(event.type)) return;
        if (event.type === 'person.updated' && !event.diff?.['emails']) return;
        try {
            await this.rls.withWorkspace(event.workspaceId, async (tx) => {
                // A workspace with no synced mail has nothing to re-match: skip the person read
                // entirely, so a person write costs mail sync nothing until a mailbox has synced.
                if (!(await tx.mailParticipant.findFirst({ select: { id: true } }))) return;
                const person = await tx.person.findUnique({ where: { id: event.recordId }, select: { emails: true } });
                const before = event.diff?.['emails']?.from as Emails | undefined;
                const addresses = [
                    ...new Set([...addressesOf(person ? stored<Emails>(person.emails) : null), ...addressesOf(before)]),
                ];
                await rematchAddresses(tx, addresses);
            });
        } catch (error) {
            this.logger.error(`mail not re-matched after ${event.type} ${event.recordId}: ${String(error)}`);
        }
    }
}
