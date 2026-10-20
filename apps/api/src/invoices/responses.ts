import { INVOICE_GATEWAYS, INVOICE_STATUSES } from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named } from '../openapi/responses';

const dateTime = z.iso.datetime();

/** An invoice on a deal (INV-1, FR-CRMS-19). */
export const dealInvoiceView = named(
    'DealInvoice',
    z.object({
        id,
        opportunityId: id,
        gateway: z.enum(INVOICE_GATEWAYS),
        reference: z.string(),
        canonicalReference: z.string().nullable().meta({ description: 'The reference as NewswireOS names it.' }),
        amountMinor: z.string().meta({ description: 'What the payment must be, in minor units.' }),
        currency: z.string(),
        attachmentId: id.nullable().meta({ description: 'The receipt: a file on the deal.' }),
        status: z.enum(INVOICE_STATUSES).meta({
            description:
                '`verifying`: NewswireOS is being asked. `verified`: it counts. `invalid`: refused (see `reasonCode`). `needs_review`: waiting for finance (a person with `invoice:verify`). `invalidated`: refunded or charged back after it was verified.',
        }),
        reasonCode: z.string().nullable().meta({
            description:
                'NewswireOS’s reason (`AMOUNT_MISMATCH`, `NOT_FOUND`, `PROVIDER_ERROR`, …), or `NO_LINK`, `AWAITING_BANK_CONFIRMATION`, `TOKEN_REFUSED`, `MANUAL`, `REFUNDED`, `DISPUTED`.',
        }),
        note: z.string().nullable().meta({ description: 'Why a person verified or refused it by hand.' }),
        verifiedAt: dateTime.nullable(),
        invalidatedAt: dateTime.nullable(),
        createdById: id.nullable(),
        decidedById: id.nullable(),
        createdAt: dateTime,
    }),
);

/** The workspace's NewswireOS link as an admin sees it. Never the token or the secret. */
export const newswireosSettingsView = named(
    'NewswireosSettings',
    z.object({
        configured: z.boolean(),
        baseUrl: z.string().nullable().meta({ description: 'Where NewswireOS is.' }),
        hookUrl: z.url().nullable().meta({
            description: 'Give NewswireOS this URL, with the same secret, for refunds and chargebacks.',
        }),
        lastDeliveryAt: dateTime.nullable(),
        lastDeliveryResult: z.string().nullable().meta({
            description: '`applied`, `unmatched`, `ignored`, `ping` or `bad_signature`.',
        }),
    }),
);

export const newswireosHookResult = named(
    'NewswireosHookResult',
    z.object({ result: z.enum(['applied', 'unmatched', 'ignored', 'ping']) }),
);

export type NewswireosSettingsView = z.output<typeof newswireosSettingsView>;
export type NewswireosHookResult = z.output<typeof newswireosHookResult>;
