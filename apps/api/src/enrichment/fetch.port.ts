/** Injection token for the web adapter the sources read pages through; tests override it with an in-memory fake. */
export const ENRICHMENT_FETCH = Symbol('ENRICHMENT_FETCH');

/** A page as fetched: the status, the type, the URL it was finally served from (after redirects), the text. */
export interface FetchedPage {
    status: number;
    contentType: string;
    finalUrl: string;
    text: string;
}

/**
 * The only web access enrichment has (P4-2): a public page by its URL, and whether a public URL
 * exists (a `HEAD`). Every host must be public (the webhook URL guard's rule — never the network
 * the API runs in), redirects are followed a few times, a body is read up to a cap, and a fetch
 * that fails for any reason throws `FetchFailed`, so "could not read" is never read as "says
 * nothing". Never called inside a database transaction (P2-2a).
 */
export interface EnrichmentFetch {
    get(url: string): Promise<FetchedPage>;
    check(url: string): Promise<boolean>;
}

export class FetchFailed extends Error {
    constructor(
        readonly url: string,
        readonly reason: string,
    ) {
        super(`could not fetch ${url}: ${reason}`);
    }
}
