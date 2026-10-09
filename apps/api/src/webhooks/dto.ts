import {
    DOMAIN_EVENT_TYPES,
    WEBHOOK_DELIVERIES_LIMIT_DEFAULT,
    WEBHOOK_DELIVERIES_LIMIT_MAX,
    WEBHOOK_DELIVERY_STATUSES,
    WEBHOOK_DESCRIPTION_MAX,
    WEBHOOK_EVENT_WILDCARD,
    WEBHOOK_URL_MAX,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A subscription: catalogue event types, or `*`. Duplicates are dropped; the order is kept. */
const events = z
    .array(z.enum([WEBHOOK_EVENT_WILDCARD, ...DOMAIN_EVENT_TYPES]))
    .min(1)
    .max(DOMAIN_EVENT_TYPES.length + 1)
    .transform((list) => [...new Set(list)]);

const url = z.string().trim().min(1).max(WEBHOOK_URL_MAX);
const description = z.string().trim().max(WEBHOOK_DESCRIPTION_MAX);

export class CreateWebhookDto extends createZodDto(
    z.object({
        url,
        description: description.default(''),
        events,
        enabled: z.boolean().default(true),
    }),
) {}

/** A partial update. Setting `enabled: true` clears a system disable and its failure count. */
export class UpdateWebhookDto extends createZodDto(
    z
        .object({
            url,
            description,
            events,
            enabled: z.boolean(),
        })
        .partial()
        .refine((body) => Object.keys(body).length > 0, { message: 'nothing to update' }),
) {}

export class ListDeliveriesQueryDto extends createZodDto(
    z.object({
        status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(WEBHOOK_DELIVERIES_LIMIT_MAX)
            .default(WEBHOOK_DELIVERIES_LIMIT_DEFAULT),
    }),
) {}

/** The body a receiver gets, as the contract describes it (P1-5 design note has a receiver example). */
export class WebhookEnvelopeDto extends createZodDto(
    z.object({
        id: z.uuid(),
        event: z.string(),
        occurredAt: z.iso.datetime({ offset: true }),
        workspaceId: z.uuid(),
        data: z.record(z.string(), z.unknown()),
    }),
) {}
