import { plainBiginId } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { outcomeError } from './bigin-sync.service';
import { lookupId, mapAccount, mapContact, mapDeal, mapNote, phoneFrom, type BiginLinkIndex } from './mappers';

const links: BiginLinkIndex = {
    resolve: (object, id) => (typeof id === 'string' ? `${object}:${id}` : null),
};

describe('FR-CRMS-25 BIGIN-1 Bigin mappers', () => {
    it('a Bigin id is its bare number, with or without the CSV export’s zcrm_ prefix', () => {
        expect(plainBiginId('zcrm_5725767000001')).toBe('5725767000001');
        expect(plainBiginId('5725767000001')).toBe('5725767000001');
        expect(plainBiginId('')).toBeNull();
        expect(lookupId({ id: '42', name: 'Acme' })).toBe('42');
        expect(lookupId(null)).toBeNull();
    });

    it('an account: its name, registrable domain from the website, billing address, owner email', () => {
        expect(
            mapAccount({
                id: '1',
                Account_Name: 'Acme',
                Website: 'https://shop.acme.co.uk/path',
                Billing_City: 'Leeds',
                Owner: { name: 'A', id: '9', email: 'Owner@Pinion.example' },
            }),
        ).toEqual({
            input: {
                name: 'Acme',
                domain: 'acme.co.uk',
                address: { street: null, city: 'Leeds', state: null, country: null, postalCode: null },
            },
            custom: {},
            ownerEmail: 'owner@pinion.example',
        });
        expect(mapAccount({ id: '2', Account_Name: ' ' })).toEqual({ skip: 'no name' });
    });

    it('a contact: names, addresses, an international phone, the company through the links, PR link as a custom field', () => {
        const mapped = mapContact(
            {
                id: '3',
                First_Name: 'Matt',
                Last_Name: 'C',
                Email: 'Matt@Acme.example',
                Secondary_Email: 'm@home.example',
                Phone: '+44 20 7946 0958',
                Mobile: '555-1234',
                Account_Name: { id: '1' },
                PR_LINK: 'newswire.ca/x',
            },
            links,
        );
        expect(mapped).toMatchObject({
            input: {
                nameFirst: 'Matt',
                emails: { primary: 'matt@acme.example', additional: ['m@home.example'] },
                phones: { primary: { countryCode: 'GB' }, additional: [] },
                companyId: 'Accounts:1',
                source: 'bigin',
            },
            custom: { pr_link: { type: 'url', value: 'https://newswire.ca/x' } },
        });
        expect(phoneFrom('555-1234')).toBeNull();
        expect(mapContact({ id: '4' }, links)).toEqual({ skip: 'no name and no email' });
    });

    it('a deal: amount in minor units, its company and contact, the raw stage', () => {
        expect(
            mapDeal(
                { id: '5', Deal_Name: 'D', Amount: 12.5, Stage: 'Closed Won', Contact_Name: { id: '3' } },
                links,
                'CAD',
            ),
        ).toMatchObject({
            input: { name: 'D', amount: { amountMinor: 1250, currency: 'CAD' }, pointOfContactId: 'Contacts:3' },
            stage: 'Closed Won',
        });
    });

    it('a note lands on its parent, whichever module Bigin names; none without content or parent', () => {
        expect(
            mapNote({ id: '6', Note_Content: 'hi', $se_module: 'Potentials', Parent_Id: { id: '5' } }, links),
        ).toMatchObject({ input: { targets: [{ type: 'opportunity', id: 'Deals:5' }] } });
        expect(mapNote({ id: '7', Note_Content: '', $se_module: 'Contacts' }, links)).toEqual({ skip: 'no content' });
        expect(mapNote({ id: '8', Note_Content: 'x', $se_module: 'Tasks' }, links)).toEqual({
            skip: 'its record is not in BylineCRM',
        });
    });

    it('fail loudly: a scheduled run that left records unwritten counts against the schedule, saying how many', () => {
        const report = [{ object: 'Contacts', failed: 2, errors: [{ externalId: '3', message: 'bad' }] }];
        expect(outcomeError({ status: 'succeeded', error: null, report })).toBe(
            '2 records could not be written (first: Contacts 3: bad)',
        );
        expect(outcomeError({ status: 'succeeded', error: null, report: [] })).toBeNull();
        expect(outcomeError({ status: 'failed', error: 'refused', report: [] })).toBe('refused');
    });
});
