import type { Money } from '@bylinecrm/shared';

/**
 * The one money formatter. The API carries every amount as `Money` — integer minor units plus an
 * ISO 4217 currency (P1-1b, one representation) — and this is the only place the web app turns
 * that into text. `Intl` knows each currency's minor-unit scale, so nothing here hard-codes 100.
 */
export function formatMoney(money: Money | null | undefined, locale?: string): string {
    if (!money) return '—';
    const scale = 10 ** fractionDigits(currencyFormatter(money.currency, locale));
    // Whole amounts read as "$12,000"; minor units appear only when there are some.
    const whole = money.amountMinor % scale === 0;
    return currencyFormatter(money.currency, locale, whole).format(money.amountMinor / scale);
}

/** "$48,000 · €2,000" — a board column's exact per-currency sums, as the API computed them. */
export function formatSums(byCurrency: Readonly<Record<string, number>>, locale?: string): string {
    const entries = Object.entries(byCurrency).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return '—';
    return entries.map(([currency, amountMinor]) => formatMoney({ amountMinor, currency }, locale)).join(' · ');
}

/** Minor units from a person's typed amount ("12,000.50" → 1200050 for a two-decimal currency). */
export function parseMoneyInput(text: string, currency: string, locale?: string): Money | null {
    const cleaned = text.replace(/[^\d.-]/g, '');
    if (!cleaned) return null;
    const major = Number(cleaned);
    if (!Number.isFinite(major) || major < 0) return null;
    const digits = fractionDigits(currencyFormatter(currency, locale));
    return { amountMinor: Math.round(major * 10 ** digits), currency };
}

const formatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string, locale?: string, whole = false): Intl.NumberFormat {
    const key = `${locale ?? ''}/${currency}/${whole ? 'whole' : 'minor'}`;
    let formatter = formatters.get(key);
    if (!formatter) {
        formatter = new Intl.NumberFormat(locale, {
            style: 'currency',
            currency,
            ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
        });
        formatters.set(key, formatter);
    }
    return formatter;
}

function fractionDigits(formatter: Intl.NumberFormat): number {
    return formatter.resolvedOptions().maximumFractionDigits ?? 2;
}
