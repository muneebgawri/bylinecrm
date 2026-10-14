import { SENDING_DOMAIN_RECHECK_MS } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { nextPostmasterReadAt } from './postmaster-schedule';
import { postmasterDay, retryAfterSecondsOf, spamRateBpsOf } from './postmaster.http';

/**
 * Postmaster Tools (P3-2b, #129, FR-CRMS-13): the day a check asks for, and what Google's traffic
 * stats answer becomes — a user-reported spam *ratio* (a fraction) read as basis points.
 */
describe('#129 FR-CRMS-13 Postmaster Tools', () => {
    it('asks for yesterday, UTC — Postmaster publishes a day once it is over', () => {
        expect(postmasterDay(new Date('2026-10-12T00:30:00Z'))).toBe('2026-10-11');
        expect(postmasterDay(new Date('2026-01-01T23:59:59Z'))).toBe('2025-12-31');
    });

    it('reads the user-reported spam ratio as basis points, rounded, and no ratio as no rate', () => {
        expect(spamRateBpsOf({ userReportedSpamRatio: 0.0035 })).toBe(35);
        expect(spamRateBpsOf({ userReportedSpamRatio: 0.00301 })).toBe(30);
        expect(spamRateBpsOf({ userReportedSpamRatio: 0 })).toBe(0);
        expect(spamRateBpsOf({})).toBeNull();
        expect(spamRateBpsOf({ userReportedSpamRatio: 'high' })).toBeNull();
    });

    describe('#183 a 429 is a rate limit, and a day is read once', () => {
        const now = new Date('2026-10-14T10:00:00Z');
        const DAY = 24 * 60 * 60 * 1000;

        it('reads Retry-After as seconds or as a date, and anything else as nothing', () => {
            expect(retryAfterSecondsOf('120', now)).toBe(120);
            expect(retryAfterSecondsOf('Wed, 14 Oct 2026 10:02:00 GMT', now)).toBe(120);
            expect(retryAfterSecondsOf('Wed, 14 Oct 2026 09:00:00 GMT', now)).toBe(0);
            expect(retryAfterSecondsOf(null, now)).toBeNull();
            expect(retryAfterSecondsOf('soon', now)).toBeNull();
            expect(retryAfterSecondsOf('-5', now)).toBeNull();
        });

        it('a reading for the day is enough until the next day, UTC', () => {
            expect(nextPostmasterReadAt({ status: 'ok' }, now, 0)).toEqual(new Date('2026-10-15T00:00:00Z'));
        });

        it('a rate limit waits for Retry-After, else the check cadence doubled per consecutive limit, at most a day', () => {
            expect(nextPostmasterReadAt({ status: 'rate_limited', retryAfterS: 120 }, now, 0)).toEqual(
                new Date(now.getTime() + 120_000),
            );
            expect(nextPostmasterReadAt({ status: 'rate_limited', retryAfterS: null }, now, 0)).toEqual(
                new Date(now.getTime() + SENDING_DOMAIN_RECHECK_MS),
            );
            expect(nextPostmasterReadAt({ status: 'rate_limited', retryAfterS: null }, now, 1)).toEqual(
                new Date(now.getTime() + 2 * SENDING_DOMAIN_RECHECK_MS),
            );
            expect(nextPostmasterReadAt({ status: 'rate_limited', retryAfterS: null }, now, 9)).toEqual(
                new Date(now.getTime() + DAY),
            );
        });

        it('anything transient or refused is tried again at the cadence; nothing connected is nothing to schedule', () => {
            for (const status of ['unreachable', 'failed', 'not_verified'] as const) {
                expect(nextPostmasterReadAt({ status }, now, 3), status).toEqual(
                    new Date(now.getTime() + SENDING_DOMAIN_RECHECK_MS),
                );
            }
            expect(nextPostmasterReadAt({ status: 'not_connected' }, now, 0)).toBeNull();
        });
    });
});
