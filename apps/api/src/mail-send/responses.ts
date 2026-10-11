import { MAIL_OUTBOUND_STATUSES } from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named } from '../openapi/responses';

/** Sending (P2-3) as the API returns it. */

export const mailSendQueued = named(
    'MailSendQueued',
    z.object({
        messageId: id.meta({ description: 'The send: read where it stands at `GET /mail/messages/:messageId`.' }),
        status: z.literal('queued'),
    }),
);
export type MailSendQueued = z.output<typeof mailSendQueued>;

export const mailOutboundView = named(
    'MailOutbound',
    z.object({
        id,
        mailboxId: id,
        status: z.enum(MAIL_OUTBOUND_STATUSES),
        subject: z.string(),
        to: z.array(z.string()),
        cc: z.array(z.string()),
        bcc: z.array(z.string()),
        personId: id.nullable(),
        dealId: id.nullable(),
        templateId: id.nullable(),
        replyToMessageId: id.nullable().meta({ description: 'The stored message this one answers.' }),
        rfc822MessageId: z.string().meta({ description: 'Our Message-ID, without angle brackets.' }),
        mailMessageId: id.nullable().meta({
            description: 'The stored copy of the sent message (its thread is on the records); null until stored.',
        }),
        threadId: id.nullable().meta({ description: 'The CRM thread the sent message is in; null until stored.' }),
        attempts: z.number().int(),
        error: z
            .object({ code: z.string(), message: z.string(), at: dateTime })
            .nullable()
            .meta({ description: 'Why the last attempt failed; null after a clean one.' }),
        createdAt: dateTime,
        sentAt: dateTime.nullable(),
    }),
);
export type MailOutboundView = z.output<typeof mailOutboundView>;
