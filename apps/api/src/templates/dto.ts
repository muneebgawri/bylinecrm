import {
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
    MAIL_SETTINGS_TEXT_MAX,
    TEMPLATE_BODY_MAX_CHARS,
    TEMPLATE_KINDS,
    TEMPLATE_NAME_MAX,
    TEMPLATE_SUBJECT_MAX,
    type RichTextNode,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A template body (and a signature, #193) as the editor sends it. The shape is checked here; whether it stays inside the
 * template subset (`TEMPLATE_BODY_NODES`) is checked by the service, which can name each problem
 * at its path.
 */
export const richTextNode: z.ZodType<RichTextNode> = z.lazy(() =>
    z
        .object({
            type: z.string().min(1).max(64),
            text: z.string().optional(),
            content: z.array(richTextNode).optional(),
            attrs: z.record(z.string(), z.unknown()).optional(),
            marks: z
                .array(
                    z.object({ type: z.string().min(1).max(64), attrs: z.record(z.string(), z.unknown()).optional() }),
                )
                .optional(),
        })
        .passthrough(),
);
export const templateBody = z
    .object({ type: z.literal('doc'), content: z.array(richTextNode).optional() })
    .refine((doc) => JSON.stringify(doc).length <= TEMPLATE_BODY_MAX_CHARS, {
        message: `a template body is at most ${TEMPLATE_BODY_MAX_CHARS} characters of JSON`,
    });

const name = z.string().trim().min(1).max(TEMPLATE_NAME_MAX);
export const templateSubject = z.string().trim().max(TEMPLATE_SUBJECT_MAX);
const kind = z.enum(TEMPLATE_KINDS);

export class CreateTemplateDto extends createZodDto(
    z.object({
        name,
        kind,
        subject: templateSubject.default(''),
        body: templateBody.default({ type: 'doc', content: [] }),
    }),
) {}

/**
 * A partial update. `version` is the version the caller edited (or send it as `If-Match`); a
 * template changed since then is `409 conflict`, never silently overwritten.
 */
export class UpdateTemplateDto extends createZodDto(
    z
        .object({
            name,
            kind,
            subject: templateSubject,
            body: templateBody,
            version: z.number().int().min(1),
        })
        .partial()
        .refine((patch) => Object.keys(patch).some((key) => key !== 'version'), { message: 'nothing to update' }),
) {}

export class ListTemplatesQueryDto extends createZodDto(
    z.object({
        kind: kind.optional(),
        q: z.string().trim().min(1).max(200).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
    }),
) {}

export class PreviewTemplateDto extends createZodDto(
    z.object({
        personId: z.uuid(),
        dealId: z.uuid().optional(),
        mailboxId: z.uuid().optional().meta({
            description:
                'The sending mailbox, for the signature that would follow (#193); left out, the workspace default.',
        }),
    }),
) {}

const settingsText = z.string().trim().max(MAIL_SETTINGS_TEXT_MAX);
const required = settingsText.min(1);
const optional = settingsText.transform((v) => (v === '' ? null : v)).nullable();

/** The postal address outreach mail carries (FR-CRMS-12). */
const postalAddress = z.object({
    line1: required,
    line2: optional.default(null),
    city: required,
    region: optional.default(null),
    postalCode: required,
    country: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, upper case'),
});

/** The whole settings object: a PUT replaces it. */
export class PutMailSettingsDto extends createZodDto(
    z.object({
        postalAddress: postalAddress.nullable(),
        defaultSenderName: optional,
        unsubscribeFooterText: required,
    }),
) {}
