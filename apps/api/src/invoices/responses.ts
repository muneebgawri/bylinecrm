import {
    INVOICE_GATEWAYS,
    INVOICE_STATUSES,
    NEWSWIREOS_PAYMENT_DECISIONS,
    NEWSWIREOS_PAYMENT_MATCHES,
    NEWSWIREOS_PAYMENT_MODES,
} from '@bylinecrm/shared';
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
                '`applied` (a payment change applied, or a NewswireOS event put on a timeline), `unmatched`, `ignored`, `duplicate` (a redelivery), `bad_signature` or `no_secret`.',
        }),
        pushOwnership: z.boolean().meta({
            description:
                'PNW-765: whether completed ownership transfers are pushed to NewswireOS (the token needs `crm:ownership_write`). Off by default.',
        }),
        paymentMode: z.enum(NEWSWIREOS_PAYMENT_MODES).meta({
            description:
                'INV-2: what a paid invoice NewswireOS reports does. `off`: the timeline only. `shadow` (the default): records which deal it would go on, does nothing. `on`: puts it on that deal (or a new one), so verification and the stage rule move the deal.',
        }),
        pushDealWon: z.boolean().meta({
            description:
                'PNW-766: whether won deals are pushed to NewswireOS, which makes their contacts clients (the token needs `crm:client_write`). Off by default.',
        }),
    }),
);

const pushStatus = z.enum(['pending', 'retrying', 'delivered', 'not_ready', 'failed', 'skipped']);

/** PNW-766: one won deal pushed (or being pushed) to NewswireOS. */
export const dealWonDeliveryView = named(
    'NewswireosDealWonDelivery',
    z.object({
        id,
        eventId: id.meta({ description: 'The `deal.won` event: the push’s `event_id`.' }),
        opportunityId: id,
        personId: id.meta({ description: 'The deal’s contact: NewswireOS’s `customer_id` is kept on it.' }),
        companyId: id,
        dealName: z.string(),
        contactEmail: z.string(),
        ownerEmail: z.string(),
        status: pushStatus.meta({
            description:
                'As an ownership delivery’s: `retrying` (no answer, or NewswireOS failed on its side), `not_ready` (404), `failed` (any other 4xx, or out of retries), `skipped` (the push was turned off before it went).',
        }),
        attempts: z.number().int(),
        customerId: z.string().nullable().meta({ description: 'The NewswireOS client; null for `NOT_A_CLIENT`.' }),
        parentCustomerId: z.string().nullable().meta({ description: 'A colleague’s: the client it was added to.' }),
        reasonCode: z.string().nullable().meta({
            description:
                'NewswireOS’s `reason_code` (`CREATED`, `LINKED`, `COLLEAGUE`, `AGENCY_CLIENT`, `NOT_A_CLIENT`), or the CRM’s own as for an ownership delivery (`TOKEN_LACKS_SCOPE`, `PUSH_OFF`, …).',
        }),
        amReasonCode: z.string().nullable().meta({
            description: '`REASSIGNED`, `UNCHANGED`, `NO_AM_FOR_EMAIL` or `AGENCY_CLIENT`.',
        }),
        httpStatus: z.number().int().nullable(),
        lastError: z.string().nullable(),
        lastAttemptAt: dateTime.nullable(),
        createdAt: dateTime,
    }),
);

export type DealWonDeliveryView = z.output<typeof dealWonDeliveryView>;

/**
 * PNW-766: the dry run's body, for the latest won deal that qualifies. Nothing is sent: NewswireOS's route reads no
 * `test` flag. `found` false (and `payload` null) when no won deal has a contact with an email, a company and an owner.
 */
export const dealWonPushPreview = named(
    'NewswireosDealWonPreview',
    z.object({
        sent: z.literal(false),
        found: z.boolean(),
        opportunityId: id.nullable(),
        payload: z
            .object({
                event_id: z.string().meta({ description: 'Made up: a real push’s is its `deal.won` event.' }),
                occurred_at: z.string(),
                deal: z.object({
                    byline_id: z.string(),
                    name: z.string(),
                    amount_minor: z.number().int().optional(),
                    currency: z.string().optional(),
                }),
                company: z.object({ byline_id: z.string(), name: z.string(), domain: z.string().optional() }),
                contact: z.object({ byline_id: z.string(), email: z.string(), name: z.string().optional() }),
                owner: z.object({ email: z.string() }),
            })
            .nullable(),
    }),
);

export type DealWonPushPreview = z.output<typeof dealWonPushPreview>;

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

/** INV-2: a paid invoice NewswireOS reported, and which deal it went on (or, in shadow, would have). */
export const newswireosPaymentView = named(
    'NewswireosPayment',
    z.object({
        id,
        invoiceNumber: z.string(),
        paymentMethod: z.string().nullable().meta({ description: 'How the client paid, as NewswireOS names it.' }),
        amount: z.object({ amountMinor: z.number().int(), currency: z.string() }).nullable(),
        clientName: z.string().nullable(),
        clientEmail: z.string().nullable(),
        mode: z
            .enum(NEWSWIREOS_PAYMENT_MODES)
            .meta({ description: 'The mode it was decided in; `shadow` acted on nothing.' }),
        decision: z.enum(NEWSWIREOS_PAYMENT_DECISIONS),
        matchedBy: z.enum(NEWSWIREOS_PAYMENT_MATCHES).nullable(),
        opportunityId: id.nullable().meta({ description: 'The deal it went on, or would have; null until chosen.' }),
        opportunityName: z.string().nullable(),
        candidates: z
            .array(z.object({ id, name: z.string() }))
            .meta({ description: 'For `needs_deal`: the client’s open deals to choose from.' }),
        resolvedAt: dateTime.nullable().meta({ description: 'When a person chose the deal.' }),
        occurredAt: dateTime.nullable(),
        createdAt: dateTime,
    }),
);

/** INV-2: a reported payment beside what an Account Manager entered for the same invoice — shadow mode's check. */
export const newswireosPaymentReviewView = named(
    'NewswireosPaymentReview',
    newswireosPaymentView.extend({
        enteredOnOpportunityId: id.nullable().meta({
            description: 'The deal an Account Manager entered this invoice on by hand; null when none has.',
        }),
        agrees: z.boolean().nullable().meta({
            description: 'Whether that is the deal the CRM chose; null until someone has entered it.',
        }),
    }),
);

export type NewswireosPaymentView = z.output<typeof newswireosPaymentView>;
export type NewswireosPaymentReviewView = z.output<typeof newswireosPaymentReviewView>;
