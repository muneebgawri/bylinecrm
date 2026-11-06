import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    type BiginImportObjectReport,
    type BiginImportPhase,
    type BiginImportRunView,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { BiginExportImport } from '../../src/bigin-import/export-run';
import { BiginImportRunner } from '../../src/bigin-import/import-runner';
import { ENV, parseEnv } from '../../src/config/env';
import { PrismaService } from '../../src/infra/prisma.service';
import { verifyAddress } from '../support/mail';

interface Browser {
    cookie: string;
    csrf: string;
}

function browserFrom(res: Response): Browser {
    const raw = res.headers['set-cookie'] as string[] | undefined;
    const session = raw?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
    const csrf = raw
        ?.find((c) => c.startsWith(`${CSRF_COOKIE}=`))
        ?.split(';')[0]
        ?.split('=')[1];
    if (!session || !csrf) throw new Error('login did not set both cookies');
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

interface TimelineEntry {
    kind: string;
    happenedAt: string;
    actor: { kind: string };
    target: { type: string; id: string };
    properties: Record<string, unknown>;
}

/** A CSV file as Bigin's export writes it: a header of display labels, every cell quoted. */
function csv(header: string[], rows: Record<string, string>[]): string {
    const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
    return [header.map(cell).join(','), ...rows.map((r) => header.map((h) => cell(r[h] ?? '')).join(','))].join('\r\n');
}

/**
 * BIGIN-1: a workspace imported from a Bigin backup export (CSV files) instead of the API — the same runner, run
 * row, links and report (`source: 'export'`), then each deal's stage history and the logged emails onto the
 * timelines. A second run updates and adds nothing twice; another workspace sees none of it; one run at a time.
 */
describe('FR-CRMS-25 BIGIN-1 Bigin export import', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let exports: BiginExportImport;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const adminEmail = `export-admin-${stamp}@example.com`;
    const otherEmail = `export-other-${stamp}@example.com`;
    let admin: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let adminMemberId: string;
    let dir: string;
    let first: BiginImportRunView;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const reportOf = (run: BiginImportRunView, phase: BiginImportPhase): BiginImportObjectReport =>
        run.report.find((r) => r.object === phase)!;
    const local = async (object: string, externalId: string, ws = workspace) =>
        (
            await owner.biginImportLink.findUnique({
                where: { workspaceId_object_externalId: { workspaceId: ws, object, externalId } },
            })
        )?.localId ?? null;
    const timeline = async (target: string, kinds: string): Promise<TimelineEntry[]> => {
        const res = await as(admin).get(w(`/timeline?target=${target}&kinds=${kinds}&limit=100`));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return (res.body as { items: TimelineEntry[] }).items;
    };

    // Synthetic Bigin ids, as the export writes them (`zcrm_` + the record's number).
    const id = (n: number) => `zcrm_${n}`;
    const KATE = 100;
    const ACME = 200;
    const DANA = 300;
    const SAM = 301;
    const DEAL = 400;
    const NOTE = 500;
    const TASK = 600;

    beforeAll(async () => {
        const env = { ...parseEnv(process.env), SIGNUP_MODE: 'open' as const };
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(ENV)
            .useValue(env)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        exports = app.get(BiginExportImport);
        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Export ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other export ${stamp}`));
        adminMemberId = ((await as(admin).get(w('/me'))).body as { memberId: string }).memberId;

        dir = mkdtempSync(join(tmpdir(), 'bigin-export-spec-'));
        const data = join(dir, 'Data');
        mkdirSync(data);
        mkdirSync(join(dir, 'Metadata'));
        writeFileSync(join(dir, 'Metadata', 'BackupDetails.properties'), 'VERSION=1.0\nTIMEZONE=Asia/Karachi\n');
        const write = (file: string, header: string[], rows: Record<string, string>[]) =>
            writeFileSync(join(data, file), csv(header, rows));
        // The owner is the workspace's admin by address: the import makes them the records' owner.
        write(
            'Users_001.csv',
            ['Record Id', 'First Name', 'Last Name', 'Email'],
            [{ 'Record Id': id(KATE), 'First Name': 'Kate', 'Last Name': 'Admin', Email: adminEmail }],
        );
        write(
            'Companies_001.csv',
            ['Record Id', 'Company Owner.id', 'Company Name', 'Website', 'Created Time', 'Modified Time'],
            [
                {
                    'Record Id': id(ACME),
                    'Company Owner.id': id(KATE),
                    'Company Name': 'Acme Export',
                    Website: `https://acme-${stamp}.example`,
                    'Created Time': '2024-01-05 10:00:00',
                    'Modified Time': '2024-01-05 10:00:00',
                },
            ],
        );
        const contactHeader = [
            'Record Id',
            'Contact Owner.id',
            'First Name',
            'Last Name',
            'Company Name.id',
            'Email',
            'Description',
            'Email Opt Out',
            'Created Time',
            'Modified Time',
            'PR LINK',
        ];
        const contact = (n: number, first: string, minute: string) => ({
            'Record Id': id(n),
            'Contact Owner.id': id(KATE),
            'First Name': first,
            'Last Name': 'Export',
            'Company Name.id': id(ACME),
            Email: `${first.toLowerCase()}-${stamp}@acme.example`,
            Description: 'First line\nsecond line, with "quotes"',
            'Email Opt Out': 'false',
            'Created Time': '2024-01-06 10:00:00',
            'Modified Time': `2024-01-06 10:${minute}:00`,
            'PR LINK': '',
        });
        // Two files of one module, read in order.
        write('Contacts_001.csv', contactHeader, [contact(DANA, 'Dana', '00')]);
        write('Contacts_002.csv', contactHeader, [contact(SAM, 'Sam', '05')]);
        write(
            'Pipelines_001.csv',
            [
                'Record Id',
                'Pipeline Owner.id',
                'Amount',
                'Pipeline Name',
                'Closing Date',
                'Company Name.id',
                'Stage',
                'Contact Name.id',
                'Created Time',
                'Modified Time',
                'Pipeline',
            ],
            [
                {
                    'Record Id': id(DEAL),
                    'Pipeline Owner.id': id(KATE),
                    Amount: '650.0',
                    'Pipeline Name': 'Acme release',
                    'Closing Date': '2024-02-28',
                    'Company Name.id': id(ACME),
                    Stage: 'Contacted',
                    'Contact Name.id': id(DANA),
                    'Created Time': '2024-01-07 10:00:00',
                    'Modified Time': '2024-01-09 10:00:00',
                    Pipeline: 'Sales Pipeline Standard',
                },
            ],
        );
        write(
            'Notes_001.csv',
            [
                'Record Id',
                'Note Owner.id',
                'Note Title',
                'Note Content',
                'Parent.id',
                'Parent Id.Module',
                'Created Time',
                'Modified Time',
            ],
            [
                {
                    'Record Id': id(NOTE),
                    'Note Owner.id': id(KATE),
                    'Note Title': 'Call',
                    'Note Content': 'Spoke to Dana,\nshe wants a quote',
                    'Parent.id': id(DEAL),
                    'Parent Id.Module': 'Potentials',
                    'Created Time': '2024-01-08 10:00:00',
                    'Modified Time': '2024-01-08 10:00:00',
                },
            ],
        );
        write(
            'Tasks_001.csv',
            [
                'Record Id',
                'Task Owner.id',
                'Subject',
                'Due Date',
                'Contact Name.id',
                'Related To.id',
                'Status',
                'Priority',
                'Created Time',
                'Modified Time',
                'Closed Time',
            ],
            [
                {
                    'Record Id': id(TASK),
                    'Task Owner.id': id(KATE),
                    Subject: 'Send the quote',
                    'Due Date': '2024-01-10',
                    'Contact Name.id': id(DANA),
                    'Related To.id': id(DEAL),
                    Status: 'In Progress',
                    Priority: 'High',
                    'Created Time': '2024-01-08 11:00:00',
                    'Modified Time': '2024-01-08 11:00:00',
                },
            ],
        );
        write('Events_001.csv', ['Record Id', 'Host.id', 'Title', 'From', 'To', 'Modified Time'], []);
        write('Calls_001.csv', ['Record Id', 'Call Owner.id', 'Subject', 'Modified Time'], []);
        const historyHeader = [
            'Record Id',
            'Pipeline Name.id',
            'Stage',
            'Modified By.id',
            'Modified Time',
            'Amount',
            'Moved To',
        ];
        // Across two files and out of order: the deal started New, moved to Contacted; an amount change in between.
        write('Stage History_001.csv', historyHeader, [
            {
                'Record Id': id(702),
                'Pipeline Name.id': id(DEAL),
                Stage: 'Contacted',
                'Modified Time': '2024-01-09 10:00:00',
                Amount: '650.0',
            },
            {
                'Record Id': id(700),
                'Pipeline Name.id': id(DEAL),
                Stage: 'New',
                'Modified Time': '2024-01-07 10:00:00',
                'Moved To': 'Contacted',
            },
        ]);
        write('Stage History_002.csv', historyHeader, [
            {
                'Record Id': id(703),
                'Pipeline Name.id': id(DEAL),
                Stage: 'Contacted',
                'Modified Time': '2024-01-09 12:00:00',
                Amount: '700.0',
            },
            // A deal that is not in the export's deals: skipped.
            { 'Record Id': id(704), 'Pipeline Name.id': id(999), Stage: 'New', 'Modified Time': '2024-01-09 12:00:00' },
        ]);
        const emailHeader = [
            'Record Id',
            'Sent By.id',
            'Subject',
            'Record Name.id',
            'Module',
            'Sent To',
            'Sent On',
            'Status',
            'Cc',
            'Sender',
            'No. of Opens',
            'No. of Clicks',
        ];
        write('Emails_001.csv', emailHeader, [
            {
                'Record Id': id(800),
                'Sent By.id': id(KATE),
                Subject: 'Intro',
                'Record Name.id': id(DANA),
                Module: 'Contacts',
                'Sent To': `dana-${stamp}@acme.example`,
                'Sent On': '2024-01-06 21:15:00',
                Status: 'Opened',
                Sender: adminEmail,
                'No. of Opens': '3',
                'No. of Clicks': '1',
            },
        ]);
        write('Emails_002.csv', emailHeader, [
            {
                'Record Id': id(801),
                'Sent By.id': id(KATE),
                Subject: 'Your quote',
                'Record Name.id': id(DEAL),
                Module: 'Potentials',
                'Sent To': `Sam <sam-${stamp}@acme.example>`,
                'Sent On': '2024-01-08 22:00:00',
                Status: 'Sent',
                Sender: adminEmail,
                'No. of Opens': '0',
                'No. of Clicks': '0',
            },
            {
                'Record Id': id(802),
                Subject: 'Lost',
                'Record Name.id': id(998),
                Module: 'Contacts',
                'Sent To': 'nobody@else.example',
                'Sent On': '2024-01-08 22:00:00',
                Status: 'Bounced',
            },
        ]);

        first = await exports.run(workspace, dir);
    });

    afterAll(async () => {
        rmSync(dir, { recursive: true, force: true });
        await app.close();
    });

    it('runs the modules through the API importer, recording the run as read from an export', () => {
        expect(first.status, first.error ?? '').toBe('succeeded');
        expect(first.source).toBe('export');
        expect(first.mode).toBe('full');
        expect(first.report.map((r) => r.object)).toEqual([
            'Accounts',
            'Contacts',
            'Deals',
            'Notes',
            'Tasks',
            'Events',
            'Calls',
            'StageHistory',
            'Emails',
        ]);
        expect(reportOf(first, 'Accounts')).toMatchObject({ remote: 1, read: 1, created: 1, failed: 0 });
        expect(reportOf(first, 'Contacts')).toMatchObject({ remote: 2, read: 2, created: 2, failed: 0 });
        expect(reportOf(first, 'Deals')).toMatchObject({ remote: 1, read: 1, created: 1, failed: 0 });
        expect(reportOf(first, 'Notes')).toMatchObject({ read: 1, created: 1, failed: 0 });
        expect(reportOf(first, 'Tasks')).toMatchObject({ read: 1, created: 1, failed: 0 });
        expect(reportOf(first, 'StageHistory')).toMatchObject({ remote: 4, read: 4, created: 2, skipped: 2, after: 2 });
        expect(reportOf(first, 'Emails')).toMatchObject({ remote: 3, read: 3, created: 2, skipped: 1, failed: 0 });
    });

    it('creates the records with their links, owners, Bigin dates and the fields read from the CSV', async () => {
        const companyId = await local('Accounts', '200');
        const danaId = await local('Contacts', '300');
        const dealId = await local('Deals', '400');
        expect(companyId && danaId && dealId).toBeTruthy();
        expect(await local('Notes', '500')).toBeTruthy();
        expect(await local('Tasks', '600')).toBeTruthy();
        const dana = await owner.person.findUniqueOrThrow({ where: { id: danaId! } });
        expect(dana).toMatchObject({ nameFirst: 'Dana', companyId, ownerId: adminMemberId, source: 'bigin' });
        // Bigin's creation time, local in the backup's zone (Asia/Karachi, +05:00).
        expect(dana.createdAt.toISOString()).toBe('2024-01-06T05:00:00.000Z');
        expect((dana.custom as Record<string, unknown>).description).toBe('First line\nsecond line, with "quotes"');
        const deal = await owner.opportunity.findUniqueOrThrow({
            where: { id: dealId! },
            include: { stage: { select: { name: true } } },
        });
        expect(deal).toMatchObject({ name: 'Acme release', amountMinor: 65000n, companyId, pointOfContactId: danaId });
        expect(deal.stage.name).toBe('Contacted');
        const note = await owner.noteTarget.findFirst({ where: { targetType: 'opportunity', targetId: dealId! } });
        expect(note).not.toBeNull();
    });

    it("puts each stage move on the deal's timeline once, at Bigin's time, in the stage writer's shape", async () => {
        const dealId = await local('Deals', '400');
        const stages = new Map(
            (
                await owner.pipelineStage.findMany({ where: { pipeline: { workspaceId: workspace, isDefault: true } } })
            ).map((s) => [s.name, s.id]),
        );
        const moves = (await timeline(`opportunity:${dealId}`, 'deal.')).filter((e) => e.actor.kind === 'import');
        const imported = moves.filter((e) => e.properties['bigin']);
        expect(imported.map((e) => [e.happenedAt, e.properties['diff']])).toEqual([
            ['2024-01-09T05:00:00.000Z', { stageId: { from: stages.get('New'), to: stages.get('Contacted') } }],
            ['2024-01-07T05:00:00.000Z', { stageId: { from: null, to: stages.get('New') } }],
        ]);
        expect(imported.every((e) => e.kind === 'deal.stage_changed')).toBe(true);
        expect(imported[0]!.properties['bigin']).toEqual({ from: 'New', to: 'Contacted' });
    });

    it('puts each logged email on its record, and a deal’s on the contact it went to, once each', async () => {
        const danaId = await local('Contacts', '300');
        const samId = await local('Contacts', '301');
        const dealId = await local('Deals', '400');
        const danaMail = await timeline(`person:${danaId}`, 'external.email');
        expect(danaMail).toHaveLength(1);
        expect(danaMail[0]).toMatchObject({
            happenedAt: '2024-01-06T16:15:00.000Z',
            actor: { kind: 'import' },
            properties: {
                email: {
                    subject: 'Intro',
                    from: adminEmail,
                    to: `dana-${stamp}@acme.example`,
                    status: 'Opened',
                    opens: 3,
                    clicks: 1,
                    sentByMemberId: adminMemberId,
                },
            },
        });
        const dealMail = await timeline(`opportunity:${dealId}`, 'external.email');
        expect(dealMail.map((e) => (e.properties['email'] as { subject: string }).subject)).toEqual(['Your quote']);
        const samMail = await timeline(`person:${samId}`, 'external.email');
        expect(samMail.map((e) => (e.properties['email'] as { subject: string }).subject)).toEqual(['Your quote']);
        // Each is a contact attempt on the person it went to, re-derived as it is imported.
        const dana = await owner.person.findUniqueOrThrow({ where: { id: danaId } });
        expect(dana).toMatchObject({ contactAttempts: 1, lastContactedAt: new Date('2024-01-06T16:15:00.000Z') });
        expect(await owner.person.findUniqueOrThrow({ where: { id: samId } })).toMatchObject({ contactAttempts: 1 });
    });

    it('a second run updates rather than duplicates, and adds no history twice', async () => {
        const counts = async () => ({
            links: await owner.biginImportLink.count({ where: { workspaceId: workspace } }),
            people: await owner.person.count({ where: { workspaceId: workspace } }),
            deals: await owner.opportunity.count({ where: { workspaceId: workspace } }),
            imported: await owner.timelineActivity.count({ where: { workspaceId: workspace, source: 'bigin' } }),
        });
        const before = await counts();
        expect(before.imported).toBe(5);
        const again = await exports.run(workspace, dir);
        expect(again.status, again.error ?? '').toBe('succeeded');
        expect(again.id).not.toBe(first.id);
        for (const phase of ['Accounts', 'Contacts', 'Deals', 'Notes', 'Tasks'] as const) {
            expect(reportOf(again, phase), phase).toMatchObject({ created: 0, merged: 0, failed: 0 });
        }
        expect(reportOf(again, 'StageHistory')).toMatchObject({ created: 0, unchanged: 2, before: 2, after: 2 });
        expect(reportOf(again, 'Emails')).toMatchObject({ created: 0, unchanged: 2 });
        expect(await counts()).toEqual(before);
    });

    it('runs one at a time, and leaves an export run to its CLI, never a worker', async () => {
        // A queued export run that no CLI holds: the runner (as a worker would call it) leaves it as it is.
        const exported = await owner.biginImportRun.create({
            data: { workspaceId: otherWorkspace, mode: 'full', source: 'export' },
        });
        await app.get(BiginImportRunner).run(exported.id);
        expect((await owner.biginImportRun.findUniqueOrThrow({ where: { id: exported.id } })).status).toBe('queued');
        const close = (runId: string) =>
            owner.biginImportRun.update({
                where: { id: runId },
                data: { status: 'cancelled', finishedAt: new Date() },
            });
        await close(exported.id);
        // An API run open in the workspace: an export run is refused, and nothing is read or written.
        const api = await owner.biginImportRun.create({ data: { workspaceId: otherWorkspace, mode: 'changes' } });
        await expect(exports.run(otherWorkspace, dir)).rejects.toThrow(/already queued or running/);
        await close(api.id);
    });

    it('another workspace sees none of it', async () => {
        expect(await owner.biginImportLink.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
        const people = await as(otherAdmin).get(w('/people?limit=100', otherWorkspace));
        expect(people.status).toBe(200);
        expect((people.body as { items: unknown[] }).items).toHaveLength(0);
        const feed = await as(otherAdmin).get(w('/timeline?limit=100', otherWorkspace));
        expect(feed.status).toBe(200);
        const kinds = (feed.body as { items: TimelineEntry[] }).items.map((e) => e.kind);
        expect(kinds.filter((k) => k === 'external.email' || k === 'deal.stage_changed')).toEqual([]);
        // Reading the importing workspace's deal from the other workspace finds nothing.
        const dealId = await local('Deals', '400');
        const cross = await as(otherAdmin).get(w(`/timeline?target=opportunity:${dealId}`, otherWorkspace));
        expect(cross.status).toBe(404);
        const runs = await as(otherAdmin).get(w('/import/bigin/runs', otherWorkspace));
        expect((runs.body as BiginImportRunView[]).map((r) => r.id)).not.toContain(first.id);
    });
});
