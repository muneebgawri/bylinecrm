import { describe, expect, it } from 'vitest';
import { formatMoney, formatMoneyCompact, minorDigits, toMajor, toMinor } from './money';

describe('money', () => {
    it('reads the minor digits from the currency, not from an assumption', () => {
        expect(minorDigits('USD')).toBe(2);
        expect(minorDigits('JPY')).toBe(0);
        expect(minorDigits('BHD')).toBe(3);
    });

    it('formats minor units as the reader expects for each currency', () => {
        expect(formatMoney({ amountMinor: 1200000, currency: 'USD' })).toMatch(/12,000\.00/);
        expect(formatMoney({ amountMinor: 1200, currency: 'JPY' })).toMatch(/1,200$/);
        expect(formatMoney(null)).toBe('—');
    });

    it('round-trips a typed amount through minor units', () => {
        expect(toMinor(12.5, 'USD')).toBe(1250);
        expect(toMajor({ amountMinor: 1250, currency: 'USD' })).toBe(12.5);
        expect(toMinor(0.1 + 0.2, 'USD')).toBe(30);
    });

    it('compacts large amounts for cards', () => {
        expect(formatMoneyCompact({ amountMinor: 1200000, currency: 'USD' })).toMatch(/12K/i);
    });
});
