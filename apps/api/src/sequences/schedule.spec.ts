import { describe, expect, it } from 'vitest';
import { addWaitDays, nextWindowStart, zoneForCountry } from './schedule';

const weekdays9to17 = { startMinute: 9 * 60, endMinute: 17 * 60, days: 0b0011111 };

describe('FR-CRMS-4 / FR-CRMS-5 a step’s time, in the recipient’s local time', () => {
    it('infers a zone from the country, falling back to the sequence’s zone', () => {
        expect(zoneForCountry('DE', 'UTC')).toBe('Europe/Berlin');
        expect(zoneForCountry('GB', 'UTC')).toBe('Europe/London');
        expect(zoneForCountry('US', 'UTC')).toBe('America/New_York');
        expect(zoneForCountry(null, 'Asia/Karachi')).toBe('Asia/Karachi');
        expect(zoneForCountry('ZZ', 'Asia/Karachi')).toBe('Asia/Karachi');
    });

    it('keeps an instant already inside the window', () => {
        // Tue 2026-10-13 10:00 in Berlin (CEST, UTC+2) = 08:00Z.
        const at = new Date('2026-10-13T08:00:00Z');
        expect(nextWindowStart(at, 'Europe/Berlin', weekdays9to17).toISOString()).toBe(at.toISOString());
    });

    it('waits for the window to open the same day, and never sends after it closes: it rolls to the next allowed day', () => {
        // Tue 07:00 Berlin → Tue 09:00 Berlin.
        expect(nextWindowStart(new Date('2026-10-13T05:00:00Z'), 'Europe/Berlin', weekdays9to17).toISOString()).toBe(
            '2026-10-13T07:00:00.000Z',
        );
        // Tue 18:00 Berlin → Wed 09:00 Berlin.
        expect(nextWindowStart(new Date('2026-10-13T16:00:00Z'), 'Europe/Berlin', weekdays9to17).toISOString()).toBe(
            '2026-10-14T07:00:00.000Z',
        );
        // Fri 18:00 New York (EDT, UTC-4) → Mon 09:00 New York.
        expect(nextWindowStart(new Date('2026-10-16T22:00:00Z'), 'America/New_York', weekdays9to17).toISOString()).toBe(
            '2026-10-19T13:00:00.000Z',
        );
    });

    it('opens the window at the right wall-clock time across a DST change', () => {
        // Berlin leaves summer time on Sun 2026-10-25. Sat 18:00 CEST → Mon 26th 09:00 CET (08:00Z).
        expect(nextWindowStart(new Date('2026-10-24T16:00:00Z'), 'Europe/Berlin', weekdays9to17).toISOString()).toBe(
            '2026-10-26T08:00:00.000Z',
        );
    });

    it('waits calendar days, or business days skipping the weekend, in the recipient’s zone', () => {
        // Thu 2026-10-15 10:00 Berlin + 3 business days → Tue 20th 10:00 Berlin.
        expect(addWaitDays(new Date('2026-10-15T08:00:00Z'), 3, true, 'Europe/Berlin').toISOString()).toBe(
            '2026-10-20T08:00:00.000Z',
        );
        // + 3 calendar days → Sun 18th 10:00 Berlin.
        expect(addWaitDays(new Date('2026-10-15T08:00:00Z'), 3, false, 'Europe/Berlin').toISOString()).toBe(
            '2026-10-18T08:00:00.000Z',
        );
    });
});
