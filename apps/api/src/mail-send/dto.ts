import { MAIL_SEND_RECIPIENTS_MAX } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { templateBody, templateSubject } from '../templates/dto';

/** A recipient: a person in the CRM (their primary address), or an address. */
const recipient = z.union([
    z.object({ personId: z.uuid() }).strict(),
    z.object({ address: z.email().max(254) }).strict(),
]);
const recipients = z.array(recipient).max(MAIL_SEND_RECIPIENTS_MAX);

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
