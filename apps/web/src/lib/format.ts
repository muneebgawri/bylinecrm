/**
 * Dates and times, formatted once for every screen. Values arrive as ISO strings; nothing here
 * takes a `Date`. The reader's locale and time zone decide the rendering.
 */

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "9 Oct 2026, 09:12" — or an em dash when there is nothing to show (never "0" or blank). */
export function formatDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    return dateTime.format(new Date(iso));
}

/** A calendar date (`YYYY-MM-DD` or an ISO instant) without a time: "31 Oct 2026". */
export function formatDay(iso: string | null | undefined): string {
    if (!iso) return '—';
    const value = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso;
    return dateOnly.format(new Date(value));
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 24 * 3600],
    ['month', 30 * 24 * 3600],
    ['week', 7 * 24 * 3600],
    ['day', 24 * 3600],
    ['hour', 3600],
    ['minute', 60],
];

/** "4 hours ago", "yesterday", "in 3 days"; under a minute reads "just now". */
export function formatRelative(iso: string, now: Date = new Date()): string {
    const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
    for (const [unit, size] of UNITS) {
        if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
    }
    return 'just now';
}

/** The timeline's line: relative for the last week, the full date beyond it. */
export function formatWhen(iso: string, now: Date = new Date()): string {
    const age = now.getTime() - new Date(iso).getTime();
    return age >= 0 && age < 7 * 24 * 3600 * 1000 ? formatRelative(iso, now) : formatDate(iso);
}

/** A byte count for a file list: "12.4 MB". */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i += 1;
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}
