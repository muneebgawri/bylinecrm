/**
 * NewswireOS's payment verification (INV-1), as the CRM needs it: one lookup of a gateway reference against an
 * expected amount. The CRM never imports NewswireOS code (D-239); it calls it. One port; the HTTP adapter and the
 * tests' fake implement it. The contract: docs/design-notes/INV-1.md.
 */

export interface NewswireosLink {
    baseUrl: string;
    apiToken: string;
}

export interface NewswireosLookupRequest {
    gateway: 'stripe' | 'paypal' | 'crypto_onchain';
    reference: string;
    /** Minor units, > 0. */
    amountCents: number;
    /** ISO 4217, lowercase. */
    currency: string;
}

/** NewswireOS's decision, exactly as `VerificationService.decide()` makes it. */
export type NewswireosDecision = 'verified' | 'invalid' | 'needs_review' | 'pending';

export interface NewswireosLookupResult {
    status: NewswireosDecision;
    reasonCode: string | null;
    canonicalReference: string | null;
    /** The rest of the answer (amount, currency, paid at, …), kept for display. */
    facts: Record<string, unknown>;
}

export interface NewswireosVerificationPort {
    lookup(link: NewswireosLink, request: NewswireosLookupRequest): Promise<NewswireosLookupResult>;
}

export const NEWSWIREOS_VERIFICATION_PORT = Symbol('NEWSWIREOS_VERIFICATION_PORT');

/** NewswireOS refused or did not answer. `status` is null when there was no answer. The token is never in it. */
export class NewswireosApiError extends Error {
    constructor(
        readonly status: number | null,
        message: string,
    ) {
        super(message);
        this.name = 'NewswireosApiError';
    }

    /** The token was refused: wrong, revoked, or without the scope. */
    get refused(): boolean {
        return this.status === 401 || this.status === 403;
    }

    /** Worth trying again: no answer, or NewswireOS's own failure. */
    get transient(): boolean {
        return this.status === null || this.status >= 500 || this.status === 429;
    }
}
