import { describe, expect, it } from 'vitest';
import { monthsIn, presetRange, previousRange, rangeLabel } from './reportsData';

const NOW = new Date(2026, 9, 30, 10); // 30 October 2026

describe('report periods', () => {
    it('presets land on calendar bounds, end exclusive', () => {
        expect(presetRange('this_month', NOW)).toEqual({ from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) });
        expect(presetRange('last_month', NOW)).toEqual({ from: new Date(2026, 8, 1), to: new Date(2026, 9, 1) });
        expect(presetRange('this_quarter', NOW)).toEqual({ from: new Date(2026, 9, 1), to: new Date(2027, 0, 1) });
        expect(presetRange('this_year', NOW)).toEqual({ from: new Date(2026, 0, 1), to: new Date(2027, 0, 1) });
        expect(presetRange('last_12', NOW)).toEqual({ from: new Date(2025, 10, 1), to: new Date(2026, 10, 1) });
        const ninety = presetRange('last_90', NOW);
        expect((ninety.to.getTime() - ninety.from.getTime()) / 86_400_000).toBe(90);
    });

    it('the previous period is the same length, ending where this one starts', () => {
        expect(previousRange({ from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) })).toEqual({
            from: new Date(2026, 8, 1),
            to: new Date(2026, 9, 1),
        });
    });

    it('lists the months a range touches, with the year only across a boundary', () => {
        expect(monthsIn({ from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) }).map((m) => m.key)).toEqual([
            '2026-10',
        ]);
        const across = monthsIn({ from: new Date(2025, 10, 1), to: new Date(2026, 1, 1) });
        expect(across.map((m) => m.key)).toEqual(['2025-11', '2025-12', '2026-01']);
        expect(across[0]!.label).toMatch(/Nov.*25/);
    });

    it('labels a range by its first and last day', () => {
        expect(rangeLabel({ from: new Date(2026, 5, 1), to: new Date(2026, 6, 1) })).toBe('Jun 1 – Jun 30, 2026');
    });
});
