import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
    FILTER_MAX_DEPTH,
    FILTER_MAX_IDS,
    FILTER_MAX_LIST,
    FILTER_MAX_NODES,
    type FilterGroup,
    type FilterNode,
} from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { decodeFilterParam, parseFilter, planQuery } from './plan';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('the filter grammar', () => {
    it('accepts and/or groups of conditions and nested groups', () => {
        const filter: FilterGroup = {
            and: [
                { field: 'nameFirst', op: 'eq', value: 'Dana' },
                {
                    or: [
                        { field: 'ownerId', op: 'is_null' },
                        { field: 'city', op: 'starts', value: 'Aus' },
                    ],
                },
            ],
        };
        expect(parseFilter(filter)).toEqual(filter);
    });

    it('refuses an unknown operator, an extra key, and a group with neither and nor or', () => {
        expect(() => parseFilter({ and: [{ field: 'name', op: 'like', value: 'x' }] })).toThrow(BadRequestException);
        expect(() => parseFilter({ and: [{ field: 'name', op: 'eq', value: 'x', extra: 1 }] })).toThrow(
            BadRequestException,
        );
        expect(() => parseFilter({ not: [] })).toThrow(BadRequestException);
    });

    it('refuses a field name that is neither a standard name nor custom.<key>', () => {
        expect(() => parseFilter({ and: [{ field: 'custom.Bad-Key', op: 'eq', value: 1 }] })).toThrow(
            BadRequestException,
        );
        expect(() => parseFilter({ and: [{ field: 'name;drop', op: 'eq', value: 1 }] })).toThrow(BadRequestException);
    });

    it('decodes the query-string form and names what is wrong with it', () => {
        expect(decodeFilterParam(encode({ or: [] }))).toEqual({ or: [] });
        expect(() => decodeFilterParam('%%%')).toThrow(/base64url/);
        expect(() => decodeFilterParam(encode('a string'))).toThrow(BadRequestException);
    });

    it(`limits nesting to ${FILTER_MAX_DEPTH} levels`, () => {
        let node: FilterGroup = { and: [{ field: 'name', op: 'eq', value: 'x' }] };
        for (let i = 1; i < FILTER_MAX_DEPTH; i++) node = { and: [node] };
        expect(() => planQuery('company', { filter: node }, [])).not.toThrow();
        expect(() => planQuery('company', { filter: { and: [node] } }, [])).toThrow(/nest at most/);
    });

    it(`limits a filter to ${FILTER_MAX_NODES} nodes`, () => {
        const many = (n: number): FilterNode[] =>
            Array.from({ length: n }, () => ({ field: 'name', op: 'eq', value: 'x' }));
        expect(() => planQuery('company', { filter: { and: many(FILTER_MAX_NODES - 1) } }, [])).not.toThrow();
        expect(() => planQuery('company', { filter: { and: many(FILTER_MAX_NODES) } }, [])).toThrow(/at most/);
    });

    it(`limits an in-list to ${FILTER_MAX_LIST} values`, () => {
        const values = Array.from({ length: FILTER_MAX_LIST + 1 }, (_, i) => `v${i}`);
        expect(() =>
            planQuery('company', { filter: { and: [{ field: 'name', op: 'in', value: values }] } }, []),
        ).toThrow(/at most/);
    });
});

describe('a filter on id (P1-4a)', () => {
    const uuids = (n: number) =>
        Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

    it('reads many records by id, on every object, as one column condition', () => {
        const ids = uuids(3);
        for (const object of ['person', 'company', 'opportunity'] as const) {
            expect(planQuery(object, { filter: { and: [{ field: 'id', op: 'in', value: ids }] } }, []).where).toEqual({
                AND: [{ id: { in: ids } }],
            });
        }
    });

    it(`takes up to ${FILTER_MAX_IDS} ids — past ${FILTER_MAX_LIST}, the limit of any other list`, () => {
        const filter = { and: [{ field: 'id', op: 'in' as const, value: uuids(FILTER_MAX_IDS) }] };
        expect(() => planQuery('person', { filter }, [])).not.toThrow();
    });

    it(`answers ${FILTER_MAX_IDS + 1} ids with 413, not a shorter list`, () => {
        const filter = { and: [{ field: 'id', op: 'in' as const, value: uuids(FILTER_MAX_IDS + 1) }] };
        expect(() => planQuery('person', { filter }, [])).toThrow(PayloadTooLargeException);
    });

    it('refuses an id that is not a uuid, and id as a sort', () => {
        expect(() =>
            planQuery('person', { filter: { and: [{ field: 'id', op: 'in', value: ['not-a-uuid'] }] } }, []),
        ).toThrow(BadRequestException);
        expect(() => planQuery('person', { sort: 'id:asc' }, [])).toThrow(BadRequestException);
    });
});

describe('planQuery', () => {
    it('orders by createdAt desc then id when nothing asks otherwise', () => {
        expect(planQuery('person', {}, []).orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
    });

    it("takes a view's filter and sorts as defaults and lets inline ones override", () => {
        const view = {
            filter: { and: [{ field: 'icp', op: 'eq', value: true }] } as FilterGroup,
            sorts: [{ field: 'name', direction: 'asc' as const }],
        };
        const fromView = planQuery('company', { view }, []);
        expect(fromView.where).toEqual({ AND: [{ icp: { equals: true } }] });
        expect(fromView.orderBy[0]).toEqual({ name: 'asc' });

        const overridden = planQuery('company', { view, sort: 'employeeCount:desc', filter: { or: [] } }, []);
        expect(overridden.where).toEqual({ OR: [] });
        expect(overridden.orderBy[0]).toEqual({ employeeCount: 'desc' });
    });
});
