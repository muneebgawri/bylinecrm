import { describe, expect, it } from 'vitest';
import { backfillCliArgs } from '../cli/backfill-mail-history';
import {
    addProgress,
    concernsPerson,
    emptyProgress,
    nextWindow,
    parseFloor,
    progressOf,
    storedBytesOf,
    windowQuery,
} from './history-backfill';
import { MAIL_BACKFILL_ROW_OVERHEAD_BYTES } from './mail-sync.constants';

describe('mail history backfill: the walk', () => {
    const floor = new Date('2023-04-01T00:00:00Z');

    it('walks back a calendar month at a time, newest first, and stops exactly at the floor', () => {
        const windows: { after: string; before: string }[] = [];
        let before: Date = new Date('2023-07-15T10:00:00Z');
        for (let w = nextWindow(before, floor); w; w = nextWindow(before, floor)) {
            windows.push({ after: w.after.toISOString(), before: w.before.toISOString() });
            before = w.after; // the cursor a finished window leaves
        }
        expect(windows).toEqual([
            { after: '2023-06-15T10:00:00.000Z', before: '2023-07-15T10:00:00.000Z' },
            { after: '2023-05-15T10:00:00.000Z', before: '2023-06-15T10:00:00.000Z' },
            { after: '2023-04-15T10:00:00.000Z', before: '2023-05-15T10:00:00.000Z' },
            { after: '2023-04-01T00:00:00.000Z', before: '2023-04-15T10:00:00.000Z' },
        ]);
    });

    it('resumes from a stored cursor, and has nothing left at or below the floor', () => {
        expect(nextWindow(new Date('2023-05-01T00:00:00Z'), floor)).toEqual({
            after: new Date('2023-04-01T00:00:00Z'),
            before: new Date('2023-05-01T00:00:00Z'),
        });
        expect(nextWindow(floor, floor)).toBeNull();
        expect(nextWindow(new Date('2022-01-01T00:00:00Z'), floor)).toBeNull();
    });

    it('asks Gmail for a window in epoch seconds, the end rounded up so nothing at its edge is missed', () => {
        expect(windowQuery({ after: new Date(1_680_307_200_000), before: new Date(1_682_899_200_500) })).toBe(
            'after:1680307200 before:1682899201',
        );
    });
});

describe('mail history backfill: what is worth storing', () => {
    const people = new Map([
        ['dana@acme.example', 'p1'],
        ['ann@crm.example', 'p2'],
    ]);
    const members = new Map([['ann@crm.example', 'm1']]);

    it('a message with a person of the workspace in it, in any role', () => {
        expect(concernsPerson(['me@crm.example', 'dana@acme.example'], 'me@crm.example', people, members)).toBe(true);
    });

    it('not one with strangers only, or members only (a member who is also a person counts as a member)', () => {
        expect(concernsPerson(['me@crm.example', 'cold@pitch.example'], 'me@crm.example', people, members)).toBe(false);
        expect(concernsPerson(['me@crm.example', 'ann@crm.example'], 'me@crm.example', people, members)).toBe(false);
    });

    it('never because of the mailbox itself', () => {
        const self = new Map([['me@crm.example', 'p9']]);
        expect(concernsPerson(['me@crm.example'], 'ME@crm.example', self, new Map())).toBe(false);
    });

    it('counts a stored message as its text, uncompressed, plus the rows around it', () => {
        expect(storedBytesOf({ bodyText: 'héllo', bodyHtml: null, subject: 'ab', snippet: 'c' })).toBe(
            6 + 2 + 1 + MAIL_BACKFILL_ROW_OVERHEAD_BYTES,
        );
        expect(storedBytesOf({ bodyText: '', bodyHtml: '<p>x</p>', subject: '', snippet: '' })).toBe(
            8 + MAIL_BACKFILL_ROW_OVERHEAD_BYTES,
        );
    });
});

describe('mail history backfill: progress and floor', () => {
    it('adds progress and reads a stored record back, anything missing as zero', () => {
        const a = addProgress(emptyProgress(), { imported: 2, listed: 5 });
        expect(addProgress(a, { imported: 1, windows: 1 })).toMatchObject({ imported: 3, listed: 5, windows: 1 });
        expect(progressOf({ imported: 4, listed: 'x' })).toEqual({ ...emptyProgress(), imported: 4 });
        expect(progressOf(null)).toEqual(emptyProgress());
    });

    it('takes a floor as a past YYYY-MM-DD, UTC midnight', () => {
        expect(parseFloor('2023-04-01').toISOString()).toBe('2023-04-01T00:00:00.000Z');
        expect(() => parseFloor('2023-02-30')).toThrow();
        expect(() => parseFloor('April 2023')).toThrow();
        expect(() => parseFloor('2999-01-01')).toThrow();
    });
});

describe('backfill-mail-history CLI arguments', () => {
    it('reads the slug, the mode and the options', () => {
        expect(
            backfillCliArgs([
                'pinion',
                '--estimate',
                '--since',
                '2023-04-01',
                '--mailbox',
                'Matt@X.com',
                '--sample',
                '50',
            ]),
        ).toEqual({
            slug: 'pinion',
            mode: 'estimate',
            since: '2023-04-01',
            mailbox: 'matt@x.com',
            sample: 50,
            concurrency: 4,
        });
        expect(backfillCliArgs(['pinion', '--apply', '--concurrency', '8'])).toMatchObject({
            mode: 'apply',
            since: '2023-04-01',
            mailbox: null,
            sample: null,
            concurrency: 8,
        });
    });

    it('refuses a call without exactly one mode and one slug, or with a bad option', () => {
        expect(backfillCliArgs(['pinion'])).toBeNull();
        expect(backfillCliArgs(['pinion', '--estimate', '--apply'])).toBeNull();
        expect(backfillCliArgs(['--apply'])).toBeNull();
        expect(backfillCliArgs(['pinion', '--apply', '--sample', '0'])).toBeNull();
        expect(backfillCliArgs(['pinion', '--apply', '--since'])).toBeNull();
        expect(backfillCliArgs(['pinion', '--apply', '--force', 'x'])).toBeNull();
    });
});
