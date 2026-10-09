import { describe, expect, it } from 'vitest';
import { matchesVariable } from './VariablePicker';

const fullName = {
    path: 'sender.fullName',
    source: 'sender',
    label: 'Full name',
    type: 'text',
    optional: false,
} as const;

describe('variable picker search', () => {
    it('matches every typed word in any order, against group, label and path', () => {
        expect(matchesVariable('sender full', fullName, 'Full name')).toBe(true);
        expect(matchesVariable('full sender', fullName, 'Full name')).toBe(true);
        expect(matchesVariable('FULLNAME', fullName, 'Full name')).toBe(true);
        expect(matchesVariable('', fullName, 'Full name')).toBe(true);
    });

    it('drops a variable when any word is absent', () => {
        expect(matchesVariable('sender city', fullName, 'Full name')).toBe(false);
    });
});
