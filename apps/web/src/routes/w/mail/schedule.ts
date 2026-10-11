import { MAIL_SEND_HORIZON_DAYS, MAIL_SEND_MIN_LEAD_SECONDS } from '@bylinecrm/shared';

/**
 * Send-later times (P2-5, doc 50 §A). The picker works in the sender's own zone — the browser's —
 * and the API stores the instant; the recipient's zone is not known yet (Phase 3 infers it), so it
 * is said to be unknown, never guessed. The lead and horizon are the API's own numbers.
 */

/** What the picker says about the other end until the API knows it (`recipientTimeZone: null`). */
export const RECIPIENT_ZONE_UNKNOWN = 'Recipient’s zone unknown';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The sender's IANA zone, as the browser knows it ("Europe/London"). */
export function senderTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A `datetime-local` value ("2026-10-12T09:00"), read in the browser's zone; null when unreadable. */
export function fromLocalInput(value: string): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** The `datetime-local` value for an instant, in the browser's zone (minutes, no seconds). */
export function toLocalInput(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
        date.getMinutes(),
    )}`;
}

/** The earliest and latest a send may be scheduled for, from now. */
export function scheduleWindow(now: number): { earliest: Date; latest: Date } {
    return {
        earliest: new Date(now + MAIL_SEND_MIN_LEAD_SECONDS * 1000),
        latest: new Date(now + MAIL_SEND_HORIZON_DAYS * DAY_MS),
    };
}

/** Why a time cannot be used, in words; null when it can. The API checks the same again. */
export function scheduleProblem(at: Date | null, now: number): string | null {
    if (!at) return 'Pick a date and time.';
    const { earliest, latest } = scheduleWindow(now);
    if (at.getTime() < earliest.getTime()) {
        const minutes = Math.ceil(MAIL_SEND_MIN_LEAD_SECONDS / 60);
        return `Pick a time at least ${minutes} minute${minutes === 1 ? '' : 's'} from now.`;
    }
    if (at.getTime() > latest.getTime()) return `Pick a time within ${MAIL_SEND_HORIZON_DAYS} days.`;
    return null;
}

/** A suggestion to start from: the next whole hour that is far enough ahead. */
export function suggestedSendAt(now: number): Date {
    const next = new Date(now + MAIL_SEND_MIN_LEAD_SECONDS * 1000);
    next.setMinutes(60, 0, 0);
    return next;
}

/** "Mon 12 Oct, 09:00 (Europe/London)": when a scheduled send goes, in the zone it was scheduled in. */
export function formatSendAt(iso: string, timeZone: string | null): string {
    const zone = timeZone ?? senderTimeZone();
    const text = new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: zone,
    }).format(new Date(iso));
    return `${text} (${zone})`;
}
