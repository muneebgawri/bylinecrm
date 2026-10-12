import { describe, expect, it } from 'vitest';
import { definitionsNeeded, inferCustomValues, labelOf } from './custom-fields-sync';

describe('P4-4 (doc 48 §11): the fields Twenty added to an object become custom fields here', () => {
    it('infers a type from the value, flattens composites, and records an empty answer as cleared', () => {
        const inferred = inferCustomValues(
            {
                id: 'x',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                deletedAt: null,
                createdBy: { source: 'API' },
                updatedBy: { source: 'API' },
                position: 3,
                searchVector: 'abc',
                name: 'kept out: a standard field',
                biginrecordid: 'zcrm_1',
                gatekeeperblocked: true,
                emailConfirmations: 2,
                nexttouchdate: '2026-11-01',
                enrichedAt: '2026-10-02T16:24:11.794Z',
                objectioncategory: 'ALREADY_COVERED',
                stripeltv: { amountMicros: 1500000, currencyCode: 'USD' },
                storyLink: { primaryLinkUrl: 'thetimes.example/story', primaryLinkLabel: '' },
                contact: { primaryEmail: 'a@b.example' },
                hotline: { primaryPhoneNumber: '5550100', primaryPhoneCountryCode: 'US' },
                who: { firstName: 'Ada', lastName: 'Byron' },
                seniority: '',
                emailCheckedAt: null,
                timelineActivities: [{ id: 'relation rows are never values' }],
                nested: { some: 'unknown object' },
            },
            new Set(['name']),
        );
        expect(inferred).toEqual({
            biginrecordid: { type: 'text', value: 'zcrm_1' },
            gatekeeperblocked: { type: 'boolean', value: true },
            email_confirmations: { type: 'number', value: 2 },
            nexttouchdate: { type: 'date', value: '2026-11-01' },
            enriched_at: { type: 'datetime', value: '2026-10-02T16:24:11.794Z' },
            objectioncategory: { type: 'select', value: 'ALREADY_COVERED' },
            stripeltv: { type: 'number', value: 1.5 },
            stripeltv_currency: { type: 'text', value: 'USD' },
            story_link: { type: 'url', value: 'https://thetimes.example/story' },
            contact: { type: 'email', value: 'a@b.example' },
            hotline: { type: 'phone', value: '5550100' },
            who: { type: 'text', value: 'Ada Byron' },
            seniority: null,
            email_checked_at: null,
        });
    });

    it('a key that would not be a valid custom-field key is made one; labels read as words', () => {
        expect(inferCustomValues({ id: 'x', 'Weird-Key 1': 'v', _lead: 'w' }, new Set())).toEqual({
            weird_key_1: { type: 'text', value: 'v' },
            lead: { type: 'text', value: 'w' },
        });
        expect(labelOf('pr_link')).toBe('Pr link');
        expect(labelOf('biginrecordid')).toBe('Biginrecordid');
        expect(labelOf('lead_lifetime_value_currency')).toBe('Lead lifetime value currency');
    });

    it('definitions needed by a page: one per key, the first non-empty type wins, select options accumulate', () => {
        const needed = definitionsNeeded(
            [
                { stage: { type: 'select', value: 'NEW' }, amount: null, flag: { type: 'boolean', value: true } },
                { stage: { type: 'select', value: 'PROPOSAL' }, amount: { type: 'number', value: 2 }, flag: null },
                { stage: { type: 'select', value: 'NEW' }, note: { type: 'text', value: 'hi' } },
            ],
            [{ key: 'stage', type: 'select', options: ['OLD'] }],
        );
        expect(needed).toEqual([
            { key: 'stage', label: 'Stage', type: 'select', options: ['OLD', 'NEW', 'PROPOSAL'], existing: true },
            { key: 'flag', label: 'Flag', type: 'boolean', options: [], existing: false },
            { key: 'amount', label: 'Amount', type: 'number', options: [], existing: false },
            { key: 'note', label: 'Note', type: 'text', options: [], existing: false },
        ]);
    });

    it('a value whose type disagrees with the definition that exists is carried as that type when it can be', () => {
        const needed = definitionsNeeded(
            [{ code: { type: 'select', value: 'ABC' } }, { code: { type: 'number', value: 7 } }],
            [{ key: 'code', type: 'text', options: [] }],
        );
        expect(needed).toEqual([{ key: 'code', label: 'Code', type: 'text', options: [], existing: true }]);
    });
});
