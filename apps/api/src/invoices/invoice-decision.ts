import { INVOICE_REASONS } from './invoices.constants';
import { NewswireosApiError, type NewswireosLookupResult } from './newswireos-verification.port';

/** What a verification settles an invoice as. */
export interface Settlement {
    status: 'verified' | 'invalid' | 'needs_review';
    reasonCode: string | null;
    canonicalReference: string | null;
    /** For a NewswireOS invoice number: the rail NewswireOS resolved it to. */
    resolvedGateway?: 'stripe' | 'paypal' | 'crypto_onchain' | 'bank_wire' | null;
    facts: Record<string, unknown>;
}

/**
 * NewswireOS's answer, or its failure, as the invoice's state (INV-1). Uncertainty never passes: `pending` (not
 * enough confirmations yet) and anything undecided wait for a person; a refused token waits too, since the payment
 * may be fine. A failure worth retrying is `retry` until the last attempt, then `needs_review`.
 */
export function settle(
    outcome: { result: NewswireosLookupResult } | { error: unknown; finalAttempt: boolean },
    gateway?: string,
): Settlement | 'retry' {
    const settled = settleAnswer(outcome);
    if (settled !== 'retry' && 'result' in outcome && outcome.result.gateway) {
        settled.resolvedGateway = outcome.result.gateway;
    }
    if (gateway !== 'newswireos_invoice') return settled;
    // A NewswireOS that knows invoice numbers (#647) says who holds the payment; its refusals (`NOT_FOUND`,
    // `INVOICE_VOID`, `INVOICE_UNPAID`, `NO_PROVIDER_PAYMENT`) then stand as `invalid`.
    const current = 'result' in outcome && outcome.result.holder !== undefined;
    return current ? settled : unresolvedInvoiceNumber(settled);
}

/** Reasons an older NewswireOS gives for a gateway it does not know. */
const UNRESOLVED_REASONS: readonly string[] = ['NOT_FOUND', 'UNSUPPORTED_GATEWAY', 'INVALID_GATEWAY'];

/**
 * A NewswireOS invoice number (`INV-202610-000067`, `2GBMDHSF-0002`) asked of a NewswireOS before #647: a
 * "not found" or "unsupported gateway" answer (or the 4xx refusing the request) says nothing about the payment, so
 * it waits for a person, never `invalid`.
 */
function unresolvedInvoiceNumber(settled: Settlement | 'retry'): Settlement | 'retry' {
    if (settled === 'retry' || settled.status !== 'invalid') return settled;
    const reason = settled.reasonCode ?? '';
    if (reason !== INVOICE_REASONS.badRequest && !UNRESOLVED_REASONS.includes(reason)) return settled;
    return {
        status: 'needs_review',
        reasonCode: INVOICE_REASONS.invoiceNumberUnresolved,
        canonicalReference: settled.canonicalReference,
        facts: { ...settled.facts, newswireosReason: reason },
    };
}

function settleAnswer(
    outcome: { result: NewswireosLookupResult } | { error: unknown; finalAttempt: boolean },
): Settlement | 'retry' {
    if ('result' in outcome) {
        const { status, reasonCode, canonicalReference, facts } = outcome.result;
        if (status === 'verified' || status === 'invalid') return { status, reasonCode, canonicalReference, facts };
        return {
            status: 'needs_review',
            reasonCode: reasonCode ?? INVOICE_REASONS.noDecision,
            canonicalReference,
            facts,
        };
    }
    const { error, finalAttempt } = outcome;
    if (error instanceof NewswireosApiError && error.refused) {
        return {
            status: 'needs_review',
            reasonCode: error.status === 403 ? INVOICE_REASONS.tokenLacksScope : INVOICE_REASONS.tokenRefused,
            canonicalReference: null,
            facts: {},
        };
    }
    if (error instanceof NewswireosApiError && !error.transient) {
        return {
            status: 'invalid',
            reasonCode: INVOICE_REASONS.badRequest,
            canonicalReference: null,
            facts: { message: error.message },
        };
    }
    if (!finalAttempt) return 'retry';
    return { status: 'needs_review', reasonCode: INVOICE_REASONS.providerError, canonicalReference: null, facts: {} };
}

/**
 * Whether a deal's verified invoices cover its amount: those in the deal's currency, net of refunds, add up to at
 * least it. A deal
 * with no amount is covered by any verified invoice.
 */
export function covers(
    deal: { amountMinor: bigint | null; currency: string },
    verified: readonly { amountMinor: bigint; refundedAmountMinor?: bigint; currency: string }[],
): boolean {
    if (verified.length === 0) return false;
    if (deal.amountMinor === null) return true;
    return verifiedTotal(deal.currency, verified) >= deal.amountMinor;
}

/** What a deal's verified invoices add up to in `currency`, net of refunds (never below zero). */
export function verifiedTotal(
    currency: string,
    verified: readonly { amountMinor: bigint; refundedAmountMinor?: bigint; currency: string }[],
): bigint {
    const sum = verified
        .filter((i) => i.currency === currency)
        .reduce((a, i) => a + i.amountMinor - (i.refundedAmountMinor ?? 0n), 0n);
    return sum > 0n ? sum : 0n;
}
