import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MAILBOX_LABEL_MAX } from '../mail-accounts/mail-accounts.constants';
import { SMTP2GO_API_KEY_PATTERN } from './smtp2go.constants';

const apiKey = z.string().trim().regex(SMTP2GO_API_KEY_PATTERN, 'an SMTP2Go API key (api-…)');

/** `POST /smtp2go/mailboxes` — an SMTP2Go pool mailbox (TRANS-1). */
export class AddSmtp2GoMailboxDto extends createZodDto(
    z.object({
        email: z.email().max(254),
        label: z.string().trim().max(MAILBOX_LABEL_MAX).nullable().optional(),
        apiKey,
        /** The DKIM selector SMTP2Go gave the domain (`s123456`), checked at `<selector>._domainkey.<domain>`. */
        dkimSelector: z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z0-9](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9](?:[a-z0-9_-]{0,62}))*$/, 'a DNS label, e.g. s123456')
            .optional(),
    }),
) {}

/** `PUT /smtp2go/mailboxes/:id/api-key`. */
export class PutSmtp2GoKeyDto extends createZodDto(z.object({ apiKey })) {}
