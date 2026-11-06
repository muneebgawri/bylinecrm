import { MAIL_BACKFILL_ROW_OVERHEAD_BYTES, MAIL_BACKFILL_WINDOW_MONTHS } from './mail-sync.constants';
import type { ParsedMessage } from './parse-message';

/**
 * The rules of the mail history backfill (the walk itself is `MailSyncService.backfillStep`): which window comes
 * next, which message is worth storing, and what storing one costs. Pure, so they are tested without Gmail.
 */

/** Where a mailbox's backfill stands: `running` until the floor is reached (`done`) or the budget is (`budget_reached`). */
export type BackfillStatus = 'running' | 'done' | 'budget_reached';

/** One step's window: messages Gmail dated from `after` (inclusive) to `before` (exclusive). */
export interface BackfillWindow {
    after: Date;
    before: Date;
}

/** What a backfill has seen and done so far; kept on the mailbox's sync state and summed per run. */
export interface BackfillProgress {
    /** Messages Gmail listed in the windows walked. */
    listed: number;
    /** Already stored for this mailbox (the first import, an incremental run, an earlier step). */
    alreadyStored: number;
    /** Read as headers only and passed over: no participant is a person of the workspace. */
    unmatched: number;
    /** Drafts, spam, trash and chats. */
    skippedByLabel: number;
    /** Every outside participant blocklisted. */
    blocked: number;
    /** Listed, gone when read. */
    vanished: number;
    /** Stored by this backfill. */
    imported: number;
    /** Stored meanwhile by another run. */
    duplicates: number;
    /** Windows finished. */
    windows: number;
}

export function emptyProgress(): BackfillProgress {
    return {
        listed: 0,
        alreadyStored: 0,
        unmatched: 0,
        skippedByLabel: 0,
        blocked: 0,
        vanished: 0,
        imported: 0,
        duplicates: 0,
        windows: 0,
    };
}

export function addProgress(a: BackfillProgress, b: Partial<BackfillProgress>): BackfillProgress {
    const out = { ...a };
    for (const key of Object.keys(out) as (keyof BackfillProgress)[]) out[key] += b[key] ?? 0;
    return out;
}

/** A stored progress record (JSON) read back; anything missing counts as zero. */
export function progressOf(value: unknown): BackfillProgress {
    const out = emptyProgress();
    if (!value || typeof value !== 'object') return out;
    for (const key of Object.keys(out) as (keyof BackfillProgress)[]) {
        const n = (value as Record<string, unknown>)[key];
        if (typeof n === 'number' && Number.isFinite(n)) out[key] = n;
    }
    return out;
}

/**
 * The next window below `before`: back one calendar month (UTC), never below the floor. `null` once `before` is at or
 * under the floor — the walk is done.
 */
export function nextWindow(before: Date, floor: Date): BackfillWindow | null {
    if (before.getTime() <= floor.getTime()) return null;
    const back = new Date(before);
    back.setUTCMonth(back.getUTCMonth() - MAIL_BACKFILL_WINDOW_MONTHS);
    return { after: back.getTime() < floor.getTime() ? floor : back, before };
}

/** Gmail's search for a window, in epoch seconds (Gmail reads `after:`/`before:` numbers so). */
export function windowQuery(window: BackfillWindow): string {
    return `after:${Math.floor(window.after.getTime() / 1000)} before:${Math.ceil(window.before.getTime() / 1000)}`;
}

/**
 * Whether a message concerns one of the workspace's people: some participant other than the mailbox itself and the
 * workspace's members is a person. Mail among members only, or with strangers only, is not stored by a backfill.
 */
export function concernsPerson(
    addresses: readonly string[],
    mailboxEmail: string,
    people: ReadonlyMap<string, string>,
    members: ReadonlyMap<string, string>,
): boolean {
    const own = mailboxEmail.toLowerCase();
    return addresses.some((a) => a !== own && !members.has(a) && people.has(a));
}

/** What storing a message costs, as the budget counts it: its own text, uncompressed, plus the rows around it. */
export function storedBytesOf(parsed: Pick<ParsedMessage, 'bodyText' | 'bodyHtml' | 'subject' | 'snippet'>): number {
    return (
        Buffer.byteLength(parsed.bodyText) +
        Buffer.byteLength(parsed.bodyHtml ?? '') +
        Buffer.byteLength(parsed.subject) +
        Buffer.byteLength(parsed.snippet) +
        MAIL_BACKFILL_ROW_OVERHEAD_BYTES
    );
}

/** A floor given as `YYYY-MM-DD` (UTC midnight); throws on anything else, or a date in the future. */
export function parseFloor(value: string, now = new Date()): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`the history floor must be YYYY-MM-DD, not ${value}`);
    const floor = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(floor.getTime()) || floor.toISOString().slice(0, 10) !== value) {
        throw new Error(`${value} is not a date`);
    }
    if (floor.getTime() >= now.getTime()) throw new Error('the history floor must be in the past');
    return floor;
}
