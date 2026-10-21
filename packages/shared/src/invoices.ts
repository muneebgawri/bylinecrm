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
