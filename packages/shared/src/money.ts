import type { Money } from './records.js';

/**
 * Money as a reader sees it. `Money` is exact minor units plus an ISO 4217 code; how many minor
 * units make a major unit is the currency's business (JPY has none, BHD has three), and
 * `Intl.NumberFormat` already knows — so the fraction digits are read from it rather than assumed
 * to be two. The locale is an argument: the web app passes the reader's, a rendered email passes
 * `TEMPLATE_RENDER_LOCALE`, so the same amount never formats two ways for the same locale.
 */
const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string, locale: string | undefined): Intl.NumberFormat {
    const key = `${locale ?? ''}|${currency}`;
    let formatter = formatters.get(key);
    if (!formatter) {
        formatter = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
        formatters.set(key, formatter);
    }
    return formatter;
}

/** The number of minor-unit digits the currency has: 2 for USD, 0 for JPY, 3 for BHD. */
export function minorDigits(currency: string): number {
    return formatterFor(currency, undefined).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Minor units → the major amount as a number. */
export function toMajor(money: Money): number {
    return money.amountMinor / 10 ** minorDigits(money.currency);
}

/** "$12,000.00", "¥1,200" — in `locale`, or the runtime's default when it is undefined. */
export function formatMoneyIn(money: Money, locale: string | undefined): string {
    return formatterFor(money.currency, locale).format(toMajor(money));
}
