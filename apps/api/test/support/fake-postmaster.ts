import { assertNoOpenTransaction } from '../../src/infra/transaction-scope';
import {
    PostmasterRequestFailed,
    type PostmasterPort,
    type TrafficStatsLookup,
} from '../../src/sending-pool/postmaster.port';

/**
 * In-memory Postmaster Tools (P3-2b, #129): a user-reported spam rate per domain, answered for any
 * day asked, never the network. A domain nothing was set for is not verified in Postmaster Tools
 * (Google answers 403 for those); `failNext` makes the next lookups fail, as a 5xx would. Like the
 * real adapter, it refuses to be asked inside a database transaction.
 */
export class FakePostmaster implements PostmasterPort {
    private readonly rates = new Map<string, number>();
    private failing = 0;
    readonly lookups: { accessToken: string; domain: string; day: string }[] = [];

    /** The domain is verified and reports this user-reported spam rate, in basis points. */
    setSpamRate(domain: string, rateBps: number): void {
        this.rates.set(domain.toLowerCase(), rateBps);
    }

    /** The domain is not (or no longer) verified in Postmaster Tools. */
    notVerified(domain: string): void {
        this.rates.delete(domain.toLowerCase());
    }

    failNext(times = 1): void {
        this.failing = times;
    }

    trafficStats(accessToken: string, domain: string, day: string): Promise<TrafficStatsLookup> {
        assertNoOpenTransaction('FakePostmaster.trafficStats');
        this.lookups.push({ accessToken, domain: domain.toLowerCase(), day });
        if (this.failing > 0) {
            this.failing -= 1;
            return Promise.reject(new PostmasterRequestFailed(domain, 503, 'backend error'));
        }
        const rate = this.rates.get(domain.toLowerCase());
        if (rate === undefined) return Promise.resolve({ status: 'not_verified' });
        return Promise.resolve({ status: 'found', day, spamRateBps: rate });
    }
}
