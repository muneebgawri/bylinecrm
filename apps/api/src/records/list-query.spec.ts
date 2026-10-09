import { BadRequestException } from '@nestjs/common';
import { LIST_COUNT_CAP } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { countTotal, decodeCursor, encodeCursor, paginate } from './list-query';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

describe('cursors', () => {
    it('round-trip an id and are opaque', () => {
        const cursor = encodeCursor(ID_A);
        expect(cursor).not.toContain(ID_A);
        expect(decodeCursor(cursor)).toBe(ID_A);
    });

    it('refuse anything that is not an encoded id', () => {
        expect(() => decodeCursor('not-a-cursor')).toThrow(BadRequestException);
        expect(() => decodeCursor(Buffer.from('hello').toString('base64url'))).toThrow(BadRequestException);
    });
});

describe('paginate', () => {
    const rows = [{ id: ID_A }, { id: ID_B }, { id: ID_C }];

    it('asks for one row more than the page and reports a next cursor when it came back', async () => {
        let asked: { take: number; cursor?: { id: string }; skip?: number } | undefined;
        const page = await paginate(2, undefined, async (args) => {
            asked = args;
            return rows.slice(0, args.take);
        });
        expect(asked).toEqual({ take: 3 });
        expect(page.items.map((r) => r.id)).toEqual([ID_A, ID_B]);
        expect(page.nextCursor).toBe(encodeCursor(ID_B));
    });

    it('continues after the cursor row and ends with a null cursor on the last page', async () => {
        let asked: { take: number; cursor?: { id: string }; skip?: number } | undefined;
        const page = await paginate(2, encodeCursor(ID_B), async (args) => {
            asked = args;
            return [rows[2]!];
        });
        expect(asked).toEqual({ take: 3, cursor: { id: ID_B }, skip: 1 });
        expect(page.items.map((r) => r.id)).toEqual([ID_C]);
        expect(page.nextCursor).toBeNull();
    });
});

describe('countTotal (P1-4a)', () => {
    it('counts at most one row past the cap, and an answer within it is exact', async () => {
        const asked: number[] = [];
        const totals = await countTotal((take) => {
            asked.push(take);
            return Promise.resolve(37);
        }, false);
        expect(asked).toEqual([LIST_COUNT_CAP + 1]);
        expect(totals).toEqual({ total: 37, totalIsExact: true });
    });

    it('past the cap the total is the cap and says it is not exact', async () => {
        expect(await countTotal(() => Promise.resolve(LIST_COUNT_CAP + 1), false)).toEqual({
            total: LIST_COUNT_CAP,
            totalIsExact: false,
        });
        expect(await countTotal(() => Promise.resolve(LIST_COUNT_CAP), false)).toEqual({
            total: LIST_COUNT_CAP,
            totalIsExact: true,
        });
    });

    it('a text search whose candidates were capped cannot give an exact total', async () => {
        expect(await countTotal(() => Promise.resolve(12), true)).toEqual({ total: 12, totalIsExact: false });
    });
});
