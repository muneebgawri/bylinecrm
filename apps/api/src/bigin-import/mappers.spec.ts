import { plainBiginId } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { outcomeError } from './bigin-sync.service';
import {
    customText,
    lookupId,
    mapAccount,
    mapCall,
    mapContact,
    mapDeal,
    mapEvent,
    mapNote,
    mapTask,
    phoneFrom,
    readPhone,
    referencesOf,
    taskStatusOf,
    type BiginLinkIndex,
} from './mappers';

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
                Description: ' Met at the expo. ',
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
            custom: {
                pr_link: { type: 'url', value: 'https://newswire.ca/x' },
                description: { type: 'text', value: 'Met at the expo.' },
                // Seven digits and no calling code: kept as Bigin wrote it, never dropped.
                phone_unparsed: { type: 'text', value: 'Mobile: 555-1234', label: 'Phone (as in Bigin)' },
            },
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

    it('a note paged by token (v2, no `$se_module`) still lands on its parent: by `Parent_Id.module`, else by its id in any module', () => {
        expect(
            mapNote(
                { id: '9', Note_Content: 'hi', Parent_Id: { id: '5', module: { api_name: 'Deals', id: '1' } } },
                links,
            ),
        ).toMatchObject({ input: { targets: [{ type: 'opportunity', id: 'Deals:5' }] } });
        const onlyAccount: BiginLinkIndex = {
            resolve: (object, id) => (object === 'Accounts' && lookupId(id) === '4' ? 'company-4' : null),
        };
        expect(
            mapNote({ id: '10', Note_Content: 'hi', Parent_Id: { id: '4', name: 'Acme' } }, onlyAccount),
        ).toMatchObject({
            input: { targets: [{ type: 'company', id: 'company-4' }] },
        });
        expect(mapNote({ id: '11', Note_Content: 'hi', Parent_Id: { id: '99' } }, { resolve: () => null })).toEqual({
            skip: 'its record is not in BylineCRM',
        });
        expect(referencesOf('Notes', { id: '10', Parent_Id: { id: '4' } })).toEqual([
            { object: 'Notes', id: '10' },
            { object: 'Contacts', id: '4' },
            { object: 'Accounts', id: '4' },
            { object: 'Deals', id: '4' },
        ]);
    });

    it('BIGIN-1 phones: a North American number without + is +1, an extension is kept, an international one keeps its country, the rest stays as written', () => {
        const us = (number: string, extension?: string) => ({
            phone: { number, countryCode: 'US', ...(extension ? { extension } : {}) },
            callingCode: '+1',
        });
        expect(readPhone('999-999-9999')).toEqual(us('9999999999'));
        expect(readPhone('(999) 999-9999')).toEqual(us('9999999999'));
        expect(readPhone('999.999.9999 ext 9')).toEqual(us('9999999999', '9'));
        expect(readPhone('1-999-999-9999 x12')).toEqual(us('9999999999', '12'));
        expect(readPhone('999 999 9999 Ext. 345')).toEqual(us('9999999999', '345'));
        expect(readPhone('+1 978 252 2121')).toEqual(us('9782522121'));
        expect(readPhone('+44 20 7946 0958')).toEqual({
            phone: { number: '2079460958', countryCode: 'GB' },
            callingCode: '+44',
        });
        // Not a number this can read: kept verbatim.
        for (const raw of ['555-1234', '2-999-999-9999', '1-800-FLOWERS', 'call reception', '+999 12', '99999999999'])
            expect(readPhone(raw)).toEqual({ unparsed: raw });
        expect(readPhone('  ')).toBeNull();
        expect(readPhone(undefined)).toBeNull();
        expect(phoneFrom('(999) 999-9999')).toEqual({ number: '9999999999', countryCode: 'US' });

        const both = mapContact(
            { id: '1', Email: 'a@b.example', Phone: '(999) 999-9999', Mobile: '+1 999 999 9998' },
            links,
        );
        expect(both).toMatchObject({
            input: {
                phones: {
                    primary: { number: '9999999999', countryCode: 'US' },
                    additional: [{ number: '9999999998', countryCode: 'US' }],
                },
            },
            // Every number read: nothing kept aside, and a copy kept before is cleared.
            custom: { phone_unparsed: null },
        });
        expect(mapContact({ id: '2', Email: 'a@b.example', Phone: 'ask', Mobile: 'n/a' }, links)).toMatchObject({
            input: { phones: { primary: null, additional: [] } },
            custom: { phone_unparsed: { type: 'text', value: 'Phone: ask; Mobile: n/a' } },
        });
    });

    it('BIGIN-1: an account’s phone and description, and a deal’s description and press release title, as custom text fields', () => {
        expect(
            mapAccount({ id: '1', Account_Name: 'Acme', Phone: '999.999.9999 ext 9', Description: 'Wire client' }),
        ).toMatchObject({
            custom: {
                phone: { type: 'text', value: '+1 9999999999 ext 9' },
                description: { type: 'text', value: 'Wire client' },
            },
        });
        expect(mapAccount({ id: '2', Account_Name: 'Acme', Phone: 'front desk' })).toMatchObject({
            custom: { phone: { type: 'text', value: 'front desk' } },
        });
        expect(
            mapDeal(
                { id: '5', Deal_Name: 'D', Description: 'Two releases', Title_of_Press_Release: 'Acme launches X' },
                links,
                'USD',
            ),
        ).toMatchObject({
            custom: {
                description: { type: 'text', value: 'Two releases' },
                press_release_title: { type: 'text', value: 'Acme launches X', label: 'Press release title' },
            },
        });
        // Empty in Bigin: left out, so a value written here is never cleared by it.
        expect(mapDeal({ id: '6', Deal_Name: 'D', Description: ' ' }, links, 'USD')).toMatchObject({ custom: {} });
        // Longer than a custom text value holds: cut, with an ellipsis.
        const long = customText('x'.repeat(20_000))!;
        expect(long).toHaveLength(10_000);
        expect(long.endsWith('…')).toBe(true);
        expect(customText('😀'.repeat(6_000))!.length).toBeLessThanOrEqual(10_000);
    });

    it('BIGIN-1: a Bigin task is a task on its record — status, due date, completion, assignee by owner; none without a record here', () => {
        const owner = { name: 'O', id: '9', email: 'Rep@Pinion.example' };
        expect(
            mapTask(
                {
                    id: '20',
                    Subject: 'Send the draft',
                    Status: 'In-Progress',
                    Priority: 'High',
                    Due_Date: '2026-03-02',
                    Description: 'Ask about **embargo**',
                    $se_module: 'Deals',
                    What_Id: { id: '5', name: 'D' },
                    Who_Id: { id: '3', name: 'Matt' },
                    Owner: owner,
                },
                links,
            ),
        ).toMatchObject({
            input: {
                title: 'Send the draft',
                status: 'in_progress',
                dueAt: '2026-03-02T00:00:00.000Z',
                completedAt: null,
                targets: [
                    { type: 'opportunity', id: 'Deals:5' },
                    { type: 'person', id: 'Contacts:3' },
                ],
            },
            ownerEmail: 'rep@pinion.example',
        });
        const done = mapTask(
            {
                id: '21',
                Subject: 'Call back',
                Status: 'Completed',
                Closed_Time: '2026-02-01T10:00:00-05:00',
                Who_Id: { id: '3' },
            },
            links,
        );
        expect(done).toMatchObject({ input: { status: 'done', completedAt: '2026-02-01T10:00:00-05:00' } });
        // As Bigin answers a task asked for `What_Id` (production): `Related_To`, its module in `$related_module`.
        expect(
            mapTask(
                {
                    id: '24',
                    Subject: 'Follow up',
                    Related_To: { id: '3', name: 'Matt' },
                    $related_module: 'Contacts',
                    $se_module: null,
                },
                links,
            ),
        ).toMatchObject({ input: { targets: [{ type: 'person', id: 'Contacts:3' }] } });
        expect(
            mapTask({ id: '25', Subject: 'Deal', Related_To: { id: '5', name: 'D' }, $related_module: 'Deals' }, links),
        ).toMatchObject({ input: { targets: [{ type: 'opportunity', id: 'Deals:5' }] } });
        expect(
            referencesOf('Tasks', { id: '24', Related_To: { id: '3', name: 'Matt' }, $related_module: 'Contacts' }),
        ).toEqual([
            { object: 'Tasks', id: '24' },
            { object: 'Contacts', id: '3' },
        ]);
        expect(taskStatusOf('Not Started')).toBe('todo');
        expect(taskStatusOf('In Progress')).toBe('in_progress');
        expect(taskStatusOf('Deferred')).toBe('todo');
        expect(mapTask({ id: '22', Subject: 'Alone' }, links)).toEqual({ skip: 'its record is not in BylineCRM' });
        expect(mapTask({ id: '23', Subject: 'Gone', What_Id: { id: '1' } }, { resolve: () => null })).toEqual({
            skip: 'its record is not in BylineCRM',
        });
        expect(
            referencesOf('Tasks', { id: '20', $se_module: 'Accounts', What_Id: { id: '1' }, Who_Id: { id: '3' } }),
        ).toEqual([
            { object: 'Tasks', id: '20' },
            { object: 'Accounts', id: '1' },
            { object: 'Contacts', id: '3' },
        ]);
    });

    it('BIGIN-1: an event is a "Meeting:" task, done once it has ended; a call a done "Call:" task with its details in the body', () => {
        const now = new Date('2026-10-29T12:00:00Z');
        const past = mapEvent(
            {
                id: '30',
                Event_Title: 'Kick-off',
                Start_DateTime: '2026-10-01T09:00:00-04:00',
                End_DateTime: '2026-10-01T10:00:00-04:00',
                Venue: 'Zoom',
                Related_To: { id: '1', module: { api_name: 'Accounts' } },
            },
            links,
            now,
        );
        expect(past).toMatchObject({
            input: {
                title: 'Meeting: Kick-off',
                status: 'done',
                dueAt: '2026-10-01T09:00:00-04:00',
                completedAt: '2026-10-01T10:00:00-04:00',
                targets: [{ type: 'company', id: 'Accounts:1' }],
            },
        });
        expect(JSON.stringify((past as { input: { body: unknown } }).input.body)).toContain('Venue: Zoom');
        expect(
            mapEvent(
                { id: '31', Event_Title: 'Later', End_DateTime: '2026-11-01T10:00:00Z', Who_Id: { id: '3' } },
                links,
                now,
            ),
        ).toMatchObject({ input: { status: 'todo', completedAt: null } });

        const call = mapCall(
            {
                id: '40',
                Subject: 'Intro',
                Call_Start_Time: '2026-09-01T15:00:00Z',
                Call_Duration: '05:30',
                Call_Type: 'Outbound',
                Call_Purpose: 'Prospecting',
                Call_Result: 'Interested',
                Description: 'Wants pricing',
                $se_module: 'Contacts',
                What_Id: { id: '3' },
            },
            links,
        );
        expect(call).toMatchObject({
            input: {
                title: 'Call: Intro',
                status: 'done',
                dueAt: '2026-09-01T15:00:00Z',
                completedAt: '2026-09-01T15:00:00Z',
                targets: [{ type: 'person', id: 'Contacts:3' }],
            },
        });
        const body = JSON.stringify((call as { input: { body: unknown } }).input.body);
        for (const part of [
            'Wants pricing',
            'Type: Outbound',
            'Purpose: Prospecting',
            'Result: Interested',
            'Duration: 05:30',
        ])
            expect(body).toContain(part);
        expect(mapCall({ id: '41', Subject: 'Nobody' }, links)).toEqual({ skip: 'its record is not in BylineCRM' });
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
