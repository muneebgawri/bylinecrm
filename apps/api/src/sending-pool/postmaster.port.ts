/**
 * Postmaster Tools (P3-2b, #129, #190, FR-CRMS-13), behind one interface: the domains the connected
 * account holds there, and the user-reported spam rate Google publishes per verified domain and day.
 * The HTTP adapter (`postmaster.http.ts`, the Postmaster Tools API v2) is the only code that talks to
 * it; tests bind an in-memory fake (`test/support/fake-postmaster.ts`), so no test and no CI run ever
 * calls Google. Never called inside a database transaction.
 */

/**
 * What Google's JSON error body said (#190): its `status` (`RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`,
 * …), its `message` on one line and cut short, and the quota limit its `ErrorInfo` names when it
 * names one. Read from the body only — never a header, never the token.
 */
export interface GoogleErrorDetail {
    status: string | null;
    message: string | null;
    quotaLimit: string | null;
}

/** A domain the connected account added in Postmaster Tools, lower case. */
export interface PostmasterDomain {
    domain: string;
}

/**
 * One day's statistics (`YYYY-MM-DD`, UTC), in basis points: the user-reported spam rate and the
 * delivery-error rate (#190: every reject and temporary failure). Either is null when Google gave
 * none for the day — never a zero.
 */
export interface DayStats {
    day: string;
    spamRateBps: number | null;
    deliveryErrorBps: number | null;
}

/**
 * What a domain's daily statistics over a range say. `not_verified`: the connected account does not own
 * the domain in Postmaster Tools (Google answers 403 or 404). `found`: the days Google published a
 * statistic for, oldest first — none when it keeps data back under its traffic minimum. `rate_limited`:
 * a 429 (#183), an answer, not a failure; `retryAfterS` from its Retry-After when it gave one.
 * `quota_exhausted`: a 429 whose body is RESOURCE_EXHAUSTED and names a quota limit (#190) — the
 * project's Postmaster Tools API quota is spent.
 */
export type DomainStatsLookup =
    | { status: 'not_verified'; google: GoogleErrorDetail | null }
    | { status: 'found'; days: DayStats[] }
    | { status: 'rate_limited'; retryAfterS: number | null; google: GoogleErrorDetail | null }
    | { status: 'quota_exhausted'; retryAfterS: number | null; google: GoogleErrorDetail };

export interface PostmasterPort {
    /**
     * Every domain the connected account added in Postmaster Tools (`domains.list`, every page).
     * Throws `PostmasterRequestFailed` when Google did not answer it.
     */
    domains(accessToken: string): Promise<PostmasterDomain[]>;
    /**
     * The domain's user-reported spam rate and delivery-error rate for each day from `from` to `to`
     * (`YYYY-MM-DD`, UTC, inclusive), in one query, read with the connected account's access token. Throws `PostmasterRequestFailed`
     * when Google did not answer the question — a 5xx, a timeout, a refused token — so "could not
     * read" is never read as a rate.
     */
    domainStats(accessToken: string, domain: string, from: string, to: string): Promise<DomainStatsLookup>;
}

/** Google's status and message as one clause for a message or a log line, or nothing when it gave neither. */
export function describeGoogleError(google: GoogleErrorDetail | null): string | null {
    if (!google || (!google.status && !google.message)) return null;
    return [google.status, google.message].filter(Boolean).join(': ');
}

/**
 * Google did not answer: what was asked about, the status it gave (0 when it gave none), a reason
 * of ours, and what its error body said.
 */
export class PostmasterRequestFailed extends Error {
    constructor(
        readonly subject: string,
        readonly status: number,
        readonly reason: string,
        readonly google: GoogleErrorDetail | null = null,
    ) {
        const said = describeGoogleError(google);
        super(
            status === 0
                ? `Postmaster Tools could not be reached for ${subject}: ${reason}`
                : `Postmaster Tools answered ${status} for ${subject}: ${said ?? reason}`,
        );
        this.name = 'PostmasterRequestFailed';
    }
}

/** Injection token for the port. */
export const POSTMASTER_PORT = Symbol('POSTMASTER_PORT');
