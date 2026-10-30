import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisService } from '../infra/redis.service';
import { GMAIL_UNITS, GMAIL_USER_UNITS_PER_MINUTE } from './mail-sync.constants';
import { GmailQuota } from './quota';

/** The four Redis calls the quota makes, over a map; expiry is irrelevant inside one test's minute. */
function fakeRedis(): RedisService {
    const counts = new Map<string, number>();
    return {
        ensureReady: () => Promise.resolve(),
        incrby: (key: string, by: number) => {
            counts.set(key, (counts.get(key) ?? 0) + by);
            return Promise.resolve(counts.get(key));
        },
        decrby: (key: string, by: number) => {
            counts.set(key, (counts.get(key) ?? 0) - by);
            return Promise.resolve(counts.get(key));
        },
        expire: () => Promise.resolve(1),
    } as unknown as RedisService;
}

/**
 * PNW-1125: Google lowered the project's "Units per minute per user" from 15,000 to 6,000 (and its console allows no
 * more). The quota still let a mailbox spend 200 units a second, so a mailbox with a backlog crossed 6,000 inside a
 * minute and every run of pr@ and media@ ended `403 rateLimitExceeded`. However a run asks, no minute may pass 6,000.
 */
describe('GmailQuota', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-30T00:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('R-PNW-1125: a mailbox fetching as fast as it can stays under Google’s per-user minute in every window', async () => {
        const quota = new GmailQuota(fakeRedis());
        const granted: number[] = [];
        let stop = false;
        // Five fetches at once, as a run's `mapPool` asks, each taking its units the moment the last returned.
        const fetcher = async () => {
            while (!stop) {
                await quota.take('mailbox-1', GMAIL_UNITS.getMessage);
                granted.push(Date.now());
            }
        };
        const fetchers = Array.from({ length: 5 }, fetcher);
        await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
        stop = true;
        // Each fetcher still finishes the request it is waiting on: run the clock until every one has.
        await vi.runAllTimersAsync();
        await Promise.all(fetchers);

        expect(granted.length).toBeGreaterThan(0);
        // Google counts a sliding minute: every 60 s window that starts at a grant.
        let busiest = 0;
        for (let i = 0, j = 0; i < granted.length; i++) {
            while (j < granted.length && granted[j]! - granted[i]! < 60_000) j++;
            busiest = Math.max(busiest, (j - i) * GMAIL_UNITS.getMessage);
            if (j === granted.length) break;
        }
        expect(busiest).toBeLessThanOrEqual(GMAIL_USER_UNITS_PER_MINUTE);
    });
});
