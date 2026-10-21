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
    /** `newswireos_invoice`: `reference` is NewswireOS's own invoice number (`INV-202610-000067`, `2GBMDHSF-0002`). */
    gateway: 'stripe' | 'paypal' | 'crypto_onchain' | 'newswireos_invoice';
    reference: string;
    /** Minor units, > 0. */
    amountCents: number;
    /** ISO 4217, lowercase. */
    currency: string;
    /**
     * Who the client is (newswireos#647): the deal's contact and company people's addresses (at most
     * `NEWSWIREOS_CLIENT_EMAILS_MAX`), and the company's domain unless it is free mail. NewswireOS uses them to say
     * whether a release already holding the payment is this client's (`holder`). Omitted when empty.
     */
    clientEmails?: string[];
    clientDomain?: string | null;
}

/**
 * Who already holds the payment (newswireos#647): no one, someone (no client was named), a release of the same
 * client, or another client's. Absent from an older NewswireOS: `already_used` decides as before.
 */
export type NewswireosHolder = 'none' | 'held' | 'same_client' | 'other_client';

/** NewswireOS's decision, exactly as `VerificationService.decide()` makes it. */
export type NewswireosDecision = 'verified' | 'invalid' | 'needs_review' | 'pending';

export interface NewswireosLookupResult {
    status: NewswireosDecision;
    reasonCode: string | null;
    canonicalReference: string | null;
    /** The real rail NewswireOS named (for a NewswireOS invoice number, the gateway its payment went through). */
    gateway?: 'stripe' | 'paypal' | 'crypto_onchain' | 'bank_wire' | null;
    /** Who already holds the payment; undefined when NewswireOS did not say (before #647). */
    holder?: NewswireosHolder | undefined;
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
        /** NewswireOS's own `reason_code` on a refusal, when it gave one. */
        readonly reasonCode: string | null = null,
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
