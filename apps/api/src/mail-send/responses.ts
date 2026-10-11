import { MAIL_OUTBOUND_STATUSES } from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named, page } from '../openapi/responses';

/** Sending (P2-3, P2-5) as the API returns it. */

const timeZoneEcho = z
    .string()
    .nullable()
    .meta({ description: 'The sender’s IANA time zone as they scheduled it; null when none was given.' });
const recipientTimeZone = z.null().meta({
    description:
        'The recipient’s time zone. Not known yet — inferred later from enrichment (Phase 3) — so always null: show “recipient’s zone unknown”, never a guess.',
});

export const mailSendAccepted = named(
    'MailSendAccepted',
    z.object({
        messageId: id.meta({ description: 'The send: read where it stands at `GET /mail/messages/:messageId`.' }),
        status: z.enum(['queued', 'scheduled']).meta({
            description: '`queued`: sent by a job now. `scheduled`: built, checked and sent at `sendAt`.',
        }),
        sendAt: dateTime.nullable().meta({ description: 'When a scheduled send goes (UTC); null for a send now.' }),
        senderTimeZone: timeZoneEcho,
        recipientTimeZone,
    }),
);
export type MailSendAccepted = z.output<typeof mailSendAccepted>;

export const mailOutboundView = named(
    'MailOutbound',
    z.object({
        id,
        mailboxId: id,
        status: z.enum(MAIL_OUTBOUND_STATUSES),
        subject: z.string().meta({
            description:
                'As built. A scheduled send shows the subject it had when scheduled; it is built again at `sendAt`.',
        }),
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
            .object({
                code: z.string().meta({
                    description:
                        'Why it failed: e.g. `unsendable` (a variable had no value at send time), `stale` (its time passed while nothing could send it), `forbidden`, `reconnect_needed`, `gmail.<reason>`.',
                }),
                message: z.string(),
                at: dateTime,
                fields: z
                    .array(z.string())
                    .optional()
                    .meta({ description: 'For `unsendable`: the variables that had no value.' }),
            })
            .nullable()
            .meta({ description: 'Why the last attempt failed; null after a clean one.' }),
        sendAt: dateTime.nullable(),
        senderTimeZone: timeZoneEcho,
        recipientTimeZone,
        cancelledAt: dateTime.nullable(),
        createdAt: dateTime,
        sentAt: dateTime.nullable(),
    }),
);
export type MailOutboundView = z.output<typeof mailOutboundView>;

export const mailScheduledPage = named('MailScheduledPage', page(mailOutboundView));
export type MailScheduledPage = z.output<typeof mailScheduledPage>;
