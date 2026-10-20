import { INVOICE_GATEWAYS, INVOICE_REASON_MAX, INVOICE_REFERENCE_MAX } from '@bylinecrm/shared';
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
                'A NewswireOS API token with the `payment_verification:lookup` scope. Leave out to keep the current one.',
        }),
        secret: z.string().min(NEWSWIREOS_SECRET_MIN).max(NEWSWIREOS_SECRET_MAX).optional().meta({
            description: 'The webhook secret NewswireOS minted (`whsec_…`). Leave out to keep the current one.',
        }),
    }),
) {}
