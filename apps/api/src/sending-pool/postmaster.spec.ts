import { describe, expect, it } from 'vitest';
import { postmasterDay, spamRateBpsOf } from './postmaster.http';

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
});
