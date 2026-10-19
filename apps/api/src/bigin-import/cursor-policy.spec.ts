import { describe, expect, it } from 'vitest';
import { advanceWindow, noteFailure, noteSuccess, settledCursor, startPass } from './cursor-policy';

const at = (iso: string) => new Date(iso);

describe('FR-CRMS-25 BIGIN-1 cursor policy', () => {
    it('advances past everything that succeeded: a finished pass to a second before it started', () => {
        const cursor = startPass('2026-10-01T00:00:00.000Z', null);
        noteSuccess(cursor, at('2026-10-02T00:00:00Z'));
        expect(
            settledCursor({
                previous: '2026-10-01T00:00:00.000Z',
                cursor,
                passStartedAt: at('2026-10-03T00:00:00Z'),
                complete: true,
            }),
        ).toBe('2026-10-02T23:59:59.000Z');
    });

    it('never past the oldest record that failed', () => {
        const cursor = startPass('2026-10-01T00:00:00.000Z', null);
        noteSuccess(cursor, at('2026-10-02T12:00:00Z'));
        noteFailure(cursor, at('2026-10-02T10:00:00Z'));
        noteFailure(cursor, at('2026-10-02T11:00:00Z'));
        noteSuccess(cursor, at('2026-10-02T13:00:00Z'));
        expect(
            settledCursor({
                previous: '2026-10-01T00:00:00.000Z',
                cursor,
                passStartedAt: at('2026-10-03T00:00:00Z'),
                complete: true,
            }),
        ).toBe('2026-10-02T09:59:59.000Z');
    });

    it('a record whose time does not parse pins the cursor where its window began', () => {
        const cursor = startPass('2026-10-01T00:00:00.000Z', null);
        noteFailure(cursor, null);
        expect(
            settledCursor({
                previous: '2026-10-01T00:00:00.000Z',
                cursor,
                passStartedAt: at('2026-10-03T00:00:00Z'),
                complete: true,
            }),
        ).toBe('2026-10-01T00:00:00.000Z');
    });

    it('an unfinished pass keeps its progress: up to its high-water mark, never backwards', () => {
        const cursor = startPass('2026-10-01T00:00:00.000Z', null);
        expect(
            settledCursor({
                previous: '2026-10-01T00:00:00.000Z',
                cursor,
                passStartedAt: at('2026-10-03T00:00:00Z'),
                complete: false,
            }),
        ).toBe('2026-10-01T00:00:00.000Z');
        noteSuccess(cursor, at('2026-10-02T06:00:00Z'));
        expect(
            settledCursor({
                previous: '2026-10-01T00:00:00.000Z',
                cursor,
                passStartedAt: at('2026-10-03T00:00:00Z'),
                complete: false,
            }),
        ).toBe('2026-10-02T05:59:59.000Z');
    });

    it('moves the window to a second before the page’s latest record, and the page only when the window cannot move', () => {
        const cursor = startPass(null, null);
        advanceWindow(cursor, { ids: ['1', '2'], latest: at('2026-10-02T00:00:05Z'), moreRecords: true });
        expect(cursor).toMatchObject({ since: '2026-10-02T00:00:04.000Z', page: 1, seen: ['1', '2'] });
        advanceWindow(cursor, { ids: ['3'], latest: at('2026-10-02T00:00:05Z'), moreRecords: true });
        expect(cursor).toMatchObject({ since: '2026-10-02T00:00:04.000Z', page: 2, seen: ['1', '2', '3'] });
        advanceWindow(cursor, { ids: [], latest: null, moreRecords: false });
        expect(cursor.done).toBe(true);
    });

    it('pages past 2,000 by v2’s token when a bulk edit leaves the window unable to move (production, 2026-10-19)', () => {
        const cursor = startPass('2026-10-02T00:00:04.000Z', null);
        const sameSecond = at('2026-10-02T00:00:05Z');
        for (let n = 1; n <= 12; n++) {
            advanceWindow(cursor, { ids: [String(n)], latest: sameSecond, moreRecords: true, nextPageToken: `t${n}` });
        }
        expect(cursor).toMatchObject({ since: '2026-10-02T00:00:04.000Z', page: 13, pageToken: 't12' });
        // Once the window can move, the token is dropped and paging starts again from the new window.
        advanceWindow(cursor, {
            ids: ['13'],
            latest: at('2026-10-02T00:01:00Z'),
            moreRecords: true,
            nextPageToken: 't13',
        });
        expect(cursor).toMatchObject({ since: '2026-10-02T00:00:59.000Z', page: 1, pageToken: null });
    });

    it('past v1’s 2,000 records of a window that cannot move, reads on by v2’s page tokens', () => {
        const cursor = startPass('2026-10-02T00:00:04.000Z', null);
        const sameSecond = at('2026-10-02T00:00:05Z');
        for (let n = 1; n <= 10; n++)
            advanceWindow(cursor, { ids: [String(n)], latest: sameSecond, moreRecords: true });
        expect(cursor).toMatchObject({ page: 11, byToken: true, pageToken: null });
        advanceWindow(cursor, { ids: ['11'], latest: sameSecond, moreRecords: true, nextPageToken: 't2' });
        expect(cursor).toMatchObject({ byToken: true, pageToken: 't2' });
        expect(() => advanceWindow(cursor, { ids: ['12'], latest: sameSecond, moreRecords: true })).toThrow(
            /no page token/,
        );
    });
});
