import { filterProblem, OPERATORS_BY_KIND, type FilterGroup } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import type { CustomFieldView } from '../api/types';
import {
    conditionCount,
    defaultOperator,
    draftProblem,
    emptyGroup,
    filterableFields,
    formatScalar,
    fromFilter,
    isComplete,
    parseScalar,
    toFilter,
    valueShape,
    type DraftCondition,
    type DraftGroup,
} from './filterModel';

function custom(partial: Partial<CustomFieldView> & Pick<CustomFieldView, 'key' | 'type'>): CustomFieldView {
    return {
        id: partial.key,
        object: 'person',
        label: partial.key,
        options: [],
        required: false,
        position: 0,
        archivedAt: null,
        createdAt: '2026-10-09T00:00:00.000Z',
        updatedAt: '2026-10-09T00:00:00.000Z',
        ...partial,
    };
}

const cond = (field: string, op: DraftCondition['op'], value?: unknown): DraftCondition => ({
    id: field,
    field,
    op,
    ...(value === undefined ? {} : { value }),
});
const group = (connective: 'and' | 'or', ...children: DraftGroup['children']): DraftGroup => ({
    id: connective,
    connective,
    children,
});

describe('filterableFields', () => {
    it('lists the standard fields, then live custom fields in position order with their kind and options', () => {
        const fields = filterableFields('person', [
            custom({ key: 'beat', type: 'select', options: ['Fintech', 'Health'], position: 2 }),
            custom({ key: 'region', type: 'text', position: 1 }),
            custom({ key: 'gone', type: 'text', archivedAt: '2026-10-01T00:00:00.000Z' }),
            custom({ key: 'other_object', type: 'text', object: 'company' }),
        ]);
        const names = fields.map((f) => f.name);
        expect(names[0]).toBe('nameFirst');
        expect(names.slice(-2)).toEqual(['custom.region', 'custom.beat']);
        expect(names).not.toContain('custom.gone');
        expect(names).not.toContain('custom.other_object');
        expect(fields.at(-1)).toMatchObject({ kind: 'select', options: ['Fintech', 'Health'], sortable: false });
    });
});

describe('operators and shapes', () => {
    it('starts every kind on an operator that kind takes', () => {
        for (const kind of Object.keys(OPERATORS_BY_KIND) as (keyof typeof OPERATORS_BY_KIND)[]) {
            expect(OPERATORS_BY_KIND[kind]).toContain(defaultOperator(kind));
        }
    });

    it('gives each operator the value shape the API checks', () => {
        expect(valueShape('is_null')).toBe('none');
        expect(valueShape('not_null')).toBe('none');
        expect(valueShape('in')).toBe('list');
        expect(valueShape('nin')).toBe('list');
        expect(valueShape('between')).toBe('pair');
        expect(valueShape('contains')).toBe('one');
    });
});

/**
 * Golden filters: one per field kind, as the API's P1-4 grammar takes them — a number for
 * number, integer minor units for money, a boolean, `YYYY-MM-DD` for a date, ISO with an offset
 * for an instant, an option for a select, a uuid for a reference; a list for in/nin, a pair for
 * between, no `value` key at all for the null checks.
 */
describe('toFilter — golden filters per kind', () => {
    const uuid = '0192f0c8-8a7e-7c00-8000-000000000001';
    const cases: [string, DraftCondition, FilterGroup][] = [
        [
            'text contains',
            cond('jobTitle', 'contains', 'Head'),
            { and: [{ field: 'jobTitle', op: 'contains', value: 'Head' }] },
        ],
        [
            'number between',
            cond('employeeCount', 'between', [10, 50]),
            { and: [{ field: 'employeeCount', op: 'between', value: [10, 50] }] },
        ],
        [
            'money gte (minor units)',
            cond('arr', 'gte', 1_200_000),
            { and: [{ field: 'arr', op: 'gte', value: 1_200_000 }] },
        ],
        ['boolean eq', cond('icp', 'eq', true), { and: [{ field: 'icp', op: 'eq', value: true }] }],
        [
            'date lt',
            cond('closeDate', 'lt', '2026-12-31'),
            { and: [{ field: 'closeDate', op: 'lt', value: '2026-12-31' }] },
        ],
        [
            'datetime gte',
            cond('createdAt', 'gte', '2026-10-01T09:00:00.000Z'),
            { and: [{ field: 'createdAt', op: 'gte', value: '2026-10-01T09:00:00.000Z' }] },
        ],
        [
            'select in',
            cond('custom.beat', 'in', ['Fintech']),
            { and: [{ field: 'custom.beat', op: 'in', value: ['Fintech'] }] },
        ],
        [
            'multiselect contains',
            cond('custom.tags', 'contains', 'vip'),
            { and: [{ field: 'custom.tags', op: 'contains', value: 'vip' }] },
        ],
        ['uuid eq', cond('ownerId', 'eq', uuid), { and: [{ field: 'ownerId', op: 'eq', value: uuid }] }],
        ['null check carries no value', cond('companyId', 'is_null'), { and: [{ field: 'companyId', op: 'is_null' }] }],
    ];

    it.each(cases)('%s', (_label, condition, expected) => {
        const filter = toFilter(group('and', condition));
        expect(filter).toEqual(expected);
        expect(filter && filterProblem(filter)).toBeNull();
        if (condition.op === 'is_null' && 'and' in expected)
            expect(Object.keys(expected.and[0] ?? {})).not.toContain('value');
    });
});

describe('toFilter — what is not sent', () => {
    it('drops incomplete conditions and the groups they leave empty; nothing left is no filter', () => {
        expect(toFilter(emptyGroup())).toBeNull();
        expect(toFilter(group('and', cond('jobTitle', 'contains', ''), group('or', cond('city', 'eq'))))).toBeNull();
        expect(toFilter(group('and', cond('jobTitle', 'between', [1])))).toBeNull();
    });

    it('keeps nested groups and their connectives', () => {
        const filter = toFilter(
            group(
                'and',
                cond('city', 'eq', 'Austin'),
                group('or', cond('jobTitle', 'starts', 'VP'), cond('jobTitle', 'starts', 'Head')),
            ),
        );
        expect(filter).toEqual({
            and: [
                { field: 'city', op: 'eq', value: 'Austin' },
                {
                    or: [
                        { field: 'jobTitle', op: 'starts', value: 'VP' },
                        { field: 'jobTitle', op: 'starts', value: 'Head' },
                    ],
                },
            ],
        });
        expect(conditionCount(filter)).toBe(3);
    });

    it('round-trips a saved filter through the tree unchanged', () => {
        const saved: FilterGroup = {
            or: [{ field: 'icp', op: 'eq', value: true }, { and: [{ field: 'arr', op: 'gt', value: 100 }] }],
        };
        expect(toFilter(fromFilter(saved))).toEqual(saved);
    });

    it('reports the depth limit before the API would', () => {
        let deepest: DraftGroup = group('and', cond('city', 'eq', 'x'));
        for (let i = 0; i < 5; i += 1) deepest = group('and', deepest);
        expect(draftProblem(deepest)).toMatch(/nest/);
    });

    it('treats a list or pair as complete only when every member is present', () => {
        expect(isComplete(cond('city', 'in', []))).toBe(false);
        expect(isComplete(cond('city', 'in', ['A', '']))).toBe(false);
        expect(isComplete(cond('employeeCount', 'between', [1, Number.NaN]))).toBe(false);
        expect(isComplete(cond('employeeCount', 'between', [1, 2]))).toBe(true);
    });
});

describe('parseScalar / formatScalar', () => {
    it('types what was typed, or says it is not a value yet', () => {
        expect(parseScalar('number', '12.5')).toBe(12.5);
        expect(parseScalar('number', 'twelve')).toBeUndefined();
        expect(parseScalar('date', '2026-10-09')).toBe('2026-10-09');
        expect(parseScalar('date', '10/09/2026')).toBeUndefined();
        expect(parseScalar('boolean', 'false')).toBe(false);
        expect(parseScalar('text', '  ')).toBeUndefined();
    });

    it('turns a local datetime input into an ISO instant and back', () => {
        const iso = parseScalar('datetime', '2026-10-09T09:30') as string;
        expect(iso).toMatch(/Z$/);
        expect(formatScalar('datetime', iso)).toBe('2026-10-09T09:30');
    });
});
