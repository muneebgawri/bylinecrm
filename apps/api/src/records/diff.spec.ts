import type { Links } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { diffOf, isEmpty, projectedChanges } from './diff';

type Row = { ownerId: string | null; nameFirst: string; updatedAt: Date };
const view = (row: Row) => ({ ownerId: row.ownerId, nameFirst: row.nameFirst });
const current: Row = { ownerId: 'm1', nameFirst: 'Dana', updatedAt: new Date(0) };

describe('projectedChanges (P1-4a)', () => {
    it('is empty when the data would leave every field as it is — a no-op', () => {
        expect(isEmpty(projectedChanges(current, { ownerId: 'm1' }, view, ['ownerId', 'nameFirst']))).toBe(true);
        expect(isEmpty(projectedChanges(current, {}, view, ['ownerId', 'nameFirst']))).toBe(true);
    });

    it('names what would change, as diffOf would after the write', () => {
        const projected = projectedChanges(current, { ownerId: 'm2' }, view, ['ownerId', 'nameFirst']);
        expect(projected).toEqual({ ownerId: { from: 'm1', to: 'm2' } });
        expect(projected).toEqual(diffOf(view(current), view({ ...current, ownerId: 'm2' }), ['ownerId', 'nameFirst']));
    });
});

describe('diffOf (P4-4): a composite read back from jsonb is the composite the caller sent', () => {
    it('ignores the order of an object’s keys at every depth, and still sees a changed value', () => {
        const fromRow: { links: Links } = { links: { x: null, linkedin: { url: 'https://l.example/a', label: null } } };
        const fromCaller: { links: Links } = {
            links: { linkedin: { label: null, url: 'https://l.example/a' }, x: null },
        };
        expect(isEmpty(diffOf(fromRow, fromCaller, ['links']))).toBe(true);
        const changed: { links: Links } = { links: { linkedin: { label: 'A', url: 'https://l.example/a' }, x: null } };
        expect(Object.keys(diffOf(fromRow, changed, ['links']))).toEqual(['links']);
    });

    it('keeps arrays in order and dates as instants', () => {
        expect(isEmpty(diffOf({ tags: ['a', 'b'] }, { tags: ['b', 'a'] }, ['tags']))).toBe(false);
        expect(isEmpty(diffOf({ at: new Date(0) }, { at: new Date(0) }, ['at']))).toBe(true);
    });
});
