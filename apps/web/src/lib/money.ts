import type { Money } from '@bylinecrm/shared';

/**
 * The one money formatter. `Money` is exact minor units plus an ISO 4217 code; how many minor
 * units make a major unit is the currency's business (JPY has none, BHD has three), and
 * `Intl.NumberFormat` already knows — so the fraction digits are read from it rather than
 * assumed to be two.
 */
const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
    let formatter = formatters.get(currency);
    if (!formatter) {
        formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
        formatters.set(currency, formatter);
    }
    return formatter;
}

/** The number of minor-unit digits the currency has: 2 for USD, 0 for JPY, 3 for BHD. */
export function minorDigits(currency: string): number {
    return formatterFor(currency).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Minor units → the major amount as a number, for input fields and sums the reader sees. */
export function toMajor(money: Money): number {
    return money.amountMinor / 10 ** minorDigits(money.currency);
}

/** A major amount typed by a person → minor units, rounded to the currency's precision. */
export function toMinor(major: number, currency: string): number {
    return Math.round(major * 10 ** minorDigits(currency));
}

/** "$12,000.00", "¥1,200", or an em dash for no amount. */
export function formatMoney(money: Money | null | undefined): string {
    if (!money) return '—';
    return formatterFor(money.currency).format(toMajor(money));
}

/** "$12k" for cards and lane totals; the full form stays in the tooltip. */
export function formatMoneyCompact(money: Money | null | undefined): string {
    if (!money) return '—';
    return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: money.currency,
        currencyDisplay: 'narrowSymbol',
        notation: 'compact',
        // Both bounds, so every ICU agrees: a currency's default minimum (2 for USD) would
        // otherwise turn "$12K" into "$12.0K" on some platforms.
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
    }).format(toMajor(money));
}

/** A board column's exact per-currency sums, as the API computed them: "$48K · €2K". */
export function formatSums(byCurrency: Readonly<Record<string, number>>): string {
    const entries = Object.entries(byCurrency).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return '—';
    return entries.map(([currency, amountMinor]) => formatMoneyCompact({ amountMinor, currency })).join(' · ');
}

/** A typed amount ("12,000.50") → `Money` in the currency's minor units, or `null` when it is not a number. */
export function parseMoneyInput(text: string, currency: string): Money | null {
    const cleaned = text.replace(/[^\d.-]/g, '');
    if (!cleaned) return null;
    const major = Number(cleaned);
    if (!Number.isFinite(major) || major < 0) return null;
    return { amountMinor: toMinor(major, currency), currency };
}
