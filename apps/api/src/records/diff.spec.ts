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
