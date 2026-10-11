import { SENDING_POOL_DEFAULTS, warmupDay, warmupLimit } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';

describe('FR-CRMS-6 warm-up ramp (P3-2)', () => {
    const { dailyCap, warmupStartPerDay, warmupDays } = SENDING_POOL_DEFAULTS;
    const limit = (day: number, cap = dailyCap) => warmupLimit(cap, warmupStartPerDay, warmupDays, day);

    it('starts at 5 a day and reaches the cap of 40 on day 21, rising evenly', () => {
        expect(limit(1)).toBe(5);
        expect(limit(2)).toBe(6);
        expect(limit(11)).toBe(22);
        expect(limit(20)).toBe(38);
        expect(limit(21)).toBe(40);
        expect(limit(60)).toBe(40);
    });

    it('never exceeds a cap lower than the ramp, and ramps to that cap instead', () => {
        expect(limit(1, 3)).toBe(3);
        expect(limit(15, 10)).toBe(8);
        expect(limit(21, 10)).toBe(10);
    });

    it('is the cap at once when warm-up is one day long', () => {
        expect(warmupLimit(40, 5, 1, 1)).toBe(40);
    });

    it('counts day 1 from the first connection, in whole 24-hour periods', () => {
        const start = new Date('2026-10-01T10:00:00Z');
        expect(warmupDay(start, new Date('2026-10-01T23:59:00Z'))).toBe(1);
        expect(warmupDay(start, new Date('2026-10-02T10:00:00Z'))).toBe(2);
        expect(warmupDay(start, new Date('2026-10-11T09:59:00Z'))).toBe(10);
    });
});
