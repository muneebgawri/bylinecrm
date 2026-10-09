import { describe, expect, it } from 'vitest';
import { TEMPLATE_RENDER_LOCALE, formatMoneyCompactIn, formatMoneyIn } from '@bylinecrm/shared';
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
        expect(formatMoneyCompact({ amountMinor: 1200000, currency: 'USD' })).toBe('$12K');
        expect(formatMoneyCompact({ amountMinor: 1250000, currency: 'USD' })).toBe('$12.5K');
    });
});

/**
 * One money formatter in the whole product: the web's functions are the shared module's, so an
 * amount reads the same on a record page and in an email the API renders (which passes
 * `TEMPLATE_RENDER_LOCALE` to the same `formatMoneyIn`). These compare the two for the same
 * locale; any copy of a rule creeping back into the web would make them disagree.
 */
describe('money is formatted one way across web and API', () => {
    const cases: { amountMinor: number; currency: string }[] = [
        { amountMinor: 1200000, currency: 'USD' },
        { amountMinor: 1250, currency: 'USD' },
        { amountMinor: 1200, currency: 'JPY' },
        { amountMinor: 1234567, currency: 'BHD' },
        { amountMinor: 99, currency: 'EUR' },
    ];

    it('full form: web === the API render path in the reader locale', () => {
        for (const money of cases) expect(formatMoney(money)).toBe(formatMoneyIn(money, undefined));
    });

    it('full form in the template render locale has the currency precision', () => {
        expect(formatMoneyIn({ amountMinor: 1200000, currency: 'USD' }, TEMPLATE_RENDER_LOCALE)).toBe('$12,000.00');
        expect(formatMoneyIn({ amountMinor: 1200, currency: 'JPY' }, TEMPLATE_RENDER_LOCALE)).toBe('¥1,200');
    });

    it('compact form: web === shared, with fixed fraction bounds', () => {
        for (const money of cases) expect(formatMoneyCompact(money)).toBe(formatMoneyCompactIn(money, undefined));
        expect(formatMoneyCompactIn({ amountMinor: 1200000, currency: 'USD' }, 'en-US')).toBe('$12K');
    });
});
