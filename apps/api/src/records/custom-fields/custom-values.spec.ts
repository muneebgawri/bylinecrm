import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { type FieldDefinition, mergeCustomValues, optionsProblem, validateCustomValues } from './custom-values';

const definitions: FieldDefinition[] = [
    { key: 'beat', type: 'select', options: ['fintech', 'health'], required: true },
    { key: 'score', type: 'number', options: [], required: false },
    { key: 'tags', type: 'multiselect', options: ['a', 'b'], required: false },
    { key: 'since', type: 'date', options: [], required: false },
    { key: 'site', type: 'url', options: [], required: false },
];

function issues(fn: () => unknown): string[] {
    try {
        fn();
    } catch (error) {
        if (error instanceof BadRequestException) {
            const body = error.getResponse() as { issues: { path: string }[] };
            return body.issues.map((i) => i.path);
        }
        throw error;
    }
    throw new Error('expected a BadRequestException');
}

describe('validateCustomValues', () => {
    it('accepts values of the right types', () => {
        expect(
            validateCustomValues(
                definitions,
                { beat: 'fintech', score: 3.5, tags: ['a'], since: '2026-10-09', site: 'https://x.example' },
                'create',
            ),
        ).toEqual({ beat: 'fintech', score: 3.5, tags: ['a'], since: '2026-10-09', site: 'https://x.example' });
    });

    it('refuses an unknown key, naming it under custom.', () => {
        expect(issues(() => validateCustomValues(definitions, { beat: 'fintech', colour: 'red' }, 'create'))).toEqual([
            'custom.colour',
        ]);
    });

    it('refuses a wrong type and an option that is not defined', () => {
        expect(issues(() => validateCustomValues(definitions, { beat: 'sports', score: 'high' }, 'create'))).toEqual([
            'custom.beat',
            'custom.score',
        ]);
    });

    it('requires a required field on create, but not on patch', () => {
        expect(issues(() => validateCustomValues(definitions, { score: 1 }, 'create'))).toEqual(['custom.beat']);
        expect(validateCustomValues(definitions, { score: 1 }, 'patch')).toEqual({ score: 1 });
    });

    it('never lets a required field be cleared', () => {
        expect(issues(() => validateCustomValues(definitions, { beat: null }, 'patch'))).toEqual(['custom.beat']);
        expect(validateCustomValues(definitions, { score: null }, 'patch')).toEqual({ score: null });
    });
});

describe('mergeCustomValues', () => {
    it('replaces mentioned keys, removes keys set to null, keeps the rest', () => {
        expect(mergeCustomValues({ beat: 'fintech', score: 1, tags: ['a'] }, { score: null, tags: ['b'] })).toEqual({
            beat: 'fintech',
            tags: ['b'],
        });
    });
});

describe('optionsProblem', () => {
    it('wants options for selects only, and distinct ones', () => {
        expect(optionsProblem('select', [])).toMatch(/at least one option/);
        expect(optionsProblem('multiselect', ['a', 'a'])).toMatch(/distinct/);
        expect(optionsProblem('text', ['a'])).toMatch(/takes no options/);
        expect(optionsProblem('select', ['a'])).toBeNull();
        expect(optionsProblem('number', [])).toBeNull();
    });
});
