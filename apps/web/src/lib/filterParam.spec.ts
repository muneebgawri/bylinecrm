import type { FilterGroup } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { chipConditions, decodeFilter, encodeFilter, withCondition, withoutCondition } from './filterParam';

describe('filterParam', () => {
    it('round-trips a filter through base64url, non-ASCII included', () => {
        const filter: FilterGroup = { and: [{ field: 'name', op: 'contains', value: 'Café ünd PR' }] };
        const encoded = encodeFilter(filter);
        expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeFilter(encoded)).toEqual(filter);
    });

    it('decodes the same form the API decodes (Node base64url of the JSON)', () => {
        const filter: FilterGroup = { and: [{ field: 'amount', op: 'gte', value: 1_000_000 }] };
        const fromApiSide = Buffer.from(JSON.stringify(filter)).toString('base64url');
        expect(decodeFilter(fromApiSide)).toEqual(filter);
        expect(encodeFilter(filter)).toBe(fromApiSide);
    });

    it('treats garbage and non-groups as no filter', () => {
        expect(decodeFilter('%%%')).toBeNull();
        expect(decodeFilter(encodeFilterless([1, 2]))).toBeNull();
        expect(decodeFilter(undefined)).toBeNull();
    });

    it('adds and removes chips on a top-level and; an or-filter is one "advanced" chip', () => {
        const one = withCondition(null, { field: 'name', op: 'contains', value: 'PR' });
        const two = withCondition(one, { field: 'closeDate', op: 'is_null' });
        expect(chipConditions(two)).toHaveLength(2);
        expect(withoutCondition(two, 0)).toEqual({ and: [{ field: 'closeDate', op: 'is_null' }] });
        expect(withoutCondition(one, 0)).toBeNull();
        expect(chipConditions({ or: [{ field: 'name', op: 'eq', value: 'x' }] })).toBe('advanced');
    });
});

function encodeFilterless(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}
