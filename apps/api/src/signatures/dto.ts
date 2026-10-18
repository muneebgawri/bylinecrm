import {
    SIGNATURE_LOCKABLE,
    SIGNATURE_MAX_CHARS,
    SIGNATURE_PROFILE_TEXT_MAX,
    SLOTLINE_USERNAME_PATTERN,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { richTextNode } from '../templates/dto';

/**
 * A signature as the editor sends it (#193). The shape is checked here; whether it stays inside the
 * signature subset is checked by the service, which names each problem at its path.
 */
export const signatureDoc = z
    .object({ type: z.literal('doc'), content: z.array(richTextNode).optional() })
    .refine((doc) => JSON.stringify(doc).length <= SIGNATURE_MAX_CHARS, {
        message: `a signature is at most ${SIGNATURE_MAX_CHARS} characters of JSON`,
    });

const locked = z.object(
    Object.fromEntries(SIGNATURE_LOCKABLE.map((lock) => [lock, z.boolean()])) as Record<
        (typeof SIGNATURE_LOCKABLE)[number],
        z.ZodBoolean
    >,
);

/** `PUT /settings/signatures`: the workspace default (or none) and the locks, as a whole. */
export class PutSignatureSettingsDto extends createZodDto(
    z.object({ defaultSignature: signatureDoc.nullable(), locked }).strict(),
) {}

/** `PUT /mailboxes/:mailboxId/signature`. */
export class PutMailboxSignatureDto extends createZodDto(
    z
        .object({
            own: signatureDoc.nullable(),
            useDefault: z.boolean(),
            bookingLink: z
                .url({ protocol: /^https$/ })
                .max(500)
                .nullable()
                .optional()
                .meta({ description: 'A pool mailbox’s booking page, on the Slotline site.' }),
        })
        .strict(),
) {}

const profileText = z
    .string()
    .trim()
    .max(SIGNATURE_PROFILE_TEXT_MAX)
    .transform((v) => (v === '' ? null : v))
    .nullable();

/** `PUT /members/:memberId/signature-profile`. */
export class PutSignatureProfileDto extends createZodDto(
    z
        .object({
            jobTitle: profileText,
            phone: profileText,
            slotlineUsername: z
                .string()
                .trim()
                // Empty clears it.
                .regex(
                    new RegExp(`^$|${SLOTLINE_USERNAME_PATTERN.source}`),
                    'letters, digits, dots, dashes and underscores',
                )
                .transform((v) => (v === '' ? null : v))
                .nullable()
                .meta({ description: 'The member’s page on the Slotline site: `{baseUrl}/{username}`.' }),
        })
        .strict(),
) {}

/** `POST /signatures/preview`: a signature as it would read, from a mailbox (or as the caller). */
export class PreviewSignatureDto extends createZodDto(
    z.object({ signature: signatureDoc, mailboxId: z.uuid().optional() }).strict(),
) {}
