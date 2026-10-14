import { assertNoOpenTransaction } from '../../src/infra/transaction-scope';
import {
    PostmasterRequestFailed,
    type PostmasterPort,
    type TrafficStatsLookup,
} from '../../src/sending-pool/postmaster.port';

/**
 * In-memory Postmaster Tools (P3-2b, #129): a user-reported spam rate per domain, answered for any
 * day asked, never the network. A domain nothing was set for is not verified in Postmaster Tools
 * (Google answers 403 for those); `failNext` makes the next lookups fail, as a 5xx would, and
 * `rateLimitNext` answers 429 (#183), as Google's low per-project quota does. Like the
 * real adapter, it refuses to be asked inside a database transaction.
 */
export class FakePostmaster implements PostmasterPort {
    private readonly rates = new Map<string, number>();
    private failing: { left: number; status: number } = { left: 0, status: 503 };
    private limiting: { left: number; retryAfterS: number | null } = { left: 0, retryAfterS: null };
    readonly lookups: { accessToken: string; domain: string; day: string }[] = [];

    /** The domain is verified and reports this user-reported spam rate, in basis points. */
    setSpamRate(domain: string, rateBps: number): void {
        this.rates.set(domain.toLowerCase(), rateBps);
    }

    /** The domain is not (or no longer) verified in Postmaster Tools. */
    notVerified(domain: string): void {
        this.rates.delete(domain.toLowerCase());
    }

    /** The next lookups fail as Google not answering the question: a 5xx by default, or the status given (a 401). */
    failNext(times = 1, status = 503): void {
        this.failing = { left: times, status };
    }

    /** The next lookups answer 429 (#183): Google's per-project quota, with or without a Retry-After. */
    rateLimitNext(times = 1, retryAfterS: number | null = null): void {
        this.limiting = { left: times, retryAfterS };
    }

    trafficStats(accessToken: string, domain: string, day: string): Promise<TrafficStatsLookup> {
        assertNoOpenTransaction('FakePostmaster.trafficStats');
        this.lookups.push({ accessToken, domain: domain.toLowerCase(), day });
        if (this.failing.left > 0) {
            this.failing.left -= 1;
            return Promise.reject(new PostmasterRequestFailed(domain, this.failing.status, 'backend error'));
        }
        if (this.limiting.left > 0) {
            this.limiting.left -= 1;
            return Promise.resolve({ status: 'rate_limited', retryAfterS: this.limiting.retryAfterS });
        }
        const rate = this.rates.get(domain.toLowerCase());
        if (rate === undefined) return Promise.resolve({ status: 'not_verified' });
        return Promise.resolve({ status: 'found', day, spamRateBps: rate });
    }
}
