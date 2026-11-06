import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { engagementOf, engagementRecipient } from './email-engagement';
import { notify } from './notify';

const MEMBER = {
    select: { id: true, leftAt: true, notifyEmailReplies: true, notifyEmailClicks: true, notifyEmailOpens: true },
} as const;

/**
 * A reply to, a click in or an open of an email a member sent from the CRM (a follow-up or a sequence step is a send
 * too): its sender hears of it in the bell — or, once they have left, the person's owner — unless they turned that
 * kind off. Every reply tells; a send's first click and first open tell once each. Through `notify`, the one writer,
 * so a redelivered event tells nobody twice. A test send (an admin's, to themselves) tells nobody.
 */
@Injectable()
@OutboxConsumerOf('email-engagement-notifications')
export class EmailEngagementNotificationsConsumer implements OutboxConsumer {
    constructor(private readonly rls: RlsPrismaService) {}

    accepts(event: DomainEvent): boolean {
        return event.type === 'email.replied' || event.type === 'email.clicked' || event.type === 'email.opened';
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        const engagement = engagementOf(event);
        if (!engagement) return;
        await this.rls.withWorkspace(event.workspaceId, async (tx) => {
            const send = await tx.mailOutbound.findUnique({
                where: { id: engagement.outboundId },
                select: {
                    isTest: true,
                    sender: MEMBER,
                    person: { select: { owner: MEMBER } },
                },
            });
            if (!send || send.isTest) return;
            // The send's person, or (a send to no one in the CRM) the person who replied.
            const personOwner =
                send.person?.owner ??
                (engagement.personIds[0]
                    ? ((
                          await tx.person.findUnique({
                              where: { id: engagement.personIds[0] },
                              select: { owner: MEMBER },
                          })
                      )?.owner ?? null)
                    : null);
            const memberId = engagementRecipient(engagement.kind, send.sender, personOwner);
            if (!memberId) return;
            await notify(tx, event.workspaceId, [memberId], engagement.kind, [engagement.target]);
        });
    }
}
