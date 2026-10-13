import { minorDigits, type Link, type Phone, normaliseEmail } from '@bylinecrm/shared';

/**
 * How Twenty spells the composite values its records carry (PAR-001/005/007, as the instance
 * reports them), read into BylineCRM's own shapes. Every reader here is lenient: a missing or
 * malformed value is "no answer" (`null`), never a throw — a record with one odd field still
 * imports, and the odd field is reported as what it is.
 */

/** A non-empty, trimmed string, or null. Twenty uses `""` for "no value". */
export function text(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

export function num(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return null;
}

export function bool(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** An ISO 8601 instant, as given, or null. */
export function isoDateTime(value: unknown): string | null {
    const s = text(value);
    return s && ISO_DATE_TIME.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

/** A calendar date: `YYYY-MM-DD` as given, or the date part of an instant. */
export function isoDate(value: unknown): string | null {
    const s = text(value);
    if (!s) return null;
    if (ISO_DATE.test(s)) return s;
    return isoDateTime(s) ? s.slice(0, 10) : null;
}

/** An email address, lower-cased, when it has the shape of one. */
export function emailOf(value: unknown): string | null {
    const s = text(value);
    return s ? normaliseEmail(s) : null;
}

/** A URL with a scheme (`https://` added when the value is a bare host or path), or null. */
export function urlOf(value: unknown): string | null {
    const s = text(value);
    if (!s) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    try {
        const url = new URL(withScheme);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
        return null;
    }
}

/** The host of a URL or bare domain, lower-cased, without `www.`, or null. */
export function domainOf(value: unknown): string | null {
    const url = urlOf(value);
    if (!url) return null;
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host.includes('.') ? host : null;
}

/** Twenty's links composite: `{ primaryLinkUrl, primaryLinkLabel, secondaryLinks }`. */
export function linkOf(value: unknown): Link | null {
    if (!isObject(value)) return null;
    const url = urlOf(value.primaryLinkUrl);
    return url ? { url, label: text(value.primaryLinkLabel) } : null;
}

/** Twenty's currency composite `{ amountMicros, currencyCode }` as minor units of its currency. */
export function moneyOf(value: unknown, fallbackCurrency: string): { amountMinor: number; currency: string } | null {
    if (!isObject(value)) return null;
    const micros = num(value.amountMicros);
    if (micros === null) return null;
    const currency = currencyOf(value.currencyCode) ?? fallbackCurrency;
    return { amountMinor: Math.round(micros / 10 ** (6 - minorDigits(currency))), currency };
}

/** The same composite as a major amount (for a custom number field) and its currency. */
export function majorOf(value: unknown): { amount: number | null; currency: string | null } {
    if (!isObject(value)) return { amount: null, currency: null };
    const micros = num(value.amountMicros);
    return { amount: micros === null ? null : micros / 1_000_000, currency: currencyOf(value.currencyCode) };
}

export function currencyOf(value: unknown): string | null {
    const s = text(value)?.toUpperCase() ?? null;
    return s && /^[A-Z]{3}$/.test(s) ? s : null;
}

/** Twenty's address composite, as BylineCRM's. */
export function addressOf(value: unknown): {
    street: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    postalCode: string | null;
} | null {
    if (!isObject(value)) return null;
    const street =
        [text(value.addressStreet1), text(value.addressStreet2)].filter((s) => s !== null).join(', ') || null;
    const address = {
        street,
        city: text(value.addressCity),
        state: text(value.addressState),
        country: text(value.addressCountry),
        postalCode: text(value.addressPostcode),
    };
    return Object.values(address).every((v) => v === null) ? null : address;
}

/** ISO 3166-1 alpha-2 by the calling codes seen in a CRM's contacts, for a phone whose country Twenty left blank. */
const COUNTRY_BY_CALLING_CODE: Readonly<Record<string, string>> = {
    '+1': 'US',
    '+7': 'RU',
    '+27': 'ZA',
    '+31': 'NL',
    '+32': 'BE',
    '+33': 'FR',
    '+34': 'ES',
    '+39': 'IT',
    '+41': 'CH',
    '+43': 'AT',
    '+44': 'GB',
    '+45': 'DK',
    '+46': 'SE',
    '+47': 'NO',
    '+48': 'PL',
    '+49': 'DE',
    '+52': 'MX',
    '+55': 'BR',
    '+61': 'AU',
    '+64': 'NZ',
    '+65': 'SG',
    '+81': 'JP',
    '+82': 'KR',
    '+86': 'CN',
    '+90': 'TR',
    '+91': 'IN',
    '+351': 'PT',
    '+353': 'IE',
    '+358': 'FI',
    '+971': 'AE',
    '+972': 'IL',
};

/** A phone with a country: the code Twenty gives, else the one its calling code implies; without either, no phone. */
export function phoneOf(number: unknown, countryCode: unknown, callingCode: unknown): Phone | null {
    const digits = text(number);
    if (!digits) return null;
    const given = text(countryCode)?.toUpperCase() ?? null;
    const country =
        given && /^[A-Z]{2}$/.test(given) ? given : (COUNTRY_BY_CALLING_CODE[text(callingCode) ?? ''] ?? null);
    return country ? { number: digits, countryCode: country } : null;
}

/** Twenty's phones composite: a primary and any number of others, those with a country. */
export function phonesOf(value: unknown): { primary: Phone | null; additional: Phone[] } {
    if (!isObject(value)) return { primary: null, additional: [] };
    const primary = phoneOf(value.primaryPhoneNumber, value.primaryPhoneCountryCode, value.primaryPhoneCallingCode);
    const additional = (Array.isArray(value.additionalPhones) ? value.additionalPhones : [])
        .map((p: unknown) => (isObject(p) ? phoneOf(p.number, p.countryCode, p.callingCode) : null))
        .filter((p): p is Phone => p !== null);
    return { primary, additional };
}

/** Twenty's emails composite: a lower-cased primary and the others that are addresses. */
export function emailsOf(value: unknown): { primary: string | null; additional: string[] } {
    if (!isObject(value)) return { primary: null, additional: [] };
    const additional = (Array.isArray(value.additionalEmails) ? value.additionalEmails : [])
        .map(emailOf)
        .filter((e): e is string => e !== null);
    return { primary: emailOf(value.primaryEmail), additional };
}

/** Twenty's full-name composite. */
export function nameOf(value: unknown): { first: string; last: string } {
    if (!isObject(value)) return { first: '', last: '' };
    return { first: text(value.firstName) ?? '', last: text(value.lastName) ?? '' };
}

/** A single name string split at its last space: everything before is the first name. */
export function splitName(value: unknown): { first: string; last: string } {
    const full = text(value);
    if (!full) return { first: '', last: '' };
    const at = full.lastIndexOf(' ');
    return at === -1 ? { first: full, last: '' } : { first: full.slice(0, at).trim(), last: full.slice(at + 1).trim() };
}

/** `CLOSED_LOST` → `Closed lost`; `First Followup Done` stays as written. */
export function humanise(value: string): string {
    if (!isEnumLike(value)) return value;
    const words = value
        .toLowerCase()
        .split('_')
        .filter((w) => w !== '');
    return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

/** A value written the way Twenty writes its select options: `GOOGLE_ADS`, `NEW`. */
export function isEnumLike(value: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(value) && value.length > 1;
}

/** `prLink` → `pr_link`, `Weird-Key 1` → `weird_key_1`: a custom-field key (`CUSTOM_FIELD_KEY_PATTERN`). */
export function snakeKey(name: string): string {
    const key = name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .toLowerCase()
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    const legal = key.replace(/^[^a-z]+/, '');
    return legal.slice(0, 64) || 'field';
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A relation id as Twenty gives it (`companyId`), or null. */
export function idOf(value: unknown): string | null {
    return text(value);
}
