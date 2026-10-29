import {
    INVOICE_GATEWAYS,
    INVOICE_REASON_MAX,
    INVOICE_REFERENCE_MAX,
    NEWSWIREOS_PAYMENT_MODES,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
    NEWSWIREOS_BASE_URL_MAX,
    NEWSWIREOS_SECRET_MAX,
    NEWSWIREOS_SECRET_MIN,
    NEWSWIREOS_TOKEN_MAX,
} from './invoices.constants';

/** `POST /opportunities/:id/invoices`: a payment's reference, and what it must be. */
export class CreateInvoiceDto extends createZodDto(
    z.object({
        gateway: z.enum(INVOICE_GATEWAYS),
        reference: z.string().trim().min(1).max(INVOICE_REFERENCE_MAX).meta({
            description: 'A Stripe `pi_`/`ch_`/`in_` id, a PayPal capture or invoice number, a transaction hash.',
        }),
        expectedAmountMinor: z
            .string()
            .regex(/^[1-9][0-9]{0,15}$/)
            .optional()
            .meta({ description: 'Minor units. Leave out for the deal’s amount; less for a partial payment.' }),
        currency: z
            .string()
            .regex(/^[A-Za-z]{3}$/)
            .optional()
            .meta({ description: 'ISO 4217. Leave out for the deal’s currency.' }),
        attachmentId: z.uuid().optional().meta({ description: 'A receipt already uploaded to the deal.' }),
    }),
) {}

/** `POST …/invoices/:id/verify`: why, optionally. */
export class VerifyInvoiceDto extends createZodDto(
    z.object({ note: z.string().trim().max(INVOICE_REASON_MAX).optional() }),
) {}

/** `POST …/invoices/:id/reject`: why. */
export class RejectInvoiceDto extends createZodDto(
    z.object({ reason: z.string().trim().min(1).max(INVOICE_REASON_MAX) }),
) {}

/** `PUT /integrations/newswireos`: the token and the secret are needed the first time, and kept when left out. */
export class PutNewswireosSettingsDto extends createZodDto(
    z.object({
        baseUrl: z
            .url({ protocol: /^https?$/ })
            .max(NEWSWIREOS_BASE_URL_MAX)
            .meta({ description: 'NewswireOS’s address, `https://app.newswireos.example`.' }),
        apiToken: z.string().min(1).max(NEWSWIREOS_TOKEN_MAX).optional().meta({
            description:
                'A NewswireOS API token with the `payment_verification:lookup` scope (and `crm:ownership_write` to push ownership changes, `crm:client_write` to push won deals). Leave out to keep the current one.',
        }),
        secret: z.string().min(NEWSWIREOS_SECRET_MIN).max(NEWSWIREOS_SECRET_MAX).optional().meta({
            description: 'The webhook secret NewswireOS minted (`whsec_…`). Leave out to keep the current one.',
        }),
        dashboardUrl: z
            .url({ protocol: /^https?$/ })
            .max(NEWSWIREOS_BASE_URL_MAX)
            .nullable()
            .optional()
            .meta({
                description:
                    'INV-2: the NewswireOS dashboard’s workspace address, `https://dashboard.example/{workspace-slug}`, where a deal’s “Raise invoice” opens the client. Leave out to keep it; null clears it.',
            }),
    }),
) {}

/** `PUT /integrations/newswireos/ownership-push` (PNW-765): push completed ownership transfers to NewswireOS, or not. */
export class PutOwnershipPushDto extends createZodDto(
    z.object({
        enabled: z.boolean().meta({
            description: 'The link’s API token needs the `crm:ownership_write` scope. Off by default.',
        }),
    }),
) {}

/** `PUT /integrations/newswireos/deal-won-push` (PNW-766): push won deals to NewswireOS, or not. */
export class PutDealWonPushDto extends createZodDto(
    z.object({
        enabled: z.boolean().meta({
            description: 'The link’s API token needs the `crm:client_write` scope. Off by default.',
        }),
    }),
) {}

/** `PUT /integrations/newswireos/payment-mode` (INV-2). */
export class PutPaymentModeDto extends createZodDto(
    z.object({
        mode: z.enum(NEWSWIREOS_PAYMENT_MODES).meta({
            description: '`off`, `shadow` (record which deal only) or `on` (put each paid invoice on its deal).',
        }),
    }),
) {}

/** `POST /newswireos-payments/:id/choose` (INV-2): the deal a payment the CRM would not guess goes on. */
export class ChoosePaymentDealDto extends createZodDto(z.object({ opportunityId: z.uuid() })) {}
