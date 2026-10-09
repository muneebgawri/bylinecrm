import { formatMoneyCompactIn, formatMoneyIn, toMinor, type Money } from '@bylinecrm/shared';

/**
 * The web app's view of money. Every rule — how many minor units a currency has, how an amount is
 * written, the compact form — lives in `@bylinecrm/shared`'s money module, which the API's
 * rendered emails use too, so the product formats an amount one way. This module only adds what is
 * the web's own: the reader's locale (the runtime default), the em dash for "no amount", and
 * parsing what a person types.
 */
const READER_LOCALE = undefined;

export { minorDigits, toMajor, toMinor } from '@bylinecrm/shared';

/** "$12,000.00", "¥1,200", or an em dash for no amount. */
export function formatMoney(money: Money | null | undefined): string {
    return money ? formatMoneyIn(money, READER_LOCALE) : '—';
}

/** "$12K" for cards and lane totals; the full form stays in the tooltip. */
export function formatMoneyCompact(money: Money | null | undefined): string {
    return money ? formatMoneyCompactIn(money, READER_LOCALE) : '—';
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
