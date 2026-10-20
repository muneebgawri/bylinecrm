import { INVOICE_REASONS } from './invoices.constants';
import { NewswireosApiError, type NewswireosLookupResult } from './newswireos-verification.port';

/** What a verification settles an invoice as. */
export interface Settlement {
    status: 'verified' | 'invalid' | 'needs_review';
    reasonCode: string | null;
    canonicalReference: string | null;
    facts: Record<string, unknown>;
}

/**
 * NewswireOS's answer, or its failure, as the invoice's state (INV-1). Uncertainty never passes: `pending` (not
 * enough confirmations yet) and anything undecided wait for a person; a refused token waits too, since the payment
 * may be fine. A failure worth retrying is `retry` until the last attempt, then `needs_review`.
 */
export function settle(
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
            reasonCode: INVOICE_REASONS.tokenRefused,
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
 * Whether a deal's verified invoices cover its amount: those in the deal's currency add up to at least it. A deal
 * with no amount is covered by any verified invoice.
 */
export function covers(
    deal: { amountMinor: bigint | null; currency: string },
    verified: readonly { amountMinor: bigint; currency: string }[],
): boolean {
    if (verified.length === 0) return false;
    if (deal.amountMinor === null) return true;
    const sum = verified.filter((i) => i.currency === deal.currency).reduce((a, i) => a + i.amountMinor, 0n);
    return sum >= deal.amountMinor;
}
