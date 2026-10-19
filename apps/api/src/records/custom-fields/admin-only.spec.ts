import { describe, expect, it } from 'vitest';
import { withoutHidden } from './admin-only';

describe('withoutHidden (admin-only custom fields)', () => {
    const hidden = new Set(['biginrecordid']);
    const at = new Date('2026-10-20T00:00:00Z');

    it('takes the hidden keys out of every custom object, at any depth, and leaves the rest', () => {
        const record = { id: 'p1', createdAt: at, custom: { beat: 'fintech', biginrecordid: '42' } };
        expect(withoutHidden(record, hidden)).toEqual({ id: 'p1', createdAt: at, custom: { beat: 'fintech' } });
        expect(withoutHidden({ items: [record], nextCursor: null }, hidden)).toEqual({
            items: [{ id: 'p1', createdAt: at, custom: { beat: 'fintech' } }],
            nextCursor: null,
        });
        expect(withoutHidden({ columns: [{ deals: [record] }] }, hidden).columns[0]!.deals[0]!.custom).toEqual({
            beat: 'fintech',
        });
        expect(record.custom.biginrecordid).toBe('42');
    });
});
