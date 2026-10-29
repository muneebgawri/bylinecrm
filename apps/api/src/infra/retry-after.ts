/**
 * When a server says to come back — one reading of it for every client that asks Google (#183, PNW-1125): Postmaster
 * Tools answers a 429 with a `Retry-After` header; Gmail can answer a per-user rate limit with the time in its message.
 */

/**
 * A `Retry-After` header as the seconds to wait (#183): a number of seconds, or an HTTP date (how far it is from `now`,
 * never less than zero). Anything else, or no header, is no advice.
 */
export function retryAfterSecondsOf(header: string | null, now: Date): number | null {
    if (header === null) return null;
    const value = header.trim();
    // A delta in seconds, or an HTTP date; a negative delta (or a bare number parsed as a year) is neither.
    if (/^-?\d+$/.test(value)) return value.startsWith('-') ? null : Number(value);
    const at = Date.parse(value);
    if (Number.isNaN(at)) return null;
    return Math.max(0, Math.round((at - now.getTime()) / 1000));
}

/**
 * The time in a Google error message's "Retry after <ISO 8601 time>" (Gmail's per-user rate limit says it this way,
 * e.g. "User-rate limit exceeded.  Retry after 2026-10-29T18:12:00.000Z"). Null when it names no time.
 */
export function retryAfterOfGoogleMessage(message: string | null): Date | null {
    const match = message?.match(/retry after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i);
    if (!match) return null;
    const at = Date.parse(match[1]!);
    return Number.isNaN(at) ? null : new Date(at);
}
