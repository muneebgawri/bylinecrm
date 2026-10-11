import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SuppressionService } from '../suppression/suppression.service';
import { SendingPoolService } from './sending-pool.service';

/**
 * What a counted bounce or complaint sets off (P3-2): a permanent bounce suppresses its address
 * (`hard_bounce`, from the provider — P3-1's one write) and the mailbox's rates are judged again; a
 * complaint entry attributed to a pool mailbox's send has its rates judged again. Both steps are
 * idempotent, so a redelivered event changes nothing.
 */
@Injectable()
@OutboxConsumerOf('sending-pool')
export class SendingPoolConsumer implements OutboxConsumer {
    constructor(
        private readonly pool: SendingPoolService,
        private readonly suppressions: SuppressionService,
        private readonly rls: RlsPrismaService,
    ) {}

    accepts(event: DomainEvent): boolean {
        return (
            (event.type === 'email.bounced' && event.bounce?.permanent === true) ||
            (event.type === 'suppression.added' && event.suppression?.reason === 'complaint')
        );
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        if (event.type === 'email.bounced' && event.bounce) {
            await this.suppressions.suppress(event.workspaceId, {
                address: event.bounce.address,
                reason: 'hard_bounce',
                source: 'provider',
                outboundId: event.bounce.outboundId,
            });
            await this.pool.evaluate(event.workspaceId, event.bounce.mailboxId);
            return;
        }
        if (event.type === 'suppression.added') {
            const entry = await this.rls.withWorkspace(event.workspaceId, (tx) =>
                tx.suppression.findUnique({
                    where: { id: event.recordId },
                    select: { outbound: { select: { mailboxId: true } } },
                }),
            );
            if (entry?.outbound) await this.pool.evaluate(event.workspaceId, entry.outbound.mailboxId);
        }
    }
}
