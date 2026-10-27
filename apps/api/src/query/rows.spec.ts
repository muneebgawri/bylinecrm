import { describe, expect, it } from 'vitest';
import { resolveFields } from './fields';
import { cellOf } from './rows';

const person = resolveFields('person', [
    { key: 'beat', label: 'Beat', type: 'text' as const, options: [], required: false },
]);
const field = (name: string) => person.find((f) => f.name === name)!;

describe('cellOf', () => {
    const row = {
        id: 'p1',
        jobTitle: 'CEO',
        phones: { primary: { number: '8889881699', countryCode: 'US', extension: '204' }, additional: [] },
        custom: { beat: 'fintech' },
    };

    it('reads a column, a path into a composite and a custom key', () => {
        expect(cellOf(row, field('jobTitle'))).toBe('CEO');
        expect(cellOf(row, field('phonePrimary'))).toBe('8889881699');
        expect(cellOf(row, field('phoneExtension'))).toBe('204');
        expect(cellOf(row, field('custom.beat'))).toBe('fintech');
    });

    it('a path that is not there is empty, not an error', () => {
        const none = { id: 'p2', phones: { primary: null, additional: [] }, custom: null };
        expect(cellOf(none, field('phonePrimary'))).toBeUndefined();
        expect(cellOf(none, field('custom.beat'))).toBeUndefined();
    });
});
