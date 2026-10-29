import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, type TwentyImportRunView } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { BiginReuseReconciler, printReconcileReport, type ReuseLogRow } from '../../src/bigin-import/reuse-reconciler';
import { ENV, parseEnv } from '../../src/config/env';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { TwentyImportRunner } from '../../src/twenty-import/import-runner';
import { FakeBigin } from '../support/fake-bigin';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { FakeTwenty } from '../support/fake-twenty';
import { verifyAddress } from '../support/mail';
import { settle } from '../support/outbox';

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

/**
 * The historical reconcile of reused Bigin Contacts (FR-CRMS-26) against fake Twenty and Bigin: a person the old
 * Bigin → Twenty job mixed (the new name over the old address) is split — the earlier person gets back their
 * address with the notes and deals made while they were the Contact, the holder becomes who the Contact holds now,
 * mail re-links by address on its own — a name-only change goes to review, a second run changes nothing, and another
 * workspace is untouched.
 */
describe('FR-CRMS-26 reconcile reused Bigin contacts', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let reconciler: BiginReuseReconciler;
    const twenty = new FakeTwenty();
    const bigin = new FakeBigin();
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const oldAddress = `support-${stamp}@pressreleasesubmit.example`;
    const newAddress = `kim-${stamp}@gifford.example`;
    const chrisAddress = `chris-${stamp}@acme.example`;
    let workspace: string;
    let otherWorkspace: string;
    let admin: Browser;
    let holderId: string;
    let chrisId: string;
    let participantId: string;
    const local: Record<'earlyNote' | 'lateNote' | 'earlyDeal', string> = {
        earlyNote: '',
        lateNote: '',
        earlyDeal: '',
    };
    let logs: ReuseLogRow[];
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });

    beforeAll(async () => {
        await twenty.start();
        await bigin.start();
        const env = { ...parseEnv(process.env), SIGNUP_MODE: 'open' as const };
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(ENV)
            .useValue(env)
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        reconciler = app.get(BiginReuseReconciler);
        const signUp = async (email: string, name: string) => {
            const res = await http()
                .post('/api/auth/signup')
                .send({ email, password: 'correct horse battery staple', workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, id: workspace } = await signUp(`reuse-admin-${stamp}@example.com`, `Reuse ${stamp}`));
        ({ id: otherWorkspace } = await signUp(`reuse-other-${stamp}@example.com`, `Reuse other ${stamp}`));

        // Bigin holds the Contacts as they are now.
        const [kim, chris] = bigin.seed('Contacts', [
            { First_Name: 'Kim', Last_Name: 'Gifford', Email: newAddress },
            { First_Name: 'Chris', Last_Name: 'Newname', Email: chrisAddress },
        ]);
        // Twenty, as the old job left it: Kim's name over the first person's address.
        const [mixed, renamed] = twenty.seed('people', [
            {
                name: { firstName: 'Kim', lastName: 'Gifford' },
                emails: { primaryEmail: oldAddress, additionalEmails: [] },
                biginrecordid: `zcrm_${kim!.id}`,
            },
            {
                name: { firstName: 'Chris', lastName: 'Newname' },
                emails: { primaryEmail: chrisAddress, additionalEmails: [] },
                biginrecordid: `zcrm_${chris!.id}`,
            },
        ]);
        const [early, late] = twenty.seed('notes', [
            {
                title: 'Release booked',
                bodyV2: { markdown: 'with Press release Submit' },
                noteTargets: [{ targetPersonId: mixed!.id }],
                createdAt: '2026-01-05T00:00:00.000Z',
            },
            {
                title: 'Kim called',
                bodyV2: { markdown: 'with Kim' },
                noteTargets: [{ targetPersonId: mixed!.id }],
                createdAt: '2026-06-01T00:00:00.000Z',
            },
        ]);
        const [deal] = twenty.seed('opportunities', [
            {
                name: 'Submit release',
                stage: 'NEW',
                pointOfContactId: mixed!.id,
                createdAt: '2026-01-06T00:00:00.000Z',
            },
        ]);
        twenty.seed('timelineActivities', [
            {
                name: 'person.updated',
                happensAt: '2026-03-01T00:00:00.000Z',
                personId: mixed!.id,
                properties: {
                    diff: {
                        name: {
                            before: { firstName: 'Press release', lastName: 'Submit' },
                            after: { firstName: 'Kim', lastName: 'Gifford' },
                        },
                    },
                },
            },
            {
                name: 'person.updated',
                happensAt: '2026-02-01T00:00:00.000Z',
                personId: renamed!.id,
                properties: {
                    diff: {
                        name: {
                            before: { firstName: 'Chris', lastName: 'Oldname' },
                            after: { firstName: 'Chris', lastName: 'Newname' },
                        },
                    },
                },
            },
            { name: 'note.created', happensAt: '2026-01-05T00:00:00.000Z', personId: mixed!.id, properties: {} },
        ]);
        logs = [
            { biginId: kim!.id, ts: '2026-03-02T00:00:00Z', email: newAddress, firstName: 'Kim', lastName: 'Gifford' },
        ];

        // BylineCRM imported the mixed rows from Twenty, and is connected to Bigin.
        expect(
            (await as(admin).put(w('/import/twenty/settings')).send({ baseUrl: twenty.baseUrl, apiKey: twenty.apiKey }))
                .status,
        ).toBe(200);
        const started = await as(admin).post(w('/import/twenty/runs')).send({ mode: 'full' });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        await app.get(TwentyImportRunner).run((started.body as TwentyImportRunView).id);
        const link = (object: string, externalId: string) =>
            owner.twentyImportLink.findUniqueOrThrow({
                where: { workspaceId_object_externalId: { workspaceId: workspace, object, externalId } },
            });
        holderId = (await link('people', mixed!.id)).localId;
        chrisId = (await link('people', renamed!.id)).localId;
        local.earlyNote = (await link('notes', early!.id)).localId;
        local.lateNote = (await link('notes', late!.id)).localId;
        local.earlyDeal = (await link('opportunities', deal!.id)).localId;
        expect(
            (
                await as(admin).put(w('/import/bigin/settings')).send({
                    accountsUrl: bigin.url,
                    apiUrl: bigin.url,
                    clientId: bigin.clientId,
                    clientSecret: bigin.clientSecret,
                    refreshToken: bigin.refreshToken,
                })
            ).status,
        ).toBe(200);

        // A message from the first person's address, filed on the mixed record.
        const thread = await owner.mailThread.create({
            data: { workspaceId: workspace, subject: 'Release', lastMessageAt: new Date('2026-01-04T00:00:00Z') },
        });
        const message = await owner.mailMessage.create({
            data: {
                workspaceId: workspace,
                threadId: thread.id,
                identityKey: `reuse-${stamp}`,
                direction: 'inbound',
                fromAddress: oldAddress,
                sentAt: new Date('2026-01-04T00:00:00Z'),
                subject: 'Release',
            },
        });
        participantId = (
            await owner.mailParticipant.create({
                data: {
                    workspaceId: workspace,
                    messageId: message.id,
                    role: 'from',
                    address: oldAddress,
                    personId: holderId,
                },
            })
        ).id;
        await settle(app);
    });

    afterAll(async () => {
        await app?.close();
        await twenty.close();
        await bigin.close();
    });

    const targetsOf = async (noteId: string) =>
        (await owner.noteTarget.findMany({ where: { noteId } })).map((t) => t.targetId);

    it('a dry run reports the split exactly and changes nothing; a name-only change is for review', async () => {
        const report = await reconciler.reconcile(workspace, { apply: false, logs });
        expect(report.totals).toEqual({
            contactsSplit: 1,
            peopleCreated: 1,
            peopleMatched: 0,
            holdersUpdated: 1,
            notesMoved: 1,
            tasksMoved: 0,
            dealsMoved: 1,
            alreadyReconciled: 0,
            review: 1,
        });
        expect(report.review).toEqual([
            expect.objectContaining({ holderId: chrisId, reason: expect.stringContaining('same address') }),
        ]);
        const lines: string[] = [];
        printReconcileReport(report, (line) => lines.push(line));
        expect(lines.at(-1)).toContain('would change (dry run): contacts split 1, people created 1');
        expect(lines.join('\n')).toContain(`Press release Submit <${oldAddress}>`);
        expect(await owner.person.findUniqueOrThrow({ where: { id: holderId } })).toMatchObject({
            emailPrimary: oldAddress,
        });
        expect(await owner.person.count({ where: { workspaceId: workspace, emailPrimary: newAddress } })).toBe(0);
        expect(await owner.biginContactReuse.count({ where: { workspaceId: workspace } })).toBe(0);
    });

    it('without Twenty (its data gone, its connection still stored): Twenty is not asked; the logs and Bigin decide', async () => {
        const asked = twenty.requests.length;
        const lines: string[] = [];
        const report = await reconciler.reconcile(workspace, {
            apply: false,
            logs,
            twenty: false,
            progress: (line) => lines.push(line),
        });
        expect(twenty.requests.length).toBe(asked);
        expect(lines).toContain('Twenty not read: the logs and Bigin only');
        // A dry run: whatever the logs and Bigin alone show is reported, and nothing is written.
        expect(report.applied).toBe(false);
        expect(await owner.biginContactReuse.count({ where: { workspaceId: workspace } })).toBe(0);
    });

    it('applied: the earlier person gets back their address, the notes and deals from before the change, and a note; the holder becomes the latest person; mail follows the address', async () => {
        const report = await reconciler.reconcile(workspace, { apply: true, logs });
        expect(report.totals).toMatchObject({ contactsSplit: 1, peopleCreated: 1, notesMoved: 1, dealsMoved: 1 });
        const holder = await owner.person.findUniqueOrThrow({ where: { id: holderId } });
        expect(holder).toMatchObject({ nameFirst: 'Kim', nameLast: 'Gifford', emailPrimary: newAddress });
        const earlier = await owner.person.findFirstOrThrow({
            where: { workspaceId: workspace, emailPrimary: oldAddress },
        });
        expect(earlier).toMatchObject({
            nameFirst: 'Press release',
            nameLast: 'Submit',
            source: 'Bigin (reused contact)',
            ownerId: holder.ownerId,
        });
        expect(await targetsOf(local.earlyNote)).toEqual([earlier.id]);
        expect(await targetsOf(local.lateNote)).toEqual([holderId]);
        expect((await owner.opportunity.findUniqueOrThrow({ where: { id: local.earlyDeal } })).pointOfContactId).toBe(
            earlier.id,
        );
        const explained = await owner.noteTarget.findMany({
            where: { targetType: 'person', targetId: earlier.id },
            include: { note: true },
        });
        expect(explained.map((t) => t.note.bodyText).join('\n')).toContain('then was reused for Kim Gifford');
        expect(await owner.biginContactReuse.findMany({ where: { workspaceId: workspace } })).toEqual([
            expect.objectContaining({
                previousPersonId: earlier.id,
                newPersonId: holderId,
                source: 'reconcile',
                detectedAt: new Date('2026-03-01T00:00:00Z'),
                before: { name: 'Press release Submit', email: oldAddress },
                after: { name: 'Kim Gifford', email: newAddress },
            }),
        ]);
        // The events went through the outbox: the mail sync re-points the message to whoever has the address now.
        await settle(app);
        expect((await owner.mailParticipant.findUniqueOrThrow({ where: { id: participantId } })).personId).toBe(
            earlier.id,
        );
        expect(await owner.person.findUniqueOrThrow({ where: { id: chrisId } })).toMatchObject({
            nameLast: 'Newname',
            emailPrimary: chrisAddress,
        });
    });

    it('a second run changes nothing', async () => {
        const people = await owner.person.count({ where: { workspaceId: workspace } });
        const report = await reconciler.reconcile(workspace, { apply: true, logs });
        expect(report.totals).toEqual({
            contactsSplit: 0,
            peopleCreated: 0,
            peopleMatched: 0,
            holdersUpdated: 0,
            notesMoved: 0,
            tasksMoved: 0,
            dealsMoved: 0,
            alreadyReconciled: 1,
            review: 1,
        });
        expect(await owner.person.count({ where: { workspaceId: workspace } })).toBe(people);
        expect(await owner.biginContactReuse.count({ where: { workspaceId: workspace } })).toBe(1);
    });

    it('another workspace is untouched, and has nothing to reconcile', async () => {
        expect(await owner.person.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
        expect(await owner.biginContactReuse.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
        const report = await reconciler.reconcile(otherWorkspace, { apply: true, logs });
        expect(report.totals.contactsSplit).toBe(0);
        expect(report.contacts).toEqual([]);
        expect(await owner.person.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
    });

    it('reads every Bigin Contact past a bulk edit: more than 2,000 in one second, by page token', async () => {
        const second = new Date().toISOString();
        bigin.seed(
            'Contacts',
            Array.from({ length: 2_100 }, (_, i) => ({
                First_Name: 'Bulk',
                Last_Name: `${i}`,
                Email: `bulk-${i}@reconcile.example`,
                Modified_Time: second,
                Created_Time: second,
            })),
        );
        const lines: string[] = [];
        const report = await reconciler.reconcile(workspace, {
            apply: false,
            logs,
            twenty: false,
            progress: (line) => lines.push(line),
        });
        expect(report.applied).toBe(false);
        const read = Math.max(
            ...lines
                .filter((l) => l.startsWith('Bigin Contacts: '))
                .map((l) => Number(l.slice('Bigin Contacts: '.length))),
        );
        expect(read).toBeGreaterThanOrEqual(2_100);
        expect(bigin.requests.some((r) => r.path.includes('page_token='))).toBe(true);
    }, 300_000);
});
