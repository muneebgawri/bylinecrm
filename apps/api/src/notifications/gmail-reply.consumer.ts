import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { trackingRulesIn } from '../tracking/tracking-policy.service';
import { notify } from './notify';

/**
 * TRACK-2: a CRM contact's reply to an email a member sent straight from Gmail (not from the CRM) tells that member,
 * in the bell, as a reply to a CRM send does — while the workspace keeps Gmail reply notices on and the member keeps
 * reply notifications on. The answered email is the one the reply names (`In-Reply-To`, then `References`), else the
 * last email in its conversation before it, and it must have left a member's personal mailbox. Mail from no CRM
 * contact tells nobody. A reply that also answers a CRM send is that send's sender's to hear of: the notification is
 * the same one (its target is the reply), written once.
 */
@Injectable()
@OutboxConsumerOf('gmail-reply-notifications')
export class GmailReplyNotificationsConsumer implements OutboxConsumer {
    constructor(private readonly rls: RlsPrismaService) {}

    accepts(event: DomainEvent): boolean {
        return event.type === 'email.received';
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        const email = event.email;
        if (!email || email.direction !== 'inbound') return;
        if (!(event.targets ?? []).some((t) => t.type === 'person')) return;
        await this.rls.withWorkspace(event.workspaceId, async (tx) => {
            if (!(await trackingRulesIn(tx, event.workspaceId)).gmailReplyNotices) return;
            const memberId = await answeredMember(tx, {
                messageId: email.messageId,
                threadId: email.threadId,
                sentAt: new Date(email.sentAt),
                ids: [email.inReplyTo, ...[...email.references].reverse()].filter((x): x is string => !!x),
            });
            if (!memberId) return;
            await notify(tx, event.workspaceId, [memberId], 'email_replied', [{ type: 'reply', id: email.messageId }]);
        });
    }
}

/**
 * The member to tell: the owner of the personal mailbox the answered email left, while they are in the workspace and
 * want reply notifications; null when the reply answers no member's email (or a CRM send, which `email.replied` tells).
 */
async function answeredMember(
    tx: WorkspaceClient,
    reply: { messageId: string; threadId: string; sentAt: Date; ids: string[] },
): Promise<string | null> {
    const rows = await tx.$queryRaw<{ id: string; crm: boolean; owner: string | null }[]>`
        SELECT m.id,
               EXISTS (SELECT 1 FROM mail_outbound o WHERE o.mail_message_id = m.id) AS crm,
               (SELECT w.id FROM mailboxes b JOIN workspace_members w ON w.id = b.owner_member_id
                 WHERE lower(b.email) = lower(m.from_address) AND b.purpose = 'personal'
                   AND w.left_at IS NULL AND w.notify_email_replies
                 LIMIT 1) AS owner
        FROM mail_messages m
        WHERE m.direction = 'outbound'
          AND m.id <> ${reply.messageId}::uuid
          AND (m.rfc822_message_id = ANY(${reply.ids}::text[])
               OR (m.thread_id = ${reply.threadId}::uuid AND m.sent_at <= ${reply.sentAt}))
        ORDER BY COALESCE(array_position(${reply.ids}::text[], m.rfc822_message_id), 2147483647), m.sent_at DESC
        LIMIT 1`;
    const answered = rows[0];
    if (!answered || answered.crm) return null;
    return answered.owner;
}
