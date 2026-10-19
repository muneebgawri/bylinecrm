import {
    SOCIAL_LINK_MAX,
    SOCIAL_NETWORKS,
    socialLinkProblem,
    type SocialLinks,
    type SocialNetwork,
    SLOTLINE_API_KEY_MAX,
    SLOTLINE_EVENT_SLUG_PATTERN,
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

/**
 * A member's profiles for the signature's icons (#193): only the known networks, each https on that network's
 * own site; an empty one is dropped.
 */
const socialLinks = z
    .object(
        Object.fromEntries(
            SOCIAL_NETWORKS.map((n) => [n, z.string().trim().max(SOCIAL_LINK_MAX).optional()]),
        ) as Record<SocialNetwork, z.ZodOptional<z.ZodString>>,
    )
    .strict()
    .superRefine((links, ctx) => {
        for (const network of SOCIAL_NETWORKS) {
            const link = links[network];
            const problem = link ? socialLinkProblem(network, link) : null;
            if (problem) ctx.addIssue({ code: 'custom', path: [network], message: problem });
        }
    })
    .transform(
        (links): SocialLinks => Object.fromEntries(Object.entries(links).filter(([, link]) => link)) as SocialLinks,
    );

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
            socials: socialLinks
                .optional()
                .meta({ description: 'Profiles shown as icons; each https on that network’s site. Left out, kept.' }),
        })
        .strict(),
) {}

/** `POST /signatures/preview`: a signature as it would read, from a mailbox (or as the caller). */
export class PreviewSignatureDto extends createZodDto(
    z.object({ signature: signatureDoc, mailboxId: z.uuid().optional() }).strict(),
) {}

/** `PUT /members/:memberId/slotline-key` (#196): the member's own Slotline API key. */
export class PutSlotlineKeyDto extends createZodDto(
    z
        .object({
            apiKey: z
                .string()
                .trim()
                .min(8)
                .max(SLOTLINE_API_KEY_MAX)
                .regex(/^\S+$/, 'no spaces')
                .meta({ description: 'Created in Slotline under Settings → Developer → API keys. Never returned.' }),
        })
        .strict(),
) {}

/** `PUT /members/:memberId/slotline-event` (#196): an event type on the member's account, or `null` for their page. */
export class PutSlotlineEventDto extends createZodDto(
    z.object({ slug: z.string().regex(SLOTLINE_EVENT_SLUG_PATTERN).nullable() }).strict(),
) {}
