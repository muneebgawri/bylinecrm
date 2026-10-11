import { MAIL_SEND_RECIPIENTS_MAX } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { templateBody, templateSubject } from '../templates/dto';
import { MAIL_SCHEDULED_LIMIT_DEFAULT, MAIL_SCHEDULED_LIMIT_MAX } from './mail-send.constants';

/** A recipient: a person in the CRM (their primary address), or an address. */
const recipient = z.union([
    z.object({ personId: z.uuid() }).strict(),
    z.object({ address: z.email().max(254) }).strict(),
]);
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
            sendAt: sendAt.optional(),
            timeZone: timeZone.optional(),
        })
        .superRefine((input, ctx) => {
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
