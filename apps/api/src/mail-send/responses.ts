import { MAIL_OUTBOUND_STATUSES } from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named, page, richText } from '../openapi/responses';
import { trackingCounts } from '../tracking/responses';

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
        followUps: z
            .array(z.object({ messageId: id, sendAt: dateTime }))
            .meta({ description: 'The follow-ups queued behind it, in order: each `scheduled` at its `sendAt`.' }),
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
        followsOutboundId: id.nullable().meta({
            description:
                'A queued follow-up: the send it follows, in whose thread it goes as a reply once that one has gone. Null otherwise.',
        }),
        senderMemberId: id.meta({ description: 'The member who sent (or scheduled) it.' }),
        canChange: z.boolean().meta({
            description: 'Whether the caller may reschedule or cancel it: its sender or an admin (#133).',
        }),
        canRetry: z.boolean().meta({
            description:
                'Whether the caller may send this failed send again (#134): its sender or an admin, and a refusal that would not simply repeat.',
        }),
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
        deliveredAt: dateTime.nullable().meta({
            description:
                'When the recipient’s server accepted it, as the provider reported (TRANS-1: SMTP2Go’s `delivered`); null when not reported.',
        }),
        tracking: trackingCounts.meta({
            description: 'Clicks and indicative opens on this send (P3-4); zeros until it is sent and tracked.',
        }),
    }),
);
export type MailOutboundView = z.output<typeof mailOutboundView>;

export const mailScheduledPage = named('MailScheduledPage', page(mailOutboundView));
export type MailScheduledPage = z.output<typeof mailScheduledPage>;

export const mailRecordSendsPage = named('MailRecordSendsPage', page(mailOutboundView));
export type MailRecordSendsPage = z.output<typeof mailRecordSendsPage>;

const draftRecipient = z.union([
    z.object({ personId: id, name: z.string().optional() }),
    z.object({ address: z.string() }),
]);

/** A draft's content as saved: `MailDraftContent` in the request, every field as it was given. */
const mailDraftContentView = named(
    'MailDraftContent',
    z.object({
        mailboxId: id.nullable().optional(),
        to: z.array(draftRecipient).optional(),
        cc: z.array(draftRecipient).optional(),
        bcc: z.array(draftRecipient).optional(),
        templateId: id.nullable().optional(),
        subject: z.string().optional(),
        body: richText.optional(),
        signature: richText.nullable().optional(),
        sendAt: z.string().nullable().optional(),
        timeZone: z.string().optional(),
        followUps: z
            .array(
                z.object({
                    sendAt: z.string().nullable().optional(),
                    subject: z.string().optional(),
                    body: richText.optional(),
                }),
            )
            .optional(),
    }),
);

export const mailDraftView = named(
    'MailDraft',
    z.object({
        id,
        personId: id.meta({ description: 'The person the draft is to and about.' }),
        dealId: id.nullable().meta({ description: 'The deal it is written from; null for the person’s own composer.' }),
        replyToMessageId: id.nullable().meta({
            description: 'A reply’s draft: the message it answers. Null for a new email’s.',
        }),
        threadId: id.nullable().meta({ description: 'A reply’s draft: the thread it is in. Null for a new email’s.' }),
        content: mailDraftContentView.meta({
            description: 'The composer’s state, unfinished as it may be: what the last save was given.',
        }),
        version: z
            .number()
            .int()
            .meta({ description: 'Name it in the next save: a draft saved elsewhere meanwhile is `409`.' }),
        createdAt: dateTime,
        updatedAt: dateTime,
    }),
);
export type MailDraftView = z.output<typeof mailDraftView>;

export const mailDraftPage = named('MailDraftPage', page(mailDraftView));
export type MailDraftPage = z.output<typeof mailDraftPage>;
