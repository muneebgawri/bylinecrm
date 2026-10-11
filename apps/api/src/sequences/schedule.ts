/**
 * When a step may run, in the recipient's local time (FR-CRMS-4, doc 50 §D): every time is stored in
 * UTC; the send window is the recipient's wall clock in their inferred zone. A step whose window has
 * passed for the day rolls to the next allowed day — it never sends outside the window to catch up.
 * Uses only `Intl` (the runtime's IANA data), so daylight-saving changes are the zone database's.
 */

export interface SendWindow {
    /** Minutes after local midnight, inclusive. */
    startMinute: number;
    /** Minutes after local midnight, exclusive; 1440 is midnight at the day's end. */
    endMinute: number;
    /** Monday-first bitmask: bit 0 Monday … bit 6 Sunday. */
    days: number;
}

/**
 * The zone a country's recipients are taken to be in. A multi-zone country maps to its most populous
 * zone — an inference, and the reason the window is generous. Unknown or unlisted: the fallback (the
 * sequence's own zone).
 */
const COUNTRY_ZONES: Readonly<Record<string, string>> = {
    US: 'America/New_York',
    CA: 'America/Toronto',
    MX: 'America/Mexico_City',
    BR: 'America/Sao_Paulo',
    AR: 'America/Argentina/Buenos_Aires',
    CL: 'America/Santiago',
    CO: 'America/Bogota',
    PE: 'America/Lima',
    GB: 'Europe/London',
    IE: 'Europe/Dublin',
    PT: 'Europe/Lisbon',
    ES: 'Europe/Madrid',
    FR: 'Europe/Paris',
    BE: 'Europe/Brussels',
    NL: 'Europe/Amsterdam',
    LU: 'Europe/Luxembourg',
    DE: 'Europe/Berlin',
    CH: 'Europe/Zurich',
    AT: 'Europe/Vienna',
    IT: 'Europe/Rome',
    MT: 'Europe/Malta',
    DK: 'Europe/Copenhagen',
    NO: 'Europe/Oslo',
    SE: 'Europe/Stockholm',
    FI: 'Europe/Helsinki',
    IS: 'Atlantic/Reykjavik',
    PL: 'Europe/Warsaw',
    CZ: 'Europe/Prague',
    SK: 'Europe/Bratislava',
    HU: 'Europe/Budapest',
    SI: 'Europe/Ljubljana',
    HR: 'Europe/Zagreb',
    RS: 'Europe/Belgrade',
    RO: 'Europe/Bucharest',
    BG: 'Europe/Sofia',
    GR: 'Europe/Athens',
    CY: 'Asia/Nicosia',
    EE: 'Europe/Tallinn',
    LV: 'Europe/Riga',
    LT: 'Europe/Vilnius',
    UA: 'Europe/Kyiv',
    TR: 'Europe/Istanbul',
    RU: 'Europe/Moscow',
    IL: 'Asia/Jerusalem',
    AE: 'Asia/Dubai',
    SA: 'Asia/Riyadh',
    QA: 'Asia/Qatar',
    EG: 'Africa/Cairo',
    NG: 'Africa/Lagos',
    KE: 'Africa/Nairobi',
    ZA: 'Africa/Johannesburg',
    MA: 'Africa/Casablanca',
    PK: 'Asia/Karachi',
    IN: 'Asia/Kolkata',
    BD: 'Asia/Dhaka',
    LK: 'Asia/Colombo',
    NP: 'Asia/Kathmandu',
    TH: 'Asia/Bangkok',
    VN: 'Asia/Ho_Chi_Minh',
    MY: 'Asia/Kuala_Lumpur',
    SG: 'Asia/Singapore',
    ID: 'Asia/Jakarta',
    PH: 'Asia/Manila',
    HK: 'Asia/Hong_Kong',
    CN: 'Asia/Shanghai',
    TW: 'Asia/Taipei',
    KR: 'Asia/Seoul',
    JP: 'Asia/Tokyo',
    AU: 'Australia/Sydney',
    NZ: 'Pacific/Auckland',
};

export function zoneForCountry(country: string | null, fallback: string): string {
    return (country && COUNTRY_ZONES[country]) || fallback;
}

/** True for an IANA zone the runtime knows. */
export function isTimeZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

interface LocalDate {
    year: number;
    month: number;
    day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
    let f = formatters.get(zone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        formatters.set(zone, f);
    }
    return f;
}

/** The wall clock in `zone` at `at`. */
function localParts(at: Date, zone: string): LocalDate & { minute: number; second: number } {
    const parts: Record<string, number> = {};
    for (const p of formatter(zone).formatToParts(at)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
    return {
        year: parts['year']!,
        month: parts['month']!,
        day: parts['day']!,
        minute: parts['hour']! * 60 + parts['minute']!,
        second: parts['second']!,
    };
}

/** The UTC instant of a wall-clock time in `zone` (a time a DST gap skips resolves forward). */
function zonedToUtc(date: LocalDate, minute: number, zone: string): Date {
    const naive = Date.UTC(date.year, date.month - 1, date.day, 0, minute);
    let guess = naive;
    for (let i = 0; i < 3; i += 1) {
        const p = localParts(new Date(guess), zone);
        const seen = Date.UTC(p.year, p.month - 1, p.day, 0, p.minute, p.second);
        const delta = naive - seen;
        if (delta === 0) break;
        guess += delta;
    }
    return new Date(guess);
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
    const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Monday = 0 … Sunday = 6. */
function weekdayOf(date: LocalDate): number {
    return (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
}

/** The earliest instant at or after `at` inside the window, in `zone`. */
export function nextWindowStart(at: Date, zone: string, window: SendWindow): Date {
    const today = localParts(at, zone);
    for (let k = 0; k < 8; k += 1) {
        const date = addLocalDays(today, k);
        if ((window.days & (1 << weekdayOf(date))) === 0) continue;
        const start = zonedToUtc(date, window.startMinute, zone);
        if (k > 0) return start;
        const end =
            window.endMinute >= 1440
                ? zonedToUtc(addLocalDays(date, 1), 0, zone)
                : zonedToUtc(date, window.endMinute, zone);
        if (at < start) return start;
        if (at < end) return at;
    }
    throw new Error('nextWindowStart: the window has no day');
}

/** `days` later at the same wall-clock time in `zone`; business days skip Saturday and Sunday. */
export function addWaitDays(at: Date, days: number, business: boolean, zone: string): Date {
    const local = localParts(at, zone);
    let date: LocalDate = local;
    if (!business) date = addLocalDays(local, days);
    else {
        let left = days;
        while (left > 0) {
            date = addLocalDays(date, 1);
            if (weekdayOf(date) < 5) left -= 1;
        }
    }
    return zonedToUtc(date, local.minute, zone);
}
