import { WEBHOOK_DELIVERY_STATUSES } from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named, page } from '../openapi/responses';

/** Webhook endpoints and their deliveries (P1-5), as the API returns them. */

export const webhookEndpointView = named(
    'WebhookEndpoint',
    z.object({
        id,
        url: z.url(),
        description: z.string(),
        events: z.array(z.string()).meta({ description: 'Catalogue event names, or `*`.' }),
        enabled: z.boolean(),
        disabledReason: z.string().nullable(),
        consecutiveFailures: z.number().int(),
        secretPrefix: z.string().meta({ description: "The secret's name; the secret itself is never shown again." }),
        previousSecretExpiresAt: dateTime.nullable().meta({
            description: "While a rotation's grace window is open: until when the previous secret still signs.",
        }),
        createdAt: dateTime,
        updatedAt: dateTime,
    }),
);

export const endpointWithSecret = named(
    'WebhookEndpointWithSecret',
    z.object({ endpoint: webhookEndpointView, secret: z.string().meta({ description: 'Shown once; store it now.' }) }),
);

export const webhookDeliveryView = named(
    'WebhookDelivery',
    z.object({
        id,
        endpointId: id,
        eventId: id,
        eventName: z.string(),
        status: z.enum(WEBHOOK_DELIVERY_STATUSES),
        attempts: z.number().int(),
        nextAttemptAt: dateTime.nullable(),
        lastStatusCode: z.number().int().nullable(),
        lastError: z.string().nullable(),
        createdAt: dateTime,
        deliveredAt: dateTime.nullable(),
    }),
);
export const webhookDeliveryPage = named('WebhookDeliveryPage', page(webhookDeliveryView));

export const webhookTestResult = named(
    'WebhookTestResult',
    z.object({ delivery: webhookDeliveryView, statusCode: z.number().int().nullable(), ok: z.boolean() }),
);

export const webhookEventView = named('WebhookEvent', z.object({ name: z.string(), object: z.string() }));

export type WebhookEndpointView = z.output<typeof webhookEndpointView>;
export type WebhookDeliveryView = z.output<typeof webhookDeliveryView>;
export type WebhookEventView = z.output<typeof webhookEventView>;
