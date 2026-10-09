import {
    EXTERNAL_IDEMPOTENCY_KEY_MAX,
    EXTERNAL_KIND_PATTERN,
    EXTERNAL_SOURCE_MAX,
    TIMELINE_LIMIT_DEFAULT,
    TIMELINE_LIMIT_MAX,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `person:<uuid>` etc.; parsed by `parseTarget` in the controller. */
const target = z.string().min(1);

export class ListTimelineQueryDto extends createZodDto(
    z.object({
        target,
        /** Comma-separated prefixes of `kind` to keep (`linked-note,opportunity.`); absent keeps every kind. */
        kinds: z.string().max(500).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(TIMELINE_LIMIT_MAX).default(TIMELINE_LIMIT_DEFAULT),
    }),
) {}

const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217, upper case');
const money = z.object({
    amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency,
});

/** What an integration reports (doc 48 §8): generic, named by the integration, idempotent. */
export class ExternalActivityDto extends createZodDto(
    z.object({
        target,
        kind: z.string().regex(EXTERNAL_KIND_PATTERN, 'kind is external.<snake_case_name>'),
        happenedAt: z.iso.datetime({ offset: true }),
        title: z.string().trim().min(1).max(200),
        url: z.url().max(2048).optional(),
        amount: money.optional(),
        source: z
            .string()
            .trim()
            .min(1)
            .max(EXTERNAL_SOURCE_MAX)
            .regex(/^[a-z][a-z0-9_-]*$/, 'source is a short lower-case name'),
        idempotencyKey: z.string().trim().min(1).max(EXTERNAL_IDEMPOTENCY_KEY_MAX),
    }),
) {}
