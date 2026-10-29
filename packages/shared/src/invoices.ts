/**
 * Invoices on a deal (INV-1, FR-CRMS-19): a gateway reference verified by NewswireOS before it counts.
 * The contract with NewswireOS: docs/design-notes/INV-1.md.
 */

/** The rails a reference can be on. `bank_wire` has no feed: it always waits for a person. */
export const INVOICE_GATEWAYS = ['newswireos_invoice', 'stripe', 'paypal', 'crypto_onchain', 'bank_wire'] as const;
export type InvoiceGateway = (typeof INVOICE_GATEWAYS)[number];

/**
 * `verifying` → `verified` | `invalid` | `needs_review`; a refund or chargeback later makes a verified one
 * `invalidated`. Uncertainty never passes: anything NewswireOS cannot decide is `needs_review`.
 */
export const INVOICE_STATUSES = ['verifying', 'verified', 'invalid', 'needs_review', 'invalidated'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Present on `invoice.*` events. */
export interface InvoiceEventPayload {
    opportunityId: string;
    gateway: InvoiceGateway;
    reference: string;
    amountMinor: string;
    /** Refunded so far; `amountMinor - refundedAmountMinor` is what counts toward the deal. */
    refundedAmountMinor: string;
    currency: string;
    status: InvoiceStatus;
    reasonCode: string | null;
    /** `true` when the deal's verified invoices now cover its amount (the stage rule's condition). */
    covers: boolean;
}

export const INVOICE_REFERENCE_MAX = 500;
export const INVOICE_REASON_MAX = 500;

/** An invoice on a deal, as `GET /opportunities/:id/invoices` returns it. Amounts are minor units, as strings. */
export interface DealInvoiceView {
    id: string;
    opportunityId: string;
    gateway: InvoiceGateway;
    reference: string;
    canonicalReference: string | null;
    /** For a NewswireOS invoice number: the rail NewswireOS resolved it to (newswireos#647). */
    resolvedGateway: InvoiceGateway | null;
    amountMinor: string;
    /** Refunded so far; a verified invoice with some refunded is partially refunded. */
    refundedAmountMinor: string;
    currency: string;
    attachmentId: string | null;
    status: InvoiceStatus;
    reasonCode: string | null;
    note: string | null;
    verifiedAt: string | null;
    invalidatedAt: string | null;
    createdById: string | null;
    decidedById: string | null;
    createdAt: string;
}

/** What a notification about an invoice shows (INV-1). */
export interface InvoiceSummary {
    id: string;
    opportunityId: string;
    opportunityName: string;
    gateway: InvoiceGateway;
    reference: string;
    reasonCode: string | null;
}

/**
 * INV-2: what the CRM does with a paid invoice NewswireOS reports (`invoice.paid`). `off` puts it on the timeline
 * only; `shadow` also records which deal it would go on, and does nothing else; `on` puts it on that deal (or a new
 * one) as an Account Manager would, so the same verification and stage rule move the deal.
 */
export const NEWSWIREOS_PAYMENT_MODES = ['off', 'shadow', 'on'] as const;
export type NewswireosPaymentMode = (typeof NEWSWIREOS_PAYMENT_MODES)[number];

/**
 * INV-2: which deal a paid invoice goes on, and how that was decided.
 * - `already_on_deal`: an Account Manager had already entered it; nothing is done.
 * - `attached`: the deal NewswireOS named (`deal_id`), or the client's only open deal (`only_open_deal`).
 * - `created_deal`: the client had no open deal; one is made for the payment, and its owner is told. Only for a
 *   client matched by CRM id or email: one matched by company domain alone is `needs_deal`, for its owner to decide.
 * - `needs_deal`: the client has several open deals; the owner is asked which, never guessed.
 * - `unmatched`: no person or company in the CRM is this client; whoever verifies invoices is told.
 * - `pooled_elsewhere`: another workspace of this one's lead pool holds the client; it is that workspace's payment,
 *   so nothing is done here and no one is told (were both linked to NewswireOS, it would otherwise count twice).
 */
export const NEWSWIREOS_PAYMENT_DECISIONS = [
    'already_on_deal',
    'attached',
    'created_deal',
    'needs_deal',
    'unmatched',
    'pooled_elsewhere',
] as const;
export type NewswireosPaymentDecision = (typeof NEWSWIREOS_PAYMENT_DECISIONS)[number];
export const NEWSWIREOS_PAYMENT_MATCHES = ['deal_id', 'only_open_deal'] as const;
export type NewswireosPaymentMatch = (typeof NEWSWIREOS_PAYMENT_MATCHES)[number];
