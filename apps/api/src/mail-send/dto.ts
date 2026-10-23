import { MAIL_FOLLOW_UPS_MAX, MAIL_OUTBOUND_STATUSES, MAIL_SEND_RECIPIENTS_MAX } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { signatureDoc } from '../signatures/dto';
import { templateBody, templateSubject } from '../templates/dto';
import {
    MAIL_DRAFT_NAME_MAX,
    MAIL_DRAFTS_LIMIT_DEFAULT,
    MAIL_DRAFTS_LIMIT_MAX,
    MAIL_RECORD_SENDS_LIMIT_DEFAULT,
    MAIL_RECORD_SENDS_LIMIT_MAX,
    MAIL_SCHEDULED_LIMIT_DEFAULT,
    MAIL_SCHEDULED_LIMIT_MAX,
} from './mail-send.constants';

/**
 * A recipient: a person in the CRM (their primary address), or any address — someone not in the CRM included
 * (cc'ing a colleague at the client, say). An address is never made a person by sending to it. Every one, in
 * to, cc or bcc alike, passes the recipient guard and counts toward the mailbox's budget.
 */
const personRecipient = z.object({ personId: z.uuid() }).strict();
const addressRecipient = z.object({ address: z.email().max(254) }).strict();
const recipient = z.union([personRecipient, addressRecipient]);
const recipients = z.array(recipient).max(MAIL_SEND_RECIPIENTS_MAX);

/** An IANA time zone the runtime knows (`Europe/London`); `UTC` included. */
export function isTimeZone(value: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

/**
 * When a scheduled send goes (P2-5): ISO 8601 with an offset (`2026-10-12T09:00:00+01:00` or `…Z`),
 * stored in UTC. How far ahead it may be is the service's check, against the clock.
 */
const sendAt = z.iso.datetime({ offset: true }).meta({
    description:
        'Send later: ISO 8601 with an offset, at least MAIL_SEND_MIN_LEAD_SECONDS from now and at most MAIL_SEND_HORIZON_DAYS ahead.',
});
/** The sender's IANA time zone, echoed back for display; never used to compute `sendAt`. */
const timeZone = z
    .string()
    .max(64)
    .refine(isTimeZone, { message: 'not a time zone this server knows (IANA, e.g. Europe/London)' });

/**
 * A follow-up queued behind the send: when it goes, and what it says — a template, or a body with an optional
 * subject of its own (left out, it is the thread's: `Re: <first subject>`). Everything else is the send's.
 */
const followUp = z
    .object({
        sendAt,
        templateId: z.uuid().optional(),
        subject: templateSubject.optional(),
        body: templateBody.optional(),
    })
    .strict()
    .superRefine((input, ctx) => {
        if (input.templateId !== undefined && input.body !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['body'], message: 'send a template or a body, not both' });
        }
        if (input.templateId === undefined && input.body === undefined) {
            ctx.addIssue({ code: 'custom', path: ['body'], message: 'a body, or a templateId' });
        }
    });

/**
 * `POST /mail/send` (P2-3). The message is either a template (`templateId`) or written here
 * (`subject` + `body`, in the template subset, variables allowed) — exactly one of the two. It is
 * about `personId` (the variables' person, and the default recipient) and optionally `dealId`. A
 * reply (`replyToMessageId`) may leave `subject` out: it becomes the parent's, prefixed `Re:`.
 */
export class SendMailDto extends createZodDto(
    z
        .object({
            mailboxId: z.uuid(),
            personId: z.uuid(),
            dealId: z.uuid().optional(),
            to: recipients.min(1).optional(),
            cc: recipients.optional(),
            bcc: recipients.optional(),
            templateId: z.uuid().optional(),
            subject: templateSubject.optional(),
            body: templateBody.optional(),
            replyToMessageId: z.uuid().optional(),
            signature: signatureDoc.nullable().optional().meta({
                description:
                    'This message’s signature (#193), in place of the mailbox’s; `null` for none. Left out, the mailbox’s applies.',
            }),
            sendAt: sendAt.optional(),
            timeZone: timeZone.optional(),
            followUps: z
                .array(followUp)
                .max(MAIL_FOLLOW_UPS_MAX)
                .optional()
                .meta({
                    description: `Up to ${MAIL_FOLLOW_UPS_MAX} follow-ups, each later than the one before (and than \`sendAt\`), sent in this send's thread as replies — each once the one before has gone; called off when the person answers, or an earlier one fails or is cancelled.`,
                }),
            draftId: z.uuid().optional().meta({
                description:
                    'The caller’s draft this message was written in (`/mail/drafts`): deleted with the send, in the same transaction. A draft already gone is no error.',
            }),
        })
        .superRefine((input, ctx) => {
            // Each follow-up after the email before it; a follow-up of a send now is checked against the clock.
            let previous = input.sendAt === undefined ? null : Date.parse(input.sendAt);
            for (const [index, f] of (input.followUps ?? []).entries()) {
                const at = Date.parse(f.sendAt);
                if (previous !== null && at <= previous) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['followUps', index, 'sendAt'],
                        message: 'later than the email before it',
                    });
                }
                previous = at;
            }
            if (input.templateId !== undefined) {
                for (const field of ['subject', 'body'] as const) {
                    if (input[field] !== undefined) {
                        ctx.addIssue({
                            code: 'custom',
                            path: [field],
                            message: 'send a template or a subject and body, not both',
                        });
                    }
                }
                return;
            }
            if (input.body === undefined) {
                ctx.addIssue({ code: 'custom', path: ['body'], message: 'a body, or a templateId' });
            }
            if ((input.subject === undefined || input.subject === '') && input.replyToMessageId === undefined) {
                ctx.addIssue({ code: 'custom', path: ['subject'], message: 'a subject, or a templateId' });
            }
        }),
) {}

/** `PATCH /mail/messages/:messageId` — move a scheduled send to another time. */
export class RescheduleMailDto extends createZodDto(z.object({ sendAt, timeZone: timeZone.optional() }).strict()) {}

/** `GET /mail/scheduled` — the caller's scheduled sends (an admin's: everyone's), soonest first. */
export class ListScheduledQueryDto extends createZodDto(
    z.object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(MAIL_SCHEDULED_LIMIT_MAX).default(MAIL_SCHEDULED_LIMIT_DEFAULT),
    }),
) {}

/**
 * `GET /mail/messages?target=&status=` (#104) — the sends about one record, in the statuses asked
 * for (`failed,scheduled` for a record page), newest first.
 */
export class ListRecordSendsQueryDto extends createZodDto(
    z.object({
        target: z.string().min(1).meta({ description: '`person:<uuid>`, `company:<uuid>` or `opportunity:<uuid>`.' }),
        status: z
            .string()
            .min(1)
            .transform((raw) => [...new Set(raw.split(',').map((part) => part.trim()))])
            .pipe(z.array(z.enum(MAIL_OUTBOUND_STATUSES)).min(1))
            .meta({ description: 'Comma-separated statuses, e.g. `failed,scheduled`.' }),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(MAIL_RECORD_SENDS_LIMIT_MAX).default(MAIL_RECORD_SENDS_LIMIT_DEFAULT),
    }),
) {}

/**
 * A draft's recipient: as a send's, and for a person the name the composer showed — kept so a restored draft
 * names them without a lookup; never sent.
 */
const draftRecipient = z.union([
    personRecipient.extend({ name: z.string().max(MAIL_DRAFT_NAME_MAX).optional() }),
    addressRecipient,
]);
const draftRecipients = z.array(draftRecipient).max(MAIL_SEND_RECIPIENTS_MAX);

/**
 * What a draft holds: the composer's state, unfinished as it may be — every field optional, nothing checked but
 * shape and size (the send checks the rest). `to` is the send's (`personId` first); `templateId` the template it
 * was filled from; `signature` this message's own (absent: the mailbox's); `sendAt` the time picked to schedule it.
 */
export const mailDraftContent = z
    .object({
        mailboxId: z.uuid().nullable().optional(),
        to: draftRecipients.optional(),
        cc: draftRecipients.optional(),
        bcc: draftRecipients.optional(),
        templateId: z.uuid().nullable().optional(),
        subject: templateSubject.optional(),
        body: templateBody.optional(),
        signature: signatureDoc.nullable().optional(),
        sendAt: z.iso.datetime({ offset: true }).nullable().optional(),
        timeZone: timeZone.optional(),
        followUps: z
            .array(
                z
                    .object({
                        sendAt: z.iso.datetime({ offset: true }).nullable().optional(),
                        subject: templateSubject.optional(),
                        body: templateBody.optional(),
                    })
                    .strict(),
            )
            .max(MAIL_FOLLOW_UPS_MAX)
            .optional(),
    })
    .strict();
export type MailDraftContent = z.output<typeof mailDraftContent>;

/** `POST /mail/drafts` — the caller's draft in one composer: a person's, or a person's on a deal. */
export class CreateMailDraftDto extends createZodDto(
    z
        .object({
            personId: z.uuid(),
            dealId: z.uuid().optional(),
            replyToMessageId: z.uuid().optional().meta({
                description:
                    'A reply’s draft: the message it answers — one in a mailbox of the caller’s own, as a reply’s send needs.',
            }),
            content: mailDraftContent,
        })
        .strict(),
) {}

/** `PUT /mail/drafts/:draftId` — the draft's new content, naming the version it replaces (`409` if it changed). */
export class SaveMailDraftDto extends createZodDto(
    z
        .object({
            version: z.number().int().min(1).meta({ description: 'The version this content replaces.' }),
            content: mailDraftContent,
        })
        .strict(),
) {}

/** `GET /mail/drafts?target=` — the caller's own drafts about one record, last edited first. */
export class ListMailDraftsQueryDto extends createZodDto(
    z.object({
        target: z.string().min(1).meta({ description: '`person:<uuid>`, `company:<uuid>` or `opportunity:<uuid>`.' }),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(MAIL_DRAFTS_LIMIT_MAX).default(MAIL_DRAFTS_LIMIT_DEFAULT),
    }),
) {}
