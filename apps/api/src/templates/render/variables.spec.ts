import { TEMPLATE_VARIABLES } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { customText, resolverFor, unknownVariables, type CustomKeys, type RenderSubjects } from './variables';

const subjects: RenderSubjects = {
    person: {
        nameFirst: 'Dana',
        nameLast: ' ',
        emails: { primary: 'dana@acme.example', additional: [] },
        jobTitle: 'Head of Comms',
        city: null,
        custom: { beat: 'fintech', tags: ['a', 'b'], vip: true, score: 9, empty: '  ' },
    },
    company: { name: 'Acme', domain: 'acme.example', custom: { tier: 'gold' } },
    deal: { name: 'Series B PR', amountMinor: 1_200_050, currency: 'USD', custom: {} },
    sender: { displayName: 'Kate Morgan' },
};

describe('resolverFor', () => {
    const resolve = resolverFor(subjects);

    it('resolves every standard variable from its source; empty values are missing (null)', () => {
        expect(resolve('person.firstName')).toBe('Dana');
        expect(resolve('person.lastName')).toBeNull();
        expect(resolve('person.fullName')).toBe('Dana');
        expect(resolve('person.email')).toBe('dana@acme.example');
        expect(resolve('person.jobTitle')).toBe('Head of Comms');
        expect(resolve('person.city')).toBeNull();
        expect(resolve('company.name')).toBe('Acme');
        expect(resolve('company.domain')).toBe('acme.example');
        expect(resolve('deal.name')).toBe('Series B PR');
        expect(resolve('deal.amount')).toBe('$12,000.50');
        expect(resolve('sender.firstName')).toBe('Kate');
        expect(resolve('sender.fullName')).toBe('Kate Morgan');
    });

    it('sender.signature is the one optional variable: empty, never missing', () => {
        expect(TEMPLATE_VARIABLES.filter((v) => 'optional' in v).map((v) => v.path)).toEqual(['sender.signature']);
        expect(resolve('sender.signature')).toBe('');
    });

    it('a variable whose source is absent is missing', () => {
        const none = resolverFor({ ...subjects, company: null, deal: null, sender: null });
        expect(none('company.name')).toBeNull();
        expect(none('deal.amount')).toBeNull();
        expect(none('sender.firstName')).toBeNull();
        expect(none('company.custom.tier')).toBeNull();
    });

    it('custom fields read from their own record', () => {
        expect(resolve('person.custom.beat')).toBe('fintech');
        expect(resolve('person.custom.tags')).toBe('a, b');
        expect(resolve('person.custom.vip')).toBe('Yes');
        expect(resolve('person.custom.score')).toBe('9');
        expect(resolve('person.custom.empty')).toBeNull();
        expect(resolve('company.custom.tier')).toBe('gold');
        expect(resolve('deal.custom.tier')).toBeNull();
    });

    it('a path outside the grammar has no value', () => {
        expect(resolve('unsubscribe_url')).toBeNull();
        expect(resolve('person.password')).toBeNull();
    });
});

describe('unknownVariables', () => {
    const custom: CustomKeys = { person: new Set(['beat']), company: new Set(), deal: new Set(['tier']) };

    it('accepts the registry and the workspace’s custom fields, by source', () => {
        expect(
            unknownVariables(
                [
                    { path: 'person.firstName', at: 'subject' },
                    { path: 'person.custom.beat', at: 'body.content.0.content.0' },
                    { path: 'deal.custom.tier', at: 'subject' },
                ],
                custom,
            ),
        ).toEqual([]);
    });

    it('names each unknown path where it sits', () => {
        expect(
            unknownVariables(
                [
                    { path: 'person.password', at: 'subject' },
                    { path: 'company.custom.beat', at: 'body.content.1.content.0' },
                    { path: 'unsubscribe_url', at: 'subject' },
                    { path: 'custom.beat', at: 'subject' },
                ],
                custom,
            ),
        ).toEqual([
            { path: 'subject', message: 'unknown variable "person.password"' },
            { path: 'body.content.1.content.0', message: 'unknown variable "company.custom.beat"' },
            { path: 'subject', message: 'unknown variable "unsubscribe_url"' },
            { path: 'subject', message: 'unknown variable "custom.beat"' },
        ]);
    });
});

describe('customText', () => {
    it.each([
        [null, null],
        [false, 'No'],
        [0, '0'],
        [Number.NaN, null],
        [[], null],
        [{ x: 1 }, null],
    ])('%j → %j', (value, expected) => {
        expect(customText(value)).toBe(expected);
    });
});
