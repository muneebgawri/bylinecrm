import { describe, expect, it } from 'vitest';
import { SEARCH_CANDIDATE_LIMIT } from '@bylinecrm/shared';
import { mergeRanked, prefixQuery, prefixUpperBound } from './search';

/** People search (#344): the definer function's ranked hits and the phone hits come back as one query ordered them. */
describe('mergeRanked', () => {
    const a = '0a000000-0000-4000-8000-000000000000';
    const b = '0b000000-0000-4000-8000-000000000000';
    const c = '0c000000-0000-4000-8000-000000000000';

    it('best rank first, then id; a phone hit is rank 0 and does not lower a ranked one', () => {
        expect(
            mergeRanked(
                [
                    { id: b, rank: 0.5 },
                    { id: c, rank: 0 },
                ],
                [a, b],
            ),
        ).toEqual([b, a, c]);
    });

    it('with no phone hits, the ranked order is kept', () => {
        expect(
            mergeRanked(
                [
                    { id: c, rank: 0.9 },
                    { id: a, rank: 0.1 },
                ],
                [],
            ),
        ).toEqual([c, a]);
    });

    it('never returns more than the candidate limit', () => {
        const ids = Array.from({ length: SEARCH_CANDIDATE_LIMIT + 5 }, (_, i) => `id-${String(i).padStart(5, '0')}`);
        expect(mergeRanked([], ids)).toHaveLength(SEARCH_CANDIDATE_LIMIT);
    });
});

describe('prefixUpperBound', () => {
    it("is the prefix with its last character's successor, so `~>=~ low AND ~<~ high` is exactly the prefix", () => {
        expect(prefixUpperBound('matt')).toBe('matu');
        expect(prefixUpperBound('')).toBe('');
        expect(prefixUpperBound('a.b@')).toBe('a.bA');
        expect(prefixUpperBound('zoë')).toBe('zoì');
        const high = prefixUpperBound('matt');
        for (const inside of ['matt', 'matt.smith@x.test', 'mattz'])
            expect(inside >= 'matt' && inside < high).toBe(true);
        for (const outside of ['matu', 'matu.a@x.test', 'mats'])
            expect(outside >= 'matt' && outside < high).toBe(false);
    });
});

describe('prefixQuery', () => {
    it('keeps only letters and digits, every word a required prefix', () => {
        expect(prefixQuery('Mat smi')).toBe('mat:* & smi:*');
        expect(prefixQuery('@@')).toBe('');
    });
});
