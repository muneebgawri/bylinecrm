import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { MailSendService } from './mail-send.service';

/**
 * Queued follow-ups stop when the person answers: `email.replied` — the one reply detection sync's writer does,
 * which stops a sequence too — calls off every follow-up still queued in the answered send's chain. A failed or
 * cancelled email calls off its follow-ups in the transaction that fails or cancels it; this is only the reply.
 * The follow-up's own check at its time (`hasReplyFrom`) is the backstop. Redelivery changes nothing.
 */
@Injectable()
@OutboxConsumerOf('mail-follow-ups')
export class MailFollowUpsConsumer implements OutboxConsumer {
    constructor(private readonly send: MailSendService) {}

    accepts(event: DomainEvent): boolean {
        return event.type === 'email.replied';
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        await this.send.stopFollowUpsOnReply(event);
    }
}
