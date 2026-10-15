import { describe, expect, it } from 'vitest';
import { periodBounds } from './TeamPage';

describe('periodBounds (CAL-1)', () => {
    // A Thursday, mid-afternoon, in the reader's own time zone.
    const now = new Date(2026, 9, 15, 15, 30);

    it('a week runs Monday to Monday in the reader’s time zone', () => {
        const { from, to } = periodBounds('week', now);
        expect(new Date(from)).toEqual(new Date(2026, 9, 12));
        expect(new Date(to)).toEqual(new Date(2026, 9, 19));
    });

    it('this month and last month are whole calendar months, across a year end too', () => {
        expect(periodBounds('month', now)).toEqual({
            from: new Date(2026, 9, 1).toISOString(),
            to: new Date(2026, 10, 1).toISOString(),
        });
        expect(periodBounds('last-month', new Date(2027, 0, 10))).toEqual({
            from: new Date(2026, 11, 1).toISOString(),
            to: new Date(2027, 0, 1).toISOString(),
        });
    });

    it('a Sunday belongs to the week that began the Monday before', () => {
        const { from } = periodBounds('week', new Date(2026, 9, 18, 10));
        expect(new Date(from)).toEqual(new Date(2026, 9, 12));
    });
});
