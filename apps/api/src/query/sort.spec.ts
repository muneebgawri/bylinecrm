import { BadRequestException } from '@nestjs/common';
import { SORT_MAX_FIELDS } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { resolveFields } from './fields';
import { orderBy, parseSorts } from './sort';

const fields = resolveFields('company', [
    { key: 'beat', label: 'Beat', type: 'select', options: ['x'], required: false },
]);

describe('parseSorts', () => {
    it('reads one or several field:direction pairs', () => {
        expect(parseSorts('name:asc', fields)).toEqual([{ field: 'name', direction: 'asc' }]);
        expect(parseSorts('arr:desc,name:asc', fields)).toEqual([
            { field: 'arr', direction: 'desc' },
            { field: 'name', direction: 'asc' },
        ]);
    });

    it('refuses a malformed pair, an unknown field, an unsortable field, and too many fields', () => {
        expect(() => parseSorts('name', fields)).toThrow(BadRequestException);
        expect(() => parseSorts('name:up', fields)).toThrow(BadRequestException);
        expect(() => parseSorts('secret:asc', fields)).toThrow(/unknown field/);
        expect(() => parseSorts('icp:asc', fields)).toThrow(/not sortable/);
        expect(() => parseSorts('custom.beat:asc', fields)).toThrow(/custom fields cannot be sorted/);
        const tooMany = Array.from({ length: SORT_MAX_FIELDS + 1 }, () => 'name:asc').join(',');
        expect(() => parseSorts(tooMany, fields)).toThrow(/at most/);
    });
});

describe('orderBy', () => {
    it('maps API names to columns and ends with id as the tie-break', () => {
        expect(
            orderBy([{ field: 'arr', direction: 'desc' }], fields, { field: 'createdAt', direction: 'desc' }),
        ).toEqual([{ arrMinor: 'desc' }, { id: 'asc' }]);
    });

    it('uses the fallback when there are no sorts', () => {
        expect(orderBy([], fields, { field: 'updatedAt', direction: 'asc' })).toEqual([
            { updatedAt: 'asc' },
            { id: 'asc' },
        ]);
    });
});
