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
        resolvedGateway: z.enum(INVOICE_GATEWAYS).nullable(),
        reference: z.string(),
        canonicalReference: z.string().nullable().meta({ description: 'The reference as NewswireOS names it.' }),
        amountMinor: z.string().meta({ description: 'What the payment must be, in minor units.' }),
        refundedAmountMinor: z.string().meta({
            description:
                'Refunded so far. A verified invoice with some refunded counts net of it (partially refunded).',
        }),
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
        secretSet: z.boolean().meta({
            description:
                'Whether the hook secret NewswireOS minted has been pasted; deliveries are refused until it is.',
        }),
        baseUrl: z.string().nullable().meta({ description: 'Where NewswireOS is.' }),
        hookUrl: z.url().nullable().meta({
            description: 'Give NewswireOS this URL, with the same secret, for refunds and chargebacks.',
        }),
        lastDeliveryAt: dateTime.nullable(),
        lastDeliveryResult: z.string().nullable().meta({
            description:
                '`applied`, `unmatched`, `ignored`, `duplicate` (a redelivery), `bad_signature` or `no_secret`.',
        }),
        pushOwnership: z.boolean().meta({
            description:
                'PNW-765: whether completed ownership transfers are pushed to NewswireOS (the token needs `crm:ownership_write`). Off by default.',
        }),
    }),
);

const ownershipReason = z.enum(['transfer', 'forced', 'first_contact']);

/** PNW-765: one ownership change pushed (or being pushed) to NewswireOS. */
export const ownershipDeliveryView = named(
    'NewswireosOwnershipDelivery',
    z.object({
        id,
        eventId: id.meta({ description: 'The `transfer.completed` event: the push’s `event_id`.' }),
        transferId: id,
        recordType: z.enum(['person', 'company']),
        recordId: id,
        recordName: z.string(),
        newOwnerEmail: z.string(),
        reason: ownershipReason,
        status: z.enum(['pending', 'retrying', 'delivered', 'not_ready', 'failed', 'skipped']).meta({
            description:
                '`retrying`: NewswireOS did not answer, or failed on its side; tried again with backoff. `not_ready`: NewswireOS answered 404 (the route is not deployed yet); not retried. `failed`: refused (any other 4xx), or out of retries. `skipped`: the push was turned off before it went.',
        }),
        attempts: z.number().int(),
        matched: z.boolean().nullable().meta({ description: 'Whether NewswireOS found the client.' }),
        customers: z.array(z.object({ customerId: z.string(), reasonCode: z.string().nullable() })).meta({
            description: 'The NewswireOS clients the change touched: `REASSIGNED`, `UNCHANGED` or `AGENCY_CLIENT`.',
        }),
        reasonCode: z.string().nullable().meta({
            description:
                'NewswireOS’s `reason_code` (`NO_AM_FOR_EMAIL`, `STALE`, `NO_CUSTOMER`, `REASSIGNED`, `UNCHANGED`, `AGENCY_CLIENT`), or `NEWSWIREOS_NOT_READY`, `TOKEN_REFUSED` (401), `TOKEN_LACKS_SCOPE` (403), `BAD_REQUEST` (400), `REJECTED`, `NEWSWIREOS_UNAVAILABLE`, `PUSH_OFF`.',
        }),
        httpStatus: z.number().int().nullable(),
        lastError: z.string().nullable(),
        lastAttemptAt: dateTime.nullable(),
        createdAt: dateTime,
    }),
);

/** PNW-765: the dry run's body. Nothing is sent: NewswireOS's route reads no `test` flag. */
export const ownershipPushPreview = named(
    'NewswireosOwnershipPreview',
    z.object({
        sent: z.literal(false),
        payload: z.object({
            event_id: z.string(),
            occurred_at: z.string(),
            record_type: z.enum(['person', 'company']),
            record: z.object({
                byline_id: z.string(),
                emails: z.array(z.string()),
                domain: z.string().optional(),
                name: z.string().optional(),
            }),
            previous_owner: z.object({ email: z.string() }).nullable(),
            new_owner: z.object({ email: z.string() }),
            reason: ownershipReason,
            forced: z.boolean(),
            test: z.literal(true),
        }),
    }),
);

export type OwnershipDeliveryView = z.output<typeof ownershipDeliveryView>;
export type OwnershipPushPreview = z.output<typeof ownershipPushPreview>;

export const newswireosHookResult = named(
    'NewswireosHookResult',
    z.object({ result: z.enum(['applied', 'unmatched', 'ignored', 'duplicate']) }),
);

export type NewswireosSettingsView = z.output<typeof newswireosSettingsView>;
export type NewswireosHookResult = z.output<typeof newswireosHookResult>;
