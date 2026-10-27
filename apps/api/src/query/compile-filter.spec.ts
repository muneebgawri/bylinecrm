import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { compileFilter } from './compile-filter';
import { resolveFields } from './fields';

const definitions = [
    { key: 'beat', label: 'Beat', type: 'select' as const, options: ['fintech', 'health'], required: false },
    { key: 'score', label: 'Score', type: 'number' as const, options: [], required: false },
    { key: 'tags', label: 'Tags', type: 'multiselect' as const, options: ['a', 'b'], required: false },
    { key: 'notes', label: 'Notes', type: 'text' as const, options: [], required: false },
];
const person = resolveFields('person', definitions);
const company = resolveFields('company', definitions);
const opportunity = resolveFields('opportunity', []);

describe('compileFilter: standard fields', () => {
    it('text operators are case-insensitive column filters', () => {
        expect(compileFilter({ and: [{ field: 'nameFirst', op: 'contains', value: 'an' }] }, person)).toEqual({
            AND: [{ nameFirst: { contains: 'an', mode: 'insensitive' } }],
        });
        expect(compileFilter({ or: [{ field: 'city', op: 'starts', value: 'Aus' }] }, person)).toEqual({
            OR: [{ city: { startsWith: 'Aus', mode: 'insensitive' } }],
        });
    });

    it('"not equal" and "not in" include rows with no value', () => {
        expect(compileFilter({ and: [{ field: 'jobTitle', op: 'neq', value: 'CEO' }] }, person)).toEqual({
            AND: [{ OR: [{ jobTitle: { not: 'CEO', mode: 'insensitive' } }, { jobTitle: null }] }],
        });
    });

    it('money compiles to the minor-units column as BigInt, between to a closed range', () => {
        expect(compileFilter({ and: [{ field: 'arr', op: 'gte', value: 100 }] }, company)).toEqual({
            AND: [{ arrMinor: { gte: 100n } }],
        });
        expect(compileFilter({ and: [{ field: 'amount', op: 'between', value: [10, 20] }] }, opportunity)).toEqual({
            AND: [{ amountMinor: { gte: 10n, lte: 20n } }],
        });
    });

    it('a phone filters at its path inside the phones composite', () => {
        expect(compileFilter({ and: [{ field: 'phonePrimary', op: 'contains', value: '888' }] }, person)).toEqual({
            AND: [{ phones: { path: ['primary', 'number'], string_contains: '888' } }],
        });
        expect(compileFilter({ and: [{ field: 'phoneExtension', op: 'not_null' }] }, person)).toEqual({
            AND: [{ phones: { path: ['primary', 'extension'], not: Prisma.AnyNull } }],
        });
    });

    it('dates become Date values; a datetime takes an offset', () => {
        const where = compileFilter({ and: [{ field: 'closeDate', op: 'lt', value: '2026-12-31' }] }, opportunity);
        expect(where).toEqual({ AND: [{ closeDate: { lt: new Date('2026-12-31') } }] });
        expect(() => compileFilter({ and: [{ field: 'createdAt', op: 'gt', value: '2026-01-01' }] }, person)).toThrow(
            /datetime/,
        );
    });

    it('null checks take no value; uuid fields take uuids', () => {
        expect(compileFilter({ and: [{ field: 'ownerId', op: 'is_null' }] }, person)).toEqual({
            AND: [{ ownerId: null }],
        });
        expect(compileFilter({ and: [{ field: 'ownerId', op: 'not_null' }] }, person)).toEqual({
            AND: [{ ownerId: { not: null } }],
        });
        expect(() => compileFilter({ and: [{ field: 'ownerId', op: 'eq', value: 'nope' }] }, person)).toThrow(/uuid/);
    });

    it('refuses an operator the kind does not take, and a value of the wrong type', () => {
        expect(() => compileFilter({ and: [{ field: 'icp', op: 'contains', value: 'x' }] }, company)).toThrow(
            /contains does not apply to icp/,
        );
        expect(() => compileFilter({ and: [{ field: 'employeeCount', op: 'eq', value: 'ten' }] }, company)).toThrow(
            /needs a number value/,
        );
        expect(() => compileFilter({ and: [{ field: 'name', op: 'between', value: ['a'] }] }, company)).toThrow(
            /does not apply/,
        );
    });

    it('refuses an unknown field, naming it', () => {
        expect(() => compileFilter({ and: [{ field: 'secret', op: 'eq', value: 1 }] }, person)).toThrow(
            /unknown field "secret"/,
        );
        expect(() => compileFilter({ and: [{ field: 'custom.gone', op: 'eq', value: 1 }] }, person)).toThrow(
            /custom field "gone" does not exist/,
        );
    });
});

describe('compileFilter: custom fields', () => {
    it('a select takes only its options, and compiles to a JSON path', () => {
        expect(compileFilter({ and: [{ field: 'custom.beat', op: 'eq', value: 'fintech' }] }, person)).toEqual({
            AND: [{ custom: { path: ['beat'], equals: 'fintech' } }],
        });
        expect(() => compileFilter({ and: [{ field: 'custom.beat', op: 'eq', value: 'sports' }] }, person)).toThrow(
            BadRequestException,
        );
    });

    it('in/nin on a select expand to or/not-or over equals', () => {
        expect(
            compileFilter({ and: [{ field: 'custom.beat', op: 'in', value: ['fintech', 'health'] }] }, person),
        ).toEqual({
            AND: [
                {
                    OR: [
                        { custom: { path: ['beat'], equals: 'fintech' } },
                        { custom: { path: ['beat'], equals: 'health' } },
                    ],
                },
            ],
        });
    });

    it('a multiselect "contains" means has the value; "in" means has any of them', () => {
        expect(compileFilter({ and: [{ field: 'custom.tags', op: 'contains', value: 'a' }] }, person)).toEqual({
            AND: [{ custom: { path: ['tags'], array_contains: ['a'] } }],
        });
        expect(compileFilter({ and: [{ field: 'custom.tags', op: 'in', value: ['a', 'b'] }] }, person)).toEqual({
            AND: [
                {
                    OR: [
                        { custom: { path: ['tags'], array_contains: ['a'] } },
                        { custom: { path: ['tags'], array_contains: ['b'] } },
                    ],
                },
            ],
        });
    });

    it('numbers compare on the path; null checks match an absent key and a JSON null alike', () => {
        expect(compileFilter({ and: [{ field: 'custom.score', op: 'gte', value: 5 }] }, person)).toEqual({
            AND: [{ custom: { path: ['score'], gte: 5 } }],
        });
        expect(compileFilter({ and: [{ field: 'custom.score', op: 'is_null' }] }, person)).toEqual({
            AND: [{ custom: { path: ['score'], equals: Prisma.AnyNull } }],
        });
        expect(compileFilter({ and: [{ field: 'custom.notes', op: 'starts', value: 'Met' }] }, person)).toEqual({
            AND: [{ custom: { path: ['notes'], string_starts_with: 'Met' } }],
        });
    });
});
