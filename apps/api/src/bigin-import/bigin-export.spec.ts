import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BiginExport, apiNameOf, recordFromRow, withPreviousStages, zonedIso } from './bigin-export';
import type { BiginConnection, BiginRecord } from './bigin.port';
import { CsvParser, parseCsv } from './csv';
import { mapContact, mapDeal, mapEvent, mapNote, mapTask } from './mappers';
import { readEmail, readStageHistory } from './history';

const users = new Map([['100', { name: 'Kate Morgan', email: 'kate@pinion.example' }]]);
const context = { users, timeZone: 'Asia/Karachi' };
const links = { resolve: (_object: string, id: unknown) => (typeof id === 'string' ? `local-${id}` : null) };
const connection = {} as BiginConnection;

describe('BIGIN-1 CSV', () => {
    it('reads quoted cells with commas, doubled quotes and line breaks, CRLF rows and a byte-order mark', () => {
        const rows = parseCsv('﻿Record Id,Note Content,Note Title\r\nzcrm_1,"one, ""two""\nthree",T\r\nzcrm_2,,"x"\n');
        expect(rows).toEqual([
            { 'Record Id': 'zcrm_1', 'Note Content': 'one, "two"\nthree', 'Note Title': 'T' },
            { 'Record Id': 'zcrm_2', 'Note Content': '', 'Note Title': 'x' },
        ]);
    });

    it('reads a cell split across pieces of input, quote by quote', () => {
        const parser = new CsvParser();
        const text = 'a,b\r\n"x""\ny",z\r\n';
        const rows = [...text].flatMap((ch) => parser.push(ch));
        expect([...rows, ...parser.end()]).toEqual([
            ['a', 'b'],
            ['x"\ny', 'z'],
        ]);
    });

    it('refuses a file that ends inside quotes', () => {
        const parser = new CsvParser();
        parser.push('a\n"open');
        expect(() => parser.end()).toThrow(/inside a quoted cell/);
    });
});

describe('BIGIN-1 export rows as the API returns them', () => {
    it('names each label as the API does, per module', () => {
        expect(apiNameOf('Accounts', 'Company Name')).toBe('Account_Name');
        expect(apiNameOf('Accounts', 'Company Owner.id')).toBe('Owner');
        expect(apiNameOf('Accounts', 'Billing Code')).toBe('Billing_Code');
        expect(apiNameOf('Contacts', 'Company Name.id')).toBe('Account_Name');
        expect(apiNameOf('Contacts', 'PR LINK')).toBe('PR_LINK');
        expect(apiNameOf('Contacts', 'Email Opt Out')).toBe('Email_Opt_Out');
        expect(apiNameOf('Deals', 'Pipeline Name')).toBe('Deal_Name');
        expect(apiNameOf('Deals', 'Contact Name.id')).toBe('Contact_Name');
        expect(apiNameOf('Deals', 'Title of Press Release')).toBe('Title_of_Press_Release');
        expect(apiNameOf('Notes', 'Parent.id')).toBe('Parent_Id');
        expect(apiNameOf('Notes', 'Parent Id.Module')).toBe('$se_module');
        expect(apiNameOf('Tasks', 'Related To.id')).toBe('What_Id');
        expect(apiNameOf('Tasks', 'Contact Name.id')).toBe('Who_Id');
        expect(apiNameOf('Events', 'Host.id')).toBe('Owner');
        expect(apiNameOf('Events', 'From')).toBe('Start_DateTime');
        expect(apiNameOf('Calls', 'Call Duration (in seconds)')).toBe('Call_Duration_in_seconds');
        expect(apiNameOf('Emails', 'No. of Opens')).toBe('No_of_Opens');
    });

    it('turns a Contact row into the record the mapper reads: owner, lookup, flags, times, multi-line text', () => {
        const record = recordFromRow(
            'Contacts',
            {
                'Record Id': 'zcrm_5',
                'Contact Owner.id': 'zcrm_100',
                'First Name': 'Dana',
                'Last Name': 'Reyes',
                'Company Name.id': 'zcrm_7',
                Email: 'dana@acme.example',
                'Email Opt Out': 'true',
                'Created Time': '2024-02-23 19:43:53',
                'Modified Time': '2026-05-02 22:54:16',
                Description: 'line one\nline two',
                Mobile: '',
            },
            context,
        );
        expect(record).toEqual({
            id: '5',
            Owner: { id: '100', name: 'Kate Morgan', email: 'kate@pinion.example' },
            First_Name: 'Dana',
            Last_Name: 'Reyes',
            Account_Name: { id: '7' },
            Email: 'dana@acme.example',
            Email_Opt_Out: true,
            Created_Time: '2024-02-23T19:43:53+05:00',
            Modified_Time: '2026-05-02T22:54:16+05:00',
            Description: 'line one\nline two',
        });
        const mapped = mapContact(record, links);
        expect(mapped).toMatchObject({
            input: { nameFirst: 'Dana', companyId: 'local-7', emails: { primary: 'dana@acme.example' } },
            ownerEmail: 'kate@pinion.example',
        });
    });

    it('reads Deals, Notes, Tasks and Events through the mappers as the API would give them', () => {
        const deal = recordFromRow(
            'Deals',
            {
                'Record Id': 'zcrm_9',
                'Pipeline Owner.id': 'zcrm_404',
                'Pipeline Name': 'Acme release',
                Amount: '650.0',
                'Closing Date': '2024-02-28',
                Stage: 'Closed Won',
                'Company Name.id': 'zcrm_7',
                'Contact Name.id': 'zcrm_5',
            },
            context,
        );
        // An owner the export's users do not hold is still a lookup.
        expect(deal.Owner).toEqual({ id: '404' });
        expect(deal.Amount).toBe(650);
        expect(mapDeal(deal, links, 'USD')).toMatchObject({
            input: {
                name: 'Acme release',
                amount: { amountMinor: 65000, currency: 'USD' },
                closeDate: '2024-02-28',
                companyId: 'local-7',
                pointOfContactId: 'local-5',
            },
            stage: 'Closed Won',
        });
        const note = recordFromRow(
            'Notes',
            {
                'Record Id': 'zcrm_11',
                'Note Content': 'Called',
                'Parent.id': 'zcrm_9',
                'Parent Id.Module': 'Potentials',
            },
            context,
        );
        expect(mapNote(note, links)).toMatchObject({ input: { targets: [{ type: 'opportunity', id: 'local-9' }] } });
        const task = recordFromRow(
            'Tasks',
            {
                'Record Id': 'zcrm_12',
                Subject: 'Follow up',
                'Due Date': '2024-02-26',
                'Related To.id': 'zcrm_9',
                'Contact Name.id': 'zcrm_5',
                Status: 'Completed',
                'Closed Time': '2025-12-10 20:50:48',
            },
            context,
        );
        expect(mapTask(task, links)).toMatchObject({
            input: {
                status: 'done',
                dueAt: '2024-02-26T00:00:00.000Z',
                completedAt: '2025-12-10T20:50:48+05:00',
            },
        });
        const event = recordFromRow(
            'Events',
            {
                'Record Id': 'zcrm_13',
                'Host.id': 'zcrm_100',
                Title: 'Kickoff',
                Location: 'Zoom',
                From: '2026-03-03 19:00:00',
                To: '2026-03-03 20:00:00',
                'Contact Name.id': 'zcrm_5',
                'All day': 'false',
            },
            context,
        );
        expect(mapEvent(event, links, new Date('2026-04-01T00:00:00Z'))).toMatchObject({
            input: { title: 'Meeting: Kickoff', dueAt: '2026-03-03T19:00:00+05:00', status: 'done' },
            ownerEmail: 'kate@pinion.example',
        });
    });

    it("writes a local time with its zone's offset, summer time included", () => {
        expect(zonedIso('2026-05-02 22:54:16', 'Asia/Karachi')).toBe('2026-05-02T22:54:16+05:00');
        expect(zonedIso('2026-01-15 09:00:00', 'America/New_York')).toBe('2026-01-15T09:00:00-05:00');
        expect(zonedIso('2026-07-15 09:00:00', 'America/New_York')).toBe('2026-07-15T09:00:00-04:00');
        expect(zonedIso('2026-07-15 09:00:00', 'UTC')).toBe('2026-07-15T09:00:00+00:00');
    });
});

describe('BIGIN-1 export history rows', () => {
    it('gives each stage history row the stage its deal was in before, and reads moves only', () => {
        const rows: BiginRecord[] = [
            { id: '3', Deal: { id: 'd1' }, Stage: 'Second', Modified_Time: '2024-02-24T10:00:00+05:00' },
            { id: '9', Deal: { id: 'd2' }, Stage: 'First', Modified_Time: '2024-02-20T10:00:00+05:00' },
            { id: '1', Deal: { id: 'd1' }, Stage: 'First', Modified_Time: '2024-02-23T10:00:00+05:00' },
            { id: '4', Deal: { id: 'd1' }, Stage: 'Second', Modified_Time: '2024-02-25T10:00:00+05:00' },
        ];
        withPreviousStages(rows);
        expect(rows.map((r) => [r.id, r.Previous_Stage])).toEqual([
            ['1', null],
            ['3', 'First'],
            ['4', 'Second'],
            ['9', null],
        ]);
        expect(readStageHistory(rows[1]!)).toEqual({
            externalId: '3',
            dealId: 'd1',
            from: 'First',
            to: 'Second',
            at: new Date('2024-02-24T05:00:00Z'),
        });
        expect(readStageHistory(rows[2]!)).toEqual({ skip: 'not a stage change' });
    });

    it('reads an email log: its record by module, the recipients, the sender, never more than it has', () => {
        const record = recordFromRow(
            'Emails',
            {
                'Record Id': 'zcrm_21',
                'Sent By.id': 'zcrm_100',
                Subject: 'Your release',
                'Record Name.id': 'zcrm_9',
                Module: 'Potentials',
                'Sent To': 'Dana Reyes <Dana@Acme.example>, sam@acme.example',
                'Sent On': '2026-05-02 22:54:16',
                Status: 'Opened',
                'No. of Opens': '2',
                'No. of Clicks': '0',
            },
            context,
        );
        expect(readEmail(record)).toEqual({
            externalId: '21',
            record: { object: 'Deals', id: '9' },
            recipients: ['dana@acme.example', 'sam@acme.example'],
            sentBy: 'kate@pinion.example',
            at: new Date('2026-05-02T17:54:16Z'),
            entry: {
                subject: 'Your release',
                from: null,
                to: 'Dana Reyes <Dana@Acme.example>, sam@acme.example',
                cc: null,
                status: 'Opened',
                opens: 2,
                clicks: 0,
            },
        });
    });
});

describe('BIGIN-1 an export directory as the API', () => {
    let dir: string;
    const header = 'Record Id,Company Owner.id,Company Name,Created Time,Modified Time';
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'bigin-export-'));
        mkdirSync(join(dir, 'Data'));
        mkdirSync(join(dir, 'Metadata'));
        writeFileSync(join(dir, 'Metadata', 'BackupDetails.properties'), 'VERSION=1.0\nTIMEZONE=Asia/Karachi\n');
        writeFileSync(
            join(dir, 'Data', 'Users_001.csv'),
            'Record Id,First Name,Last Name,Email\nzcrm_100,Kate,Morgan,kate@pinion.example\n',
        );
        // Two files, read in their number's order; a module sorted oldest modification first.
        const row = (n: number, minute: number) =>
            `zcrm_${n},zcrm_100,Company ${n},2024-01-01 00:00:00,2024-01-01 00:${String(minute).padStart(2, '0')}:00`;
        writeFileSync(join(dir, 'Data', 'Companies_002.csv'), [header, row(3, 30), row(4, 10)].join('\n'));
        writeFileSync(join(dir, 'Data', 'Companies_001.csv'), [header, row(1, 20), row(2, 40)].join('\n'));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('lists a module across its files by modification, honours since, counts it and lists no deletions', async () => {
        const source = await BiginExport.open(dir);
        expect(source.timeZone).toBe('Asia/Karachi');
        expect(await source.count(connection, 'Accounts')).toBe(4);
        const all = await source.list(connection, 'Accounts', { since: null, page: 1 });
        expect(all.records.map((r) => r.id)).toEqual(['4', '1', '3', '2']);
        expect(all.records[0]!.Owner).toEqual({ id: '100', name: 'Kate Morgan', email: 'kate@pinion.example' });
        expect(all.moreRecords).toBe(false);
        const since = await source.list(connection, 'Accounts', { since: '2024-01-01T00:30:00+05:00', page: 1 });
        expect(since.records.map((r) => r.id)).toEqual(['3', '2']);
        expect(await source.deleted()).toEqual({ records: [], moreRecords: false });
        await expect(source.modules()).rejects.toThrow(/not available from a Bigin export/);
    });

    it('takes the Data directory itself, a zone given in place of the backup’s, and refuses a directory that is no export', async () => {
        expect((await BiginExport.open(join(dir, 'Data'), { timeZone: 'UTC' })).timeZone).toBe('UTC');
        await expect(BiginExport.open(join(dir, 'Metadata'), { timeZone: 'Not/AZone' })).rejects.toThrow();
        await expect(BiginExport.open(tmpdir() + '/no-such-export')).rejects.toThrow(/no Bigin export/);
    });
});
