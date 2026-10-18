import { assertNoOpenTransaction } from '../../src/infra/transaction-scope';
import {
    PostmasterRequestFailed,
    type GoogleErrorDetail,
    type PostmasterDomain,
    type PostmasterPort,
    type SpamRatesLookup,
} from '../../src/sending-pool/postmaster.port';

/** What Google's body says when the project's Postmaster Tools API quota is spent (#190). */
export const QUOTA_EXHAUSTED: GoogleErrorDetail = {
    status: 'RESOURCE_EXHAUSTED',
    message:
        "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'gmailpostmastertools.googleapis.com' for consumer 'project_number:000000000000'.",
    quotaLimit: 'QueriesPerDay',
};

/**
 * In-memory Postmaster Tools, as its v2 API answers (P3-2b, #129, #190): the domains the connected
 * account has added (`domains.list`), and a user-reported spam rate per domain and day, answered
 * for the range asked, never the network. A domain nothing was set for is not verified for the
 * account (Google answers 403 for those). `failNext` makes the next asks fail, as a 5xx would;
 * `rateLimitNext` answers 429 (#183) and `quotaExhaustedNext` answers 429 with Google's
 * RESOURCE_EXHAUSTED body naming the quota (#190). Like the real adapter, it refuses to be asked
 * inside a database transaction.
 */
export class FakePostmaster implements PostmasterPort {
    /** domain → day (`YYYY-MM-DD`, or `latest` for the last day of any range asked) → basis points. */
    private readonly rates = new Map<string, Map<string, number>>();
    private readonly account = new Map<string, boolean>();
    private failing: { left: number; status: number; google: GoogleErrorDetail | null } = {
        left: 0,
        status: 503,
        google: null,
    };
    private limiting: { left: number; retryAfterS: number | null; google: GoogleErrorDetail | null; quota: boolean } = {
        left: 0,
        retryAfterS: null,
        google: null,
        quota: false,
    };
    readonly lookups: { accessToken: string; domain: string; from: string; to: string }[] = [];
    readonly listings: { accessToken: string }[] = [];

    /** The domain is verified and reports this rate, in basis points, for `day` — or for the last day of any range asked. */
    setSpamRate(domain: string, rateBps: number, day = 'latest'): void {
        const days = this.rates.get(domain.toLowerCase()) ?? new Map<string, number>();
        days.set(day, rateBps);
        this.rates.set(domain.toLowerCase(), days);
    }

    /** The domain is verified, and Google has no data for it: too little Gmail-bound traffic. */
    verifiedWithoutData(domain: string): void {
        this.rates.set(domain.toLowerCase(), new Map());
    }

    /** The domain is not (or no longer) verified in Postmaster Tools. */
    notVerified(domain: string): void {
        this.rates.delete(domain.toLowerCase());
    }

    /** The connected account has added the domain in Postmaster Tools (`domains.list` names it). */
    addToAccount(domain: string, verified = true): void {
        this.account.set(domain.toLowerCase(), verified);
    }

    removeFromAccount(domain: string): void {
        this.account.delete(domain.toLowerCase());
    }

    /** The next asks fail as Google not answering the question: a 5xx by default, or the status given (a 401). */
    failNext(times = 1, status = 503, google: GoogleErrorDetail | null = null): void {
        this.failing = { left: times, status, google };
    }

    /** The next reads answer 429 (#183), with or without a Retry-After and Google's error body. */
    rateLimitNext(times = 1, retryAfterS: number | null = null, google: GoogleErrorDetail | null = null): void {
        this.limiting = { left: times, retryAfterS, google, quota: false };
    }

    /** The next reads answer 429 with Google's RESOURCE_EXHAUSTED body naming the project's quota (#190). */
    quotaExhaustedNext(times = 1, google: GoogleErrorDetail = QUOTA_EXHAUSTED): void {
        this.limiting = { left: times, retryAfterS: null, google, quota: true };
    }

    domains(accessToken: string): Promise<PostmasterDomain[]> {
        assertNoOpenTransaction('FakePostmaster.domains');
        this.listings.push({ accessToken });
        if (this.failing.left > 0) {
            this.failing.left -= 1;
            return Promise.reject(
                new PostmasterRequestFailed('the account', this.failing.status, 'backend error', this.failing.google),
            );
        }
        return Promise.resolve([...this.account].map(([domain, verified]) => ({ domain, verified })));
    }

    spamRates(accessToken: string, domain: string, from: string, to: string): Promise<SpamRatesLookup> {
        assertNoOpenTransaction('FakePostmaster.spamRates');
        this.lookups.push({ accessToken, domain: domain.toLowerCase(), from, to });
        if (this.failing.left > 0) {
            this.failing.left -= 1;
            return Promise.reject(
                new PostmasterRequestFailed(domain, this.failing.status, 'backend error', this.failing.google),
            );
        }
        if (this.limiting.left > 0) {
            this.limiting.left -= 1;
            const { retryAfterS, google, quota } = this.limiting;
            return Promise.resolve(
                quota && google
                    ? { status: 'quota_exhausted', retryAfterS, google }
                    : { status: 'rate_limited', retryAfterS, google },
            );
        }
        const days = this.rates.get(domain.toLowerCase());
        if (!days) {
            return Promise.resolve({
                status: 'not_verified',
                google: {
                    status: 'PERMISSION_DENIED',
                    message: 'The caller does not have permission',
                    quotaLimit: null,
                },
            });
        }
        const rates = [...days]
            .map(([day, spamRateBps]) => ({ day: day === 'latest' ? to : day, spamRateBps }))
            .filter((r) => r.day >= from && r.day <= to)
            .sort((a, b) => a.day.localeCompare(b.day));
        return Promise.resolve({ status: 'found', rates });
    }
}
