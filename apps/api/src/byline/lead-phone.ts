import type { Phone } from '@bylinecrm/shared';
import { phoneFrom } from '../bigin-import/mappers';

/** Calling codes several countries share: the lead's own country decides among them. */
const SHARED_CALLING_CODES: Readonly<Record<string, readonly string[]>> = {
    '1': ['US', 'CA', 'PR', 'JM', 'BS', 'BB', 'TT', 'DO'],
    '7': ['RU', 'KZ'],
    '44': ['GB', 'GG', 'JE', 'IM'],
};

/**
 * A lead's phone as the CRM keeps it (digits as dialled, with the country) — BylineAI sends E.164 when it could
 * parse it with `country`, else the number as it holds it (pinionpartners/bylineai#3):
 *
 * - E.164 (`+…`): split at its calling code; where several countries share it, the lead's country decides.
 * - Otherwise, with a country: the digits as dialled, a leading trunk `0` kept, in that country.
 * - Otherwise: null — the caller keeps the raw text on the lead rather than dropping it.
 */
export function leadPhone(raw: string | undefined, country: string | null): Phone | null {
    const text = raw?.trim();
    if (!text) return null;
    if (text.startsWith('+')) {
        const digits = text.replace(/[^\d]/g, '');
        if (country) {
            for (const [code, countries] of Object.entries(SHARED_CALLING_CODES)) {
                const number = digits.slice(code.length);
                if (digits.startsWith(code) && countries.includes(country) && /^[0-9]{3,15}$/.test(number)) {
                    return { number, countryCode: country };
                }
            }
        }
        const parsed = phoneFrom(text);
        return parsed && /^[0-9]{3,15}$/.test(parsed.number) ? parsed : null;
    }
    const digits = text.replace(/[^\d]/g, '');
    // Letters or an extension (`ext. 12`) make it something the CRM cannot dial as written: kept raw.
    if (!country || /[a-z]/i.test(text) || !/^[0-9]{3,15}$/.test(digits)) return null;
    return { number: digits, countryCode: country };
}
