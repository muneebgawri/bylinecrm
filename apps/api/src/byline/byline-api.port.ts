import type { BylineEnrichment, BylineVerification } from '@byline/contract';

/** Injection token for the BylineAI API client; the suite overrides it with a fake. */
export const BYLINE_API = Symbol('BYLINE_API');

/** A workspace's BylineAI API link: where, and the key (opened). */
export interface BylineLink {
    baseUrl: string;
    apiKey: string;
}

/**
 * Why BylineAI did not answer: its budget cap (`budget`, HTTP 402), its rate limit (`rate_limited`, 429), a key it
 * refused (`unauthorized`, 401/403), or it could not be reached or failed (`unavailable`). The message is fit to
 * show a member as is.
 */
export class BylineApiError extends Error {
    constructor(
        readonly kind: 'budget' | 'rate_limited' | 'unauthorized' | 'unavailable',
        message: string,
    ) {
        super(message);
        this.name = 'BylineApiError';
    }

    /** Worth asking again later (a rate limit, an outage); a spent budget or a refused key is not, until changed. */
    get retryable(): boolean {
        return this.kind === 'rate_limited' || this.kind === 'unavailable';
    }
}

/**
 * BylineAI's enrichment and verification, asked by address with the workspace's key (BYL-2). It reaches the network,
 * so it is never called inside a database transaction. Budgets are BylineAI's; this only reports them.
 */
export interface BylineApi {
    /** What BylineAI knows about the address; null when it knows nothing. */
    enrich(link: BylineLink, email: string): Promise<BylineEnrichment | null>;
    verify(link: BylineLink, email: string): Promise<BylineVerification>;
}
