/**
 * Postmaster Tools (P3-2b, #129, FR-CRMS-13), behind one interface: the user-reported spam rate
 * Google publishes per verified domain and day. The HTTP adapter (`postmaster.http.ts`) is the only
 * code that talks to it; tests bind an in-memory fake (`test/support/fake-postmaster.ts`), so no
 * test and no CI run ever calls Google. Never called inside a database transaction.
 */

/**
 * What a day's traffic stats say about a domain. `not_verified`: the connected account does not
 * own the domain in Postmaster Tools (Google answers 403). `no_data`: the domain is verified but
 * Google published nothing for that day — it keeps data back under a traffic minimum. `found`:
 * the day's user-reported spam rate, in basis points, or null when the day's record has none.
 */
export type TrafficStatsLookup =
    | { status: 'not_verified' }
    | { status: 'no_data'; day: string }
    | { status: 'found'; day: string; spamRateBps: number | null };

export interface PostmasterPort {
    /**
     * The domain's traffic stats for one day (`YYYY-MM-DD`, UTC), read with the connected
     * account's access token. Throws `PostmasterRequestFailed` when Google did not answer the
     * question — a 5xx, a timeout, a refused token — so "could not read" is never read as a rate.
     */
    trafficStats(accessToken: string, domain: string, day: string): Promise<TrafficStatsLookup>;
}

/** Google did not answer: the status it gave (0 when it gave none) and a reason safe to show. */
export class PostmasterRequestFailed extends Error {
    constructor(
        readonly domain: string,
        readonly status: number,
        readonly reason: string,
    ) {
        super(
            status === 0
                ? `Postmaster Tools could not be reached for ${domain}: ${reason}`
                : `Postmaster Tools answered ${status} for ${domain}: ${reason}`,
        );
        this.name = 'PostmasterRequestFailed';
    }
}

/** Injection token for the port. */
export const POSTMASTER_PORT = Symbol('POSTMASTER_PORT');
