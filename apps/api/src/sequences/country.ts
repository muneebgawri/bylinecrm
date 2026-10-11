/**
 * A recipient's country, as far as it can be known (FR-CRMS-11, FR-CRMS-12): the person's own, then
 * their company's address, then their address's country-code TLD. ISO 3166-1 alpha-2, upper case.
 * Names and codes are checked against the runtime's CLDR region data (`Intl.DisplayNames`), so no
 * country list is kept here to drift.
 */

const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/** CLDR region codes that are not countries. */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'ZZ', 'QO', 'XA', 'XB']);

/** Names people write that CLDR's English names do not match. */
const ALIASES: Readonly<Record<string, string>> = {
    usa: 'US',
    'united states of america': 'US',
    uk: 'GB',
    'great britain': 'GB',
    britain: 'GB',
    england: 'GB',
    scotland: 'GB',
    wales: 'GB',
    'northern ireland': 'GB',
    holland: 'NL',
    'the netherlands': 'NL',
    'south korea': 'KR',
    'korea, republic of': 'KR',
    'czech republic': 'CZ',
    uae: 'AE',
};

/** The canonical form of a region code (`UK` → `GB`, `FX` → `FR`): UTS #35 alias canonicalisation. */
function canonicalRegion(code: string): string | undefined {
    try {
        return Intl.getCanonicalLocales(`und-${code}`)[0]?.split('-')[1];
    } catch {
        return undefined;
    }
}

/** True for a current ISO alpha-2 code that names a country (an alias such as `UK` is not one). */
export function isCountryCode(code: string): boolean {
    return (
        /^[A-Z]{2}$/.test(code) &&
        !NOT_COUNTRIES.has(code) &&
        canonicalRegion(code) === code &&
        regionNames.of(code) !== undefined
    );
}

let byName: Map<string, string> | undefined;
function namesToCodes(): Map<string, string> {
    if (byName) return byName;
    byName = new Map(Object.entries(ALIASES));
    const A = 'A'.charCodeAt(0);
    for (let i = 0; i < 26; i += 1) {
        for (let j = 0; j < 26; j += 1) {
            const code = String.fromCharCode(A + i, A + j);
            if (!isCountryCode(code)) continue;
            byName.set(regionNames.of(code)!.toLowerCase(), code);
        }
    }
    return byName;
}

/** An ISO code or an English country name, case-insensitive; null when it names no country. */
export function countryFromName(value: string | null | undefined): string | null {
    const text = value?.trim();
    if (!text) return null;
    if (/^[A-Za-z]{2}$/.test(text)) {
        const code = text.toUpperCase();
        return isCountryCode(code) ? code : (namesToCodes().get(text.toLowerCase()) ?? null);
    }
    return namesToCodes().get(text.toLowerCase()) ?? null;
}

/** The country an address's TLD names (`.uk` is GB), or null for a generic TLD. */
export function countryFromTld(address: string): string | null {
    const at = address.lastIndexOf('@');
    const tld = address.slice(address.lastIndexOf('.') + 1).toLowerCase();
    if (at < 0 || tld.length !== 2) return null;
    const code = tld === 'uk' ? 'GB' : tld.toUpperCase();
    return isCountryCode(code) ? code : null;
}

export interface InferredCountry {
    country: string | null;
    from: 'person' | 'company' | 'email' | null;
}

export function inferCountry(input: {
    personCountry: string | null;
    companyCountry: string | null;
    email: string | null;
}): InferredCountry {
    if (input.personCountry) return { country: input.personCountry, from: 'person' };
    const company = countryFromName(input.companyCountry);
    if (company) return { country: company, from: 'company' };
    const tld = input.email ? countryFromTld(input.email) : null;
    if (tld) return { country: tld, from: 'email' };
    return { country: null, from: null };
}
