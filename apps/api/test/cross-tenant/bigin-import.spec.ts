import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    SYSTEM_ROLES,
    type BiginContactReuseView,
    type BiginImportMissingView,
    type BiginImportMode,
    type BiginImportObject,
    type BiginImportObjectReport,
    type BiginImportOverview,
    type BiginImportRunView,
    type BiginImportSettingsView,
    type BiginStageApplyView,
    type BiginStageMapView,
    type TwentyImportRunView,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { BiginImportWorkers } from '../../src/bigin-import/bigin-import.workers';
import { BiginImportRunner } from '../../src/bigin-import/import-runner';
import { BiginStageApplier } from '../../src/bigin-import/stage-apply';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { ENV, parseEnv } from '../../src/config/env';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { TwentyImportRunner } from '../../src/twenty-import/import-runner';
import { FakeBigin } from '../support/fake-bigin';
import { settle } from '../support/outbox';
import { PeopleDedupe } from '../../src/records/people-dedupe.service';
import { TaskNotificationsService } from '../../src/notifications/task-notifications.service';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { FakeTwenty } from '../support/fake-twenty';
import { deliverMail, mailTo, verifyAddress } from '../support/mail';

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

interface Listed<T> {
    items: T[];
}
interface PersonRow {
    id: string;
    nameFirst: string;
    nameLast: string;
    emails: { primary: string | null };
    jobTitle: string | null;
    source: string | null;
    ownerId: string | null;
    companyId: string | null;
    custom: Record<string, unknown>;
}
interface CompanyRow {
    id: string;
    name: string;
    domain: string | null;
    ownerId: string | null;
}

/**
 * The Bigin importer (BIGIN-1, FR-CRMS-25) end to end against a fake Zoho Bigin: the connection (the client
 * secret and refresh token sealed, never shown), a run that maps every module by its Bigin id — merging into
 * what BylineCRM has (a company by registrable domain, a person by address, a record the Twenty importer made
 * from the same Bigin record) — owners by email on create only, stages by name, local edits kept, Bigin's
 * deletions flagged for review, reused Contacts never overwriting a person, the cursor, the schedule, and one
 * workspace never seeing another's.
 */
describe('FR-CRMS-25 BIGIN-1 Bigin importer', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let runner: BiginImportRunner;
    let workers: BiginImportWorkers;
    const bigin = new FakeBigin();
    const twenty = new FakeTwenty();
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const adminEmail = `bigin-admin-${stamp}@example.com`;
    const memberEmail = `bigin-member-${stamp}@example.com`;
    const otherEmail = `bigin-other-${stamp}@example.com`;
    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let adminMemberId: string;
    let memberMemberId: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const ownerOf = (email: string) => ({ name: 'Owner', id: '9000', email });
    const connection = () => ({
        accountsUrl: bigin.url,
        apiUrl: bigin.url,
        clientId: bigin.clientId,
        clientSecret: bigin.clientSecret,
        refreshToken: bigin.refreshToken,
    });

    const reportOf = (run: BiginImportRunView, object: BiginImportObject): BiginImportObjectReport =>
        run.report.find((r) => r.object === object)!;
    const counts = (r: BiginImportObjectReport) => ({
        read: r.read,
        created: r.created,
        updated: r.updated,
        unchanged: r.unchanged,
        merged: r.merged,
        skipped: r.skipped,
        failed: r.failed,
    });

    async function runToEnd(mode: BiginImportMode, who = admin, ws = workspace): Promise<BiginImportRunView> {
        const res = await as(who).post(w('/import/bigin/runs', ws)).send({ mode });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        const queued = res.body as BiginImportRunView;
        await runner.run(queued.id);
        const done = await as(who).get(w(`/import/bigin/runs/${queued.id}`, ws));
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        return done.body as BiginImportRunView;
    }
    async function people(ws = workspace, who = admin): Promise<PersonRow[]> {
        const res = await as(who).get(w('/people?limit=100', ws));
        expect(res.status).toBe(200);
        return (res.body as Listed<PersonRow>).items;
    }
    async function companies(): Promise<CompanyRow[]> {
        const res = await as(admin).get(w('/companies?limit=100'));
        expect(res.status).toBe(200);
        return (res.body as Listed<CompanyRow>).items;
    }
    const linkOf = (object: BiginImportObject, externalId: string) =>
        owner.biginImportLink.findUnique({
            where: { workspaceId_object_externalId: { workspaceId: workspace, object, externalId } },
        });

    // Seeded Bigin ids, by name.
    type IdKey =
        | 'existingPerson'
        | 'existingCompany'
        | 'twentyCompany'
        | 'acme'
        | 'globex'
        | 'initech'
        | 'matthew'
        | 'dana'
        | 'nobody'
        | 'reused'
        | 'cased'
        | 'won'
        | 'lost'
        | 'meeting'
        | 'unknown'
        | 'earlyDeal'
        | 'note'
        | 'orphan'
        | 'phoneAccount'
        | 'caller'
        | 'phoneDeal';
    const ids = {} as Record<IdKey, string>;
    let firstRun: BiginImportRunView;

    beforeAll(async () => {
        await bigin.start();
        await twenty.start();
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
        runner = app.get(BiginImportRunner);
        workers = app.get(BiginImportWorkers);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Bigin ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other bigin ${stamp}`));
        adminMemberId = ((await as(admin).get(w('/me'))).body as { memberId: string }).memberId;

        const roles = await as(admin).get(w('/roles'));
        const memberRoleId = (roles.body as { id: string; name: string }[]).find(
            (r) => r.name === SYSTEM_ROLES.member,
        )!.id;
        const invite = await as(admin).post(w('/invites')).send({ email: memberEmail, roleId: memberRoleId });
        expect(invite.status, JSON.stringify(invite.body)).toBe(201);
        const accepted = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
        member = browserFrom(accepted);
        await verifyAddress(app, http, memberEmail);
        memberMemberId = ((await as(member).get(w('/me'))).body as { memberId: string }).memberId;

        // Already in BylineCRM: a person Bigin also has, a company with a domain Bigin's account has (on a
        // subdomain), and a company the Twenty importer made from a Bigin account (its `biginrecordid`).
        const dana = await as(admin)
            .post(w('/people'))
            .send({
                nameFirst: 'Dana',
                nameLast: 'Here',
                emails: { primary: `dana-${stamp}@acme.example`, additional: [] },
            });
        expect(dana.status, JSON.stringify(dana.body)).toBe(201);
        ids.existingPerson = (dana.body as { id: string }).id;
        const globex = await as(admin)
            .post(w('/companies'))
            .send({ name: 'Globex', domain: `globex-${stamp}.net` });
        expect(globex.status, JSON.stringify(globex.body)).toBe(201);
        ids.existingCompany = (globex.body as { id: string }).id;
        // Bigin's account is at one of Globex's other domains: it merges there, not refused as Globex's.
        const other = await as(admin)
            .post(w(`/companies/${ids.existingCompany}/domains`))
            .send({ domain: `globex-${stamp}.com` });
        expect(other.status, JSON.stringify(other.body)).toBe(201);
        const initech = await as(admin).post(w('/companies')).send({ name: 'Initech (from Twenty)' });
        expect(initech.status, JSON.stringify(initech.body)).toBe(201);
        ids.twentyCompany = (initech.body as { id: string }).id;

        const [acme, globexAccount, initechAccount] = bigin.seed('Accounts', [
            {
                Account_Name: 'Acme',
                Website: `https://www.acme-${stamp}.example/`,
                Billing_City: 'Toronto',
                Billing_Country: 'Canada',
                Owner: ownerOf(adminEmail.toUpperCase()),
            },
            { Account_Name: 'Globex Corp', Website: `https://shop.globex-${stamp}.com`, Owner: ownerOf(memberEmail) },
            { Account_Name: 'Initech', Website: '', Owner: ownerOf(memberEmail) },
        ]);
        ids.acme = acme!.id;
        ids.globex = globexAccount!.id;
        ids.initech = initechAccount!.id;
        // The Twenty importer wrote Bigin's id (as the CSV export had it) on the company it made.
        await owner.company.update({
            where: { id: ids.twentyCompany },
            data: { custom: { biginrecordid: `zcrm_${ids.initech}` } },
        });

        const [matthew, danaContact, nobody, , reused, cased] = bigin.seed('Contacts', [
            {
                First_Name: 'Matthew',
                Last_Name: 'Croteau',
                Email: `Matthew.Croteau@acme-${stamp}.example`,
                Phone: '+1 978 252 2121',
                Title: 'VP Marketing',
                Mailing_City: 'Boston',
                Account_Name: { id: ids.acme, name: 'Acme' },
                Owner: ownerOf(adminEmail),
                PR_LINK: 'https://www.newswire.ca/news-releases/acme',
                Email_Opt_Out: true,
            },
            {
                First_Name: 'Dana',
                Last_Name: 'FromBigin',
                Email: `dana-${stamp}@acme.example`,
                Account_Name: null,
                Owner: ownerOf(memberEmail),
            },
            { First_Name: '', Last_Name: '', Email: '', Owner: ownerOf(adminEmail) },
            {
                First_Name: 'Owner',
                Last_Name: 'Unknown',
                Email: `ou-${stamp}@x.example`,
                Owner: ownerOf('nobody@else.example'),
            },
            {
                First_Name: 'Pat',
                Last_Name: 'Early',
                Email: `pat-${stamp}@early.example`,
                Owner: ownerOf(adminEmail),
                Created_Time: '2026-01-05T10:00:00+00:00',
            },
            {
                First_Name: 'Casey',
                Last_Name: 'Case',
                Email: `casey-${stamp}@case.example`,
                Owner: ownerOf(adminEmail),
            },
        ]);
        ids.matthew = matthew!.id;
        ids.dana = danaContact!.id;
        ids.nobody = nobody!.id;
        ids.reused = reused!.id;
        ids.cased = cased!.id;

        const [won, lost, meeting, unknown, earlyDeal] = bigin.seed('Deals', [
            {
                Deal_Name: 'Acme release',
                Amount: 1250.5,
                Stage: 'Closed Won',
                Closing_Date: '2026-10-01',
                Account_Name: { id: ids.acme, name: 'Acme' },
                Contact_Name: { id: ids.matthew, name: 'Matthew Croteau' },
                Owner: ownerOf(adminEmail),
            },
            { Deal_Name: 'Globex release', Stage: 'Closed Lost', Owner: ownerOf(memberEmail) },
            {
                Deal_Name: 'Initech release',
                Stage: 'MEETING',
                Account_Name: { id: ids.initech },
                Owner: ownerOf(adminEmail),
            },
            { Deal_Name: 'Mystery', Stage: 'Pending Press Release', Owner: ownerOf(adminEmail) },
            {
                Deal_Name: 'Pat early deal',
                Stage: 'New',
                Contact_Name: { id: ids.reused },
                Owner: ownerOf(adminEmail),
                Created_Time: '2026-01-06T10:00:00+00:00',
            },
        ]);
        ids.won = won!.id;
        ids.lost = lost!.id;
        ids.meeting = meeting!.id;
        ids.unknown = unknown!.id;
        ids.earlyDeal = earlyDeal!.id;

        const [note, orphan] = bigin.seed('Notes', [
            {
                Note_Title: 'Call',
                Note_Content: 'Spoke with **Matthew**',
                $se_module: 'Contacts',
                Parent_Id: { id: ids.matthew },
                Owner: ownerOf(adminEmail),
            },
            { Note_Title: 'Lost', Note_Content: 'no parent here', $se_module: 'Contacts', Parent_Id: { id: '1' } },
        ]);
        ids.note = note!.id;
        ids.orphan = orphan!.id;
    });

    afterAll(async () => {
        await app?.close();
        await bigin.close();
        await twenty.close();
    });

    describe('the connection', () => {
        it('starts unconfigured, and is an admin’s to see and set', async () => {
            const res = await as(admin).get(w('/import/bigin'));
            expect(res.status).toBe(200);
            const overview = res.body as BiginImportOverview;
            expect(overview.settings.configured).toBe(false);
            expect(overview.linked.map((l) => l.count)).toEqual([0, 0, 0, 0, 0, 0, 0]);
            expect((await as(member).get(w('/import/bigin'))).status).toBe(403);
            expect((await as(member).put(w('/import/bigin/settings')).send(connection())).status).toBe(403);
        });

        it('stores the client secret and refresh token sealed and returns neither; refused credentials fail at the person', async () => {
            const bad = await as(admin)
                .put(w('/import/bigin/settings'))
                .send({ ...connection(), refreshToken: 'wrong-refresh-token' });
            expect(bad.status, JSON.stringify(bad.body)).toBe(200);
            const preview = await as(admin).post(w('/import/bigin/preview'));
            expect(preview.status).toBe(422);
            expect((await as(admin).post(w('/import/bigin/runs')).send({ mode: 'full' })).status).toBe(422);

            const res = await as(admin).put(w('/import/bigin/settings')).send(connection());
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const view = res.body as BiginImportSettingsView;
            expect(view).toMatchObject({ configured: true, clientId: bigin.clientId, refreshTokenLast4: '1234' });
            expect(JSON.stringify(view)).not.toContain(bigin.clientSecret);
            expect(JSON.stringify(view)).not.toContain(bigin.refreshToken);
            const row = await owner.biginImportSettings.findUniqueOrThrow({ where: { workspaceId: workspace } });
            expect(row.clientSecretCiphertext).not.toContain(bigin.clientSecret);
            expect(row.refreshTokenCiphertext).not.toContain(bigin.refreshToken);
            // An update may leave the secrets out to keep them.
            const kept = await as(admin)
                .put(w('/import/bigin/settings'))
                .send({ accountsUrl: bigin.url, apiUrl: bigin.url, clientId: bigin.clientId });
            expect(kept.status, JSON.stringify(kept.body)).toBe(200);

            const counted = await as(admin).post(w('/import/bigin/preview'));
            expect(counted.status, JSON.stringify(counted.body)).toBe(200);
            expect((counted.body as { objects: { object: string; remote: number }[] }).objects).toEqual([
                expect.objectContaining({ object: 'Accounts', remote: 3 }),
                expect.objectContaining({ object: 'Contacts', remote: 6 }),
                expect.objectContaining({ object: 'Deals', remote: 5 }),
                expect.objectContaining({ object: 'Notes', remote: 2 }),
                expect.objectContaining({ object: 'Tasks', remote: 0 }),
                expect.objectContaining({ object: 'Events', remote: 0 }),
                expect.objectContaining({ object: 'Calls', remote: 0 }),
            ]);
        });

        it('FR-CRMS-25: takes a self client’s grant code instead of a refresh token, trades it once, and stores the token', async () => {
            const { refreshToken: _token, ...withoutToken } = connection();
            const wrong = await as(admin)
                .put(w('/import/bigin/settings'))
                .send({ ...withoutToken, grantCode: '1000.not-the-code' });
            expect(wrong.status).toBe(422);
            expect(JSON.stringify(wrong.body)).toContain('grantCode');

            const good = await as(admin)
                .put(w('/import/bigin/settings'))
                .send({ ...withoutToken, grantCode: bigin.grantCode });
            expect(good.status, JSON.stringify(good.body)).toBe(200);
            expect(good.body).toMatchObject({ configured: true, refreshTokenLast4: bigin.refreshToken.slice(-4) });
            expect(JSON.stringify(good.body)).not.toContain(bigin.refreshToken);
            expect((await as(admin).post(w('/import/bigin/preview'))).status).toBe(200);

            // The stored secret never follows a changed URL: a new data centre needs the secret and a new grant again.
            const moved = await as(admin).put(w('/import/bigin/settings')).send({
                accountsUrl: 'https://accounts.zoho.eu',
                apiUrl: 'https://www.zohoapis.eu',
                clientId: bigin.clientId,
            });
            expect(moved.status).toBe(422);
            expect(JSON.stringify(moved.body)).toContain('clientSecret');
            expect(JSON.stringify(moved.body)).toContain('grantCode');

            // A grant code is single-use: the same one again is refused, and the stored token stands.
            const again = await as(admin)
                .put(w('/import/bigin/settings'))
                .send({ ...withoutToken, grantCode: '1000.grant-code-abcdef' });
            expect(again.status).toBe(422);
            expect((await as(admin).post(w('/import/bigin/preview'))).status).toBe(200);
        });
    });

    describe('a full run', () => {
        it('reports per module what it did, failures included (zero is said)', async () => {
            firstRun = await runToEnd('full');
            expect(firstRun.status, firstRun.error ?? '').toBe('succeeded');
            expect(firstRun.failedRecords).toBe(0);
            expect(counts(reportOf(firstRun, 'Accounts'))).toEqual({
                read: 3,
                created: 1,
                updated: 0,
                unchanged: 0,
                merged: 2,
                skipped: 0,
                failed: 0,
            });
            expect(counts(reportOf(firstRun, 'Contacts'))).toEqual({
                read: 6,
                created: 4,
                updated: 0,
                unchanged: 0,
                merged: 1,
                skipped: 1,
                failed: 0,
            });
            expect(counts(reportOf(firstRun, 'Deals'))).toMatchObject({ read: 5, created: 5, failed: 0 });
            expect(counts(reportOf(firstRun, 'Notes'))).toMatchObject({ read: 2, created: 1, skipped: 1, failed: 0 });
            expect(firstRun.report.every((r) => r.reused === 0)).toBe(true);
        });

        it('companies: merged by registrable domain and into the one the Twenty importer made; the owner by email', async () => {
            const all = await companies();
            const acme = all.find((c) => c.name === 'Acme')!;
            expect(acme).toMatchObject({ domain: `acme-${stamp}.example`, ownerId: adminMemberId });
            expect((await linkOf('Accounts', ids.globex))!.localId).toBe(ids.existingCompany);
            expect(all.find((c) => c.id === ids.existingCompany)!.domain).toBe(`globex-${stamp}.net`);
            expect((await linkOf('Accounts', ids.initech))!.localId).toBe(ids.twentyCompany);
            expect(all.filter((c) => c.name.startsWith('Initech'))).toHaveLength(1);
        });

        it('people: fields, company through the links, owner by email on create, merged by address', async () => {
            const all = await people();
            const matthew = all.find((p) => p.nameFirst === 'Matthew')!;
            expect(matthew).toMatchObject({
                nameLast: 'Croteau',
                emails: expect.objectContaining({ primary: `matthew.croteau@acme-${stamp}.example` }),
                jobTitle: 'VP Marketing',
                source: 'bigin',
                ownerId: adminMemberId,
            });
            expect(matthew.custom.pr_link).toBe('https://www.newswire.ca/news-releases/acme');
            expect(matthew.companyId).toBe((await linkOf('Accounts', ids.acme))!.localId);
            // Merged into who was here, not a second Dana.
            expect((await linkOf('Contacts', ids.dana))!.localId).toBe(ids.existingPerson);
            expect(all.filter((p) => p.emails.primary === `dana-${stamp}@acme.example`)).toHaveLength(1);
            // An owner nobody here has leaves the person unowned.
            expect(all.find((p) => p.nameFirst === 'Owner')!.ownerId).toBeNull();
            // Opted out of email in Bigin: never mailed here — suppressed as their own unsubscribe.
            const suppressed = await owner.suppression.findMany({
                where: { workspaceId: workspace, address: `matthew.croteau@acme-${stamp}.example`, removedAt: null },
            });
            expect(suppressed).toEqual([
                expect.objectContaining({
                    reason: 'unsubscribe',
                    source: 'recipient',
                    note: 'Opted out of email in Bigin',
                }),
            ]);
            expect(
                await owner.suppression.count({
                    where: { workspaceId: workspace, address: `dana-${stamp}@acme.example`, removedAt: null },
                }),
            ).toBe(0);
        });

        it('deals: the stage by name (case aside), Closed Won/Lost to won and lost, an unknown stage to the first open one with the raw stage reported', async () => {
            const stages = await owner.pipelineStage.findMany({ where: { workspaceId: workspace } });
            const stageOf = async (bid: string) => {
                const deal = await owner.opportunity.findUniqueOrThrow({
                    where: { id: (await linkOf('Deals', bid))!.localId },
                });
                return { deal, stage: stages.find((s) => s.id === deal.stageId)! };
            };
            const won = await stageOf(ids.won);
            expect(won.stage.kind).toBe('won');
            expect(won.deal.closedAt).not.toBeNull();
            expect(won.deal.ownerId).toBe(adminMemberId);
            expect((await stageOf(ids.lost)).stage.kind).toBe('lost');
            expect((await stageOf(ids.meeting)).stage.name).toBe('Meeting');
            expect((await stageOf(ids.unknown)).stage.name).toBe('New');
            expect(reportOf(firstRun, 'Deals').unknownStages).toEqual([
                { externalId: ids.unknown, stage: 'Pending Press Release' },
            ]);
        });

        it('notes sit on their record, written by the owner when they are a member; one whose record is not here is skipped', async () => {
            const noteLink = await linkOf('Notes', ids.note);
            const note = await owner.note.findUniqueOrThrow({ where: { id: noteLink!.localId } });
            expect(note.authorId).toBe(adminMemberId);
            expect(reportOf(firstRun, 'Notes').errors).toEqual([
                { externalId: ids.orphan, message: 'its record is not in BylineCRM' },
            ]);
        });

        it('the module cursors are kept on the connection', async () => {
            const overview = (await as(admin).get(w('/import/bigin'))).body as BiginImportOverview;
            expect(overview.cursors.every((c) => c.since !== null)).toBe(true);
            expect(overview.latestRun?.id).toBe(firstRun.id);
        });
    });

    describe('running again', () => {
        it('a second full run changes nothing', async () => {
            const again = await runToEnd('full');
            expect(again.status).toBe('succeeded');
            expect(counts(reportOf(again, 'Contacts'))).toMatchObject({ created: 0, updated: 0, failed: 0 });
            expect(counts(reportOf(again, 'Accounts'))).toMatchObject({ created: 0, updated: 0, failed: 0 });
        });

        it('a changes run reads from the cursor and applies only what moved; owner is never changed on update, a field edited here is kept', async () => {
            const matthewId = (await linkOf('Contacts', ids.matthew))!.localId;
            await new Promise((resolve) => setTimeout(resolve, 1100));
            bigin.update('Contacts', ids.matthew, {
                Title: 'CMO',
                Mailing_City: 'Montreal',
                Owner: ownerOf(memberEmail),
            });
            // Edited here after Bigin last modified the record: BylineCRM's value is kept.
            await new Promise((resolve) => setTimeout(resolve, 20));
            const edit = await as(admin)
                .patch(w(`/people/${matthewId}`))
                .send({ jobTitle: 'Chief Storyteller' });
            expect(edit.status, JSON.stringify(edit.body)).toBe(200);
            const before = bigin.requests.length;
            const run = await runToEnd('changes');
            expect(run.status).toBe('succeeded');
            const contactReads = bigin.requests.slice(before).filter((r) => r.path.startsWith('/bigin/v1/Contacts?'));
            expect(contactReads.every((r) => r.ifModifiedSince !== undefined)).toBe(true);
            expect(counts(reportOf(run, 'Contacts'))).toMatchObject({ updated: 1, created: 0, failed: 0 });
            expect(reportOf(run, 'Contacts').kept).toEqual([{ externalId: ids.matthew, fields: ['jobTitle'] }]);
            expect(reportOf(run, 'Accounts')).toMatchObject({ created: 0, updated: 0 });
            const matthew = (await people()).find((p) => p.id === matthewId)!;
            expect(matthew.jobTitle).toBe('Chief Storyteller');
            expect((await owner.person.findUniqueOrThrow({ where: { id: matthewId } })).city).toBe('Montreal');
            expect(matthew.ownerId).toBe(adminMemberId);
            expect(memberMemberId).not.toBe(adminMemberId);
        });

        it('Bigin deletions are never mirrored: the record stays and is flagged missing in source for review', async () => {
            bigin.remove('Contacts', ids.cased);
            const run = await runToEnd('changes');
            expect(reportOf(run, 'Contacts').missingInSource).toBe(1);
            const missing = await as(admin).get(w('/import/bigin/missing'));
            expect(missing.status).toBe(200);
            const items = (missing.body as Listed<BiginImportMissingView>).items;
            expect(items).toEqual([
                expect.objectContaining({ object: 'Contacts', externalId: ids.cased, localType: 'person' }),
            ]);
            expect((await people()).some((p) => p.id === items[0]!.localId)).toBe(true);
        });

        it('FR-CRMS-25: more than 2,000 records modified in one second (a bulk edit) are all read, by page token', async () => {
            // After every cursor the earlier runs left: modified now, in one second.
            const second = new Date().toISOString();
            bigin.seed(
                'Accounts',
                Array.from({ length: 2_100 }, (_, i) => ({
                    Account_Name: `Bulk ${stamp} ${i}`,
                    Website: `bulk-${i}-${stamp}.example`,
                    Modified_Time: second,
                    Created_Time: second,
                })),
            );
            const run = await runToEnd('changes');
            expect(run.status, run.error ?? '').toBe('succeeded');
            expect(reportOf(run, 'Accounts').failed).toBe(0);
            expect(reportOf(run, 'Accounts').created).toBeGreaterThanOrEqual(2_100);
            // v2 reads from the oldest record (it ignores `If-Modified-Since`): what is older than the window is passed over, not read again.
            expect(reportOf(run, 'Accounts').read).toBeLessThan(2_100 + 400);
            expect(bigin.requests.some((r) => r.path.includes('page_token='))).toBe(true);
        }, 300_000);

        it('FR-CRMS-25: past the 2,000 deletions a pass may page through, the next run reads on from the newest one read', async () => {
            const from = new Date(Date.now() - 3 * 60 * 60 * 1000);
            bigin.seedDeletions('Notes', 2_500, from);
            await runToEnd('changes');
            const before = bigin.requests.length;
            await runToEnd('changes');
            const notesDeleted = bigin.requests
                .slice(before)
                .filter((r) => r.path.startsWith('/bigin/v1/Notes/deleted'));
            expect(notesDeleted.length).toBeGreaterThan(0);
            // The 2,000th deletion is the newest the first run could read; the second asks from there, not from the start.
            const newestRead = new Date(from.getTime() + 1_999 * 1000);
            expect(new Date(notesDeleted[0]!.ifModifiedSince!).getTime()).toBeGreaterThanOrEqual(
                newestRead.getTime() - 1000,
            );
        });
    });

    describe('reused Bigin Contacts', () => {
        it('a Contact edited into a different person (address and name) leaves the first person untouched with a note, makes a second, and moves the link', async () => {
            const patId = (await linkOf('Contacts', ids.reused))!.localId;
            const earlyDealId = (await linkOf('Deals', ids.earlyDeal))!.localId;
            await new Promise((resolve) => setTimeout(resolve, 1100));
            bigin.update('Contacts', ids.reused, {
                First_Name: 'Robin',
                Last_Name: 'Later',
                Email: `robin-${stamp}@later.example`,
            });
            const later = bigin.seed('Deals', [
                { Deal_Name: 'Robin deal', Stage: 'New', Contact_Name: { id: ids.reused }, Owner: ownerOf(adminEmail) },
            ])[0]!;
            const laterNote = bigin.seed('Notes', [
                {
                    Note_Content: 'about Robin',
                    $se_module: 'Contacts',
                    Parent_Id: { id: ids.reused },
                    Owner: ownerOf(adminEmail),
                },
            ])[0]!;
            const run = await runToEnd('changes');
            expect(reportOf(run, 'Contacts').reused).toBe(1);
            expect(reportOf(run, 'Accounts').reused).toBe(0);

            const pat = await owner.person.findUniqueOrThrow({ where: { id: patId } });
            expect(pat).toMatchObject({ nameFirst: 'Pat', emailPrimary: `pat-${stamp}@early.example` });
            const notes = await owner.noteTarget.findMany({
                where: { targetType: 'person', targetId: patId },
                include: { note: true },
            });
            expect(notes.map((n) => n.note.bodyText).join('\n')).toContain(
                'This Bigin contact was reused for another person on',
            );

            const link = (await linkOf('Contacts', ids.reused))!;
            expect(link.localId).not.toBe(patId);
            const robin = await owner.person.findUniqueOrThrow({ where: { id: link.localId } });
            expect(robin).toMatchObject({
                nameFirst: 'Robin',
                emailPrimary: `robin-${stamp}@later.example`,
                ownerId: adminMemberId,
            });
            // Made after the change: on Robin. Made before it: still on Pat.
            const robinDeal = await owner.opportunity.findUniqueOrThrow({
                where: { id: (await linkOf('Deals', later.id))!.localId },
            });
            expect(robinDeal.pointOfContactId).toBe(robin.id);
            expect((await owner.opportunity.findUniqueOrThrow({ where: { id: earlyDealId } })).pointOfContactId).toBe(
                patId,
            );
            const robinNote = await owner.noteTarget.findMany({
                where: { noteId: (await linkOf('Notes', laterNote.id))!.localId },
            });
            expect(robinNote.map((t) => t.targetId)).toEqual([robin.id]);

            const listed = await as(admin).get(w('/import/bigin/reuses'));
            expect(listed.status).toBe(200);
            expect((listed.body as Listed<BiginContactReuseView>).items).toEqual([
                expect.objectContaining({
                    biginId: ids.reused,
                    previousPersonId: patId,
                    newPersonId: robin.id,
                    before: { name: 'Pat Early', email: `pat-${stamp}@early.example` },
                    after: { name: 'Robin Later', email: `robin-${stamp}@later.example` },
                }),
            ]);
            expect((await as(member).get(w('/import/bigin/reuses'))).status).toBe(403);
        });

        it('a Contact whose address only changes case is the same person: updated, no reuse', async () => {
            const danaBefore = (await linkOf('Contacts', ids.dana))!.localId;
            await new Promise((resolve) => setTimeout(resolve, 1100));
            bigin.update('Contacts', ids.dana, { Email: `DANA-${stamp}@ACME.example` });
            const run = await runToEnd('changes');
            expect(reportOf(run, 'Contacts').reused).toBe(0);
            expect((await linkOf('Contacts', ids.dana))!.localId).toBe(danaBefore);
            expect(await owner.biginContactReuse.count({ where: { workspaceId: workspace } })).toBe(1);
        });
    });

    describe('cross-source dedup with the Twenty importer', () => {
        it('a Twenty record carrying the Bigin id links to the person the Bigin importer made, never a second one', async () => {
            const matthewId = (await linkOf('Contacts', ids.matthew))!.localId;
            const peopleBefore = (await people()).length;
            twenty.seed('people', [
                {
                    name: { firstName: 'Matthew', lastName: 'Croteau' },
                    emails: { primaryEmail: `m.croteau-${stamp}@elsewhere.example`, additionalEmails: [] },
                    biginrecordid: `zcrm_${ids.matthew}`,
                },
            ]);
            const put = await as(admin)
                .put(w('/import/twenty/settings'))
                .send({ baseUrl: twenty.baseUrl, apiKey: twenty.apiKey });
            expect(put.status, JSON.stringify(put.body)).toBe(200);
            const started = await as(admin).post(w('/import/twenty/runs')).send({ mode: 'full' });
            expect(started.status, JSON.stringify(started.body)).toBe(202);
            await app.get(TwentyImportRunner).run((started.body as TwentyImportRunView).id);
            const done = (await as(admin).get(w(`/import/twenty/runs/${(started.body as TwentyImportRunView).id}`)))
                .body as TwentyImportRunView;
            expect(done.status).toBe('succeeded');
            expect(done.report.find((r) => r.object === 'people')).toMatchObject({ merged: 1, created: 0 });
            expect((await people()).length).toBe(peopleBefore);
            const twentyLink = await owner.twentyImportLink.findFirst({
                where: { workspaceId: workspace, object: 'people' },
            });
            expect(twentyLink!.localId).toBe(matthewId);
        });

        it('a Contact the Twenty importer made, whose Bigin address another person here holds, is linked and updated with its own address kept, never failed', async () => {
            const create = async (nameFirst: string, email: string) => {
                const res = await as(admin)
                    .post(w('/people'))
                    .send({ nameFirst, nameLast: 'Dup', emails: { primary: email, additional: [] } });
                expect(res.status, JSON.stringify(res.body)).toBe(201);
                return (res.body as { id: string }).id;
            };
            const holderId = await create('Holder', `taken-${stamp}@dup.example`);
            const twentyMadeId = await create('Terry', `terry-${stamp}@old.example`);
            await new Promise((resolve) => setTimeout(resolve, 1100));
            const [contact] = bigin.seed('Contacts', [
                {
                    First_Name: 'Terry',
                    Last_Name: 'Dup',
                    Title: 'Editor',
                    Email: `Taken-${stamp}@dup.example`,
                    Owner: ownerOf(adminEmail),
                },
            ]);
            await owner.person.update({
                where: { id: twentyMadeId },
                data: { custom: { biginrecordid: `zcrm_${contact!.id}` } },
            });
            const run = await runToEnd('changes');
            const contacts = reportOf(run, 'Contacts');
            expect(contacts.errors, JSON.stringify(contacts.errors)).toEqual([]);
            expect(counts(contacts)).toMatchObject({ merged: 1, created: 0, failed: 0 });
            expect(contacts.kept).toContainEqual({ externalId: contact!.id, fields: ['emails'] });
            expect((await linkOf('Contacts', contact!.id))!.localId).toBe(twentyMadeId);
            const terry = await owner.person.findUniqueOrThrow({ where: { id: twentyMadeId } });
            expect(terry).toMatchObject({ emailPrimary: `terry-${stamp}@old.example`, jobTitle: 'Editor' });
            expect((await owner.person.findUniqueOrThrow({ where: { id: holderId } })).emailPrimary).toBe(
                `taken-${stamp}@dup.example`,
            );
        });
    });

    describe('the automatic sync', () => {
        const DAY = 24 * 60 * 60 * 1000;
        const age = (runId: string) =>
            owner.biginImportRun.update({
                where: { id: runId },
                data: { finishedAt: new Date(Date.now() - 2 * DAY) },
            });

        it('ticks start scheduled changes runs; failing runs back off and the third in a row tells the admins once; a success resets', async () => {
            const set = await as(admin).put(w('/import/bigin/sync')).send({ interval: 'hourly' });
            expect(set.status, JSON.stringify(set.body)).toBe(200);
            const failOnce = async () => {
                bigin.failNext(401, 2);
                const runId = (await workers.tick(workspace))!;
                expect(runId).toBeTruthy();
                await runner.run(runId);
                const run = (await as(admin).get(w(`/import/bigin/runs/${runId}`))).body as BiginImportRunView;
                expect(run).toMatchObject({ status: 'failed', scheduled: true, mode: 'changes' });
                return run;
            };
            let last = await failOnce();
            expect(((await as(admin).get(w('/import/bigin'))).body as BiginImportOverview).sync.failures).toBe(1);
            expect(await workers.tick(workspace)).toBeNull();
            await age(last.id);
            last = await failOnce();
            await age(last.id);
            last = await failOnce();
            await deliverMail(app);
            const notices = mailTo(adminEmail, 'bigin_sync_failing');
            expect(notices).toHaveLength(1);
            expect(notices[0]!.text).toContain(`/w/${workspace}/settings/import-bigin`);
            expect(mailTo(memberEmail, 'bigin_sync_failing')).toHaveLength(0);
            await age(last.id);
            const runId = (await workers.tick(workspace))!;
            await runner.run(runId);
            expect(((await as(admin).get(w('/import/bigin'))).body as BiginImportOverview).sync).toMatchObject({
                failures: 0,
                lastError: null,
            });
            const cut = await as(admin).post(w('/import/bigin/sync/cutover'));
            expect(cut.status).toBe(200);
            expect(await workers.tick(workspace)).toBeNull();
        });
    });

    describe('cross-tenant', () => {
        it('another workspace sees no connection, runs, reuses or imported records, and cannot read a run of this one', async () => {
            const overview = (await as(otherAdmin).get(w('/import/bigin', otherWorkspace))).body as BiginImportOverview;
            expect(overview.settings.configured).toBe(false);
            expect(overview.latestRun).toBeNull();
            expect(overview.linked.every((l) => l.count === 0)).toBe(true);
            expect((await as(otherAdmin).get(w(`/import/bigin/runs/${firstRun.id}`, otherWorkspace))).status).toBe(404);
            expect(
                (await as(otherAdmin).post(w(`/import/bigin/runs/${firstRun.id}/cancel`, otherWorkspace))).status,
            ).toBe(404);
            expect(
                ((await as(otherAdmin).get(w('/import/bigin/reuses', otherWorkspace))).body as Listed<unknown>).items,
            ).toEqual([]);
            expect((await people(otherWorkspace, otherAdmin)).some((p) => p.source === 'bigin')).toBe(false);
            expect(await owner.biginImportLink.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
        });
    });

    describe('a person merged from duplicates linked to several Contacts (person dedupe)', () => {
        it('every Contact still resolves to the survivor; only the most recently modified one writes its fields', async () => {
            await new Promise((resolve) => setTimeout(resolve, 1100));
            const [older, newer] = bigin.seed('Contacts', [
                {
                    First_Name: 'Rick',
                    Last_Name: 'Twice',
                    Email: `rick-a-${stamp}@twice.example`,
                    Title: 'A',
                    Owner: ownerOf(adminEmail),
                },
                {
                    First_Name: 'Rick',
                    Last_Name: 'Twice',
                    Email: `rick-b-${stamp}@twice.example`,
                    Title: 'B',
                    Owner: ownerOf(adminEmail),
                },
            ]);
            await runToEnd('changes');
            const a = (await linkOf('Contacts', older!.id))!.localId;
            const b = (await linkOf('Contacts', newer!.id))!.localId;
            expect(a).not.toBe(b);
            const merged = await app.get(PeopleDedupe).merge(workspace, [a, b], true);
            const survivor = merged!.decision.survivorId;
            expect((await linkOf('Contacts', older!.id))!.localId).toBe(survivor);
            expect((await linkOf('Contacts', newer!.id))!.localId).toBe(survivor);

            // `newer` is modified in Bigin last: its change writes.
            const hour = 60 * 60 * 1000;
            bigin.update(
                'Contacts',
                newer!.id,
                { Title: 'From the newer Contact' },
                new Date(Date.now() + hour).toISOString(),
            );
            await runToEnd('changes');
            expect((await owner.person.findUniqueOrThrow({ where: { id: survivor } })).jobTitle).toBe(
                'From the newer Contact',
            );

            // `older` changes, but was modified in Bigin before `newer`: on a full pass it only keeps its link.
            bigin.update(
                'Contacts',
                older!.id,
                { Title: 'From the older Contact' },
                new Date(Date.now() + hour / 2).toISOString(),
            );
            const run = await runToEnd('full');
            expect(reportOf(run, 'Contacts').errors.map((e) => e.externalId)).not.toContain(older!.id);
            const after = await owner.person.findUniqueOrThrow({ where: { id: survivor } });
            expect(after.jobTitle).toBe('From the newer Contact');
            expect((await linkOf('Contacts', older!.id))!.localId).toBe(survivor);
            expect((await linkOf('Contacts', older!.id))!.externalUpdatedAt).not.toBeNull();
            expect(
                await owner.person.count({ where: { workspaceId: workspace, nameLast: 'Twice', deletedAt: null } }),
            ).toBe(1);
        }, 300_000);
    });

    describe('the stage mapping', () => {
        it("lists Bigin's stages with counts, maps them, and applies the mapping to imported deals except one moved by hand", async () => {
            await new Promise((resolve) => setTimeout(resolve, 1100));
            const [first, second, third] = bigin.seed('Deals', [
                { Deal_Name: 'Follow up A', Stage: 'Second Follow Up Done', Owner: ownerOf(adminEmail) },
                { Deal_Name: 'Follow up B', Stage: 'Second Follow Up Done', Owner: ownerOf(adminEmail) },
                { Deal_Name: 'Qualifying', Stage: 'Qualification', Owner: ownerOf(adminEmail) },
            ]);
            const run = await runToEnd('changes');
            expect(reportOf(run, 'Deals').unknownStages.map((u) => u.stage)).toContain('Second Follow Up Done');
            expect((await linkOf('Deals', first!.id))!.snapshot).toEqual({ stage: 'Second Follow Up Done' });
            const dealOf = async (bid: string) =>
                owner.opportunity.findUniqueOrThrow({ where: { id: (await linkOf('Deals', bid))!.localId } });

            // Bigin's picklist, then the stages deals carry when Bigin will not say.
            bigin.dealStages = ['Qualification', 'Second Follow Up Done', 'Never Used'];
            const listed = await as(admin).get(w('/import/bigin/stage-map'));
            expect(listed.status, JSON.stringify(listed.body)).toBe(200);
            const map = listed.body as BiginStageMapView;
            expect(map.source).toBe('bigin');
            const row = (name: string, m = map) => m.rows.find((r) => r.biginStage === name)!;
            expect(row('Second Follow Up Done')).toMatchObject({ deals: 2, stageId: null, match: 'fallback' });
            expect(row('Never Used').deals).toBe(0);
            expect(row('Pending Press Release').deals).toBeGreaterThan(0);
            bigin.dealStages = null;
            const fallback = (await as(admin).get(w('/import/bigin/stage-map'))).body as BiginStageMapView;
            expect(fallback.source).toBe('imported');
            expect(fallback.error).toMatch(/stage list/);
            expect(fallback.rows.some((r) => r.biginStage === 'Never Used')).toBe(false);
            expect((await as(member).get(w('/import/bigin/stage-map'))).status).toBe(403);

            const meeting = map.stages.find((s) => s.name === 'Meeting')!;
            const put = await as(admin)
                .put(w('/import/bigin/stage-map'))
                .send({
                    mappings: [
                        { biginStage: 'Second Follow Up Done', stageId: meeting.id },
                        { biginStage: 'Qualification', stageId: null },
                    ],
                });
            expect(put.status, JSON.stringify(put.body)).toBe(200);
            expect(row('Second Follow Up Done', put.body as BiginStageMapView)).toMatchObject({
                stageId: meeting.id,
                targetStageId: meeting.id,
                match: 'mapped',
            });

            // One deal is moved by hand after Bigin last changed it: the apply leaves it there.
            const handStage = map.stages.find((s) => s.name === 'Replied')!;
            const moved = await as(admin)
                .post(w(`/opportunities/${(await dealOf(second!.id)).id}/move`))
                .send({ stageId: handStage.id });
            expect(moved.status, JSON.stringify(moved.body)).toBeLessThan(300);
            await settle(app);

            const queued = await as(admin).post(w('/import/bigin/stage-map/apply'));
            expect(queued.status, JSON.stringify(queued.body)).toBe(202);
            expect((queued.body as BiginStageApplyView).status).toBe('queued');
            await app.get(BiginStageApplier).apply(workspace);
            const applied = ((await as(admin).get(w('/import/bigin/stage-map'))).body as BiginStageMapView).apply!;
            expect(applied).toMatchObject({ status: 'succeeded', error: null });
            expect(applied.moved).toBeGreaterThanOrEqual(1);
            expect(applied.skipped).toBeGreaterThanOrEqual(1);
            const firstDeal = await dealOf(first!.id);
            expect(firstDeal.stageId).toBe(meeting.id);
            expect(
                await owner.opportunityStageHistory.findFirst({
                    where: { opportunityId: firstDeal.id, toStageId: meeting.id },
                }),
            ).toMatchObject({ reason: 'import' });
            expect((await dealOf(second!.id)).stageId).toBe(handStage.id);
            expect((await dealOf(third!.id)).stageId).not.toBe(meeting.id);

            // A later run resolves through the mapping too, and never calls the mapped stage unknown.
            bigin.update(
                'Deals',
                third!.id,
                { Stage: 'Second Follow Up Done' },
                new Date(Date.now() + 1000).toISOString(),
            );
            const again = await runToEnd('changes');
            expect(reportOf(again, 'Deals').unknownStages.map((u) => u.externalId)).not.toContain(third!.id);
            expect((await dealOf(third!.id)).stageId).toBe(meeting.id);
        }, 300_000);

        it("one workspace never sees, sets or applies another's mapping", async () => {
            const mine = (await as(admin).get(w('/import/bigin/stage-map'))).body as BiginStageMapView;
            const theirs = await as(otherAdmin)
                .put(w('/import/bigin/stage-map', otherWorkspace))
                .send({ mappings: [{ biginStage: 'Qualification', stageId: mine.stages[0]!.id }] });
            expect(theirs.status).toBe(422);
            expect((await as(otherAdmin).get(w('/import/bigin/stage-map', otherWorkspace))).status).toBe(422);
            const rls = app.get(RlsPrismaService);
            expect(await rls.withWorkspace(otherWorkspace, (tx) => tx.biginStageMapping.findMany())).toEqual([]);
            expect((await rls.withWorkspace(workspace, (tx) => tx.biginStageMapping.findMany())).length).toBe(1);
            await expect(
                rls.withWorkspace(otherWorkspace, (tx) =>
                    tx.biginStageMapping.create({
                        data: { workspaceId: workspace, biginStage: 'Injected', stageId: mine.stages[0]!.id },
                    }),
                ),
            ).rejects.toThrow();
            expect(await owner.biginStageMapping.count({ where: { biginStage: 'Injected' } })).toBe(0);
        });
    });

    describe('owners and blanks filled from Bigin', () => {
        it('an empty owner gets Bigin’s (recorded as a hand-over), an owner is never changed; a blank local first name is filled', async () => {
            const fill = await as(admin)
                .post(w('/companies'))
                .send({ name: 'Fill Co', domain: `fill-${stamp}.example` });
            const kept = await as(admin)
                .post(w('/companies'))
                .send({ name: 'Kept Co', domain: `kept-${stamp}.example` });
            const glusman = await as(admin)
                .post(w('/people'))
                .send({
                    nameFirst: 'J',
                    nameLast: 'Glusman',
                    emails: { primary: `glusman-${stamp}@x.example`, additional: [] },
                });
            expect([fill.status, kept.status, glusman.status], JSON.stringify(glusman.body)).toEqual([201, 201, 201]);
            const fillId = (fill.body as { id: string }).id;
            const keptId = (kept.body as { id: string }).id;
            const glusmanId = (glusman.body as { id: string }).id;
            // As the Twenty import left them: no owner.
            await owner.company.update({ where: { id: fillId }, data: { ownerId: null } });
            await owner.person.update({ where: { id: glusmanId }, data: { ownerId: null } });

            const [fillAccount, keptAccount] = bigin.seed('Accounts', [
                { Account_Name: 'Fill Co', Website: `https://fill-${stamp}.example`, Owner: ownerOf(memberEmail) },
                { Account_Name: 'Kept Co', Website: `https://kept-${stamp}.example`, Owner: ownerOf(memberEmail) },
            ]);
            const [contact] = bigin.seed('Contacts', [
                {
                    First_Name: 'Jeffrey',
                    Last_Name: 'Glusman',
                    Email: `glusman-${stamp}@x.example`,
                    Owner: ownerOf(memberEmail),
                },
            ]);
            const [byContact, unowned] = bigin.seed('Deals', [
                // Bigin's owner is no member here: the deal is its point of contact's.
                {
                    Deal_Name: 'Jeffrey Glusman',
                    Stage: 'New',
                    Contact_Name: { id: contact!.id },
                    Owner: ownerOf('nobody@else.example'),
                },
                { Deal_Name: 'Nobody’s deal', Stage: 'New', Owner: ownerOf('nobody@else.example') },
            ]);
            // Edited here after Bigin's change, leaving the first name empty: a blank holds nothing back.
            await new Promise((resolve) => setTimeout(resolve, 20));
            const blanked = await as(admin)
                .patch(w(`/people/${glusmanId}`))
                .send({ nameFirst: '' });
            expect(blanked.status, JSON.stringify(blanked.body)).toBe(200);

            const run = await runToEnd('changes');
            expect(run.status).toBe('succeeded');
            expect((await linkOf('Accounts', fillAccount!.id))!.localId).toBe(fillId);
            expect((await linkOf('Accounts', keptAccount!.id))!.localId).toBe(keptId);
            expect((await owner.company.findUniqueOrThrow({ where: { id: fillId } })).ownerId).toBe(memberMemberId);
            expect((await owner.company.findUniqueOrThrow({ where: { id: keptId } })).ownerId).toBe(adminMemberId);
            const person = await owner.person.findUniqueOrThrow({ where: { id: glusmanId } });
            expect(person).toMatchObject({ nameFirst: 'Jeffrey', ownerId: memberMemberId });
            expect(reportOf(run, 'Accounts').ownersFilled).toBe(1);
            expect(reportOf(run, 'Contacts').ownersFilled).toBe(1);

            const transfer = await owner.ownershipTransfer.findFirstOrThrow({ where: { recordId: fillId } });
            expect(transfer).toMatchObject({
                object: 'company',
                fromMemberId: null,
                toMemberId: memberMemberId,
                status: 'forced',
                reason: 'import_fill',
            });
            expect(await owner.notification.count({ where: { transferId: transfer.id } })).toBe(0);
            // Kept here (timeline, history), never sent to a webhook as a transfer.
            const announced = await owner.outboxEvent.findFirstOrThrow({
                where: {
                    workspaceId: workspace,
                    type: 'transfer.completed',
                    payload: { path: ['recordId'], equals: transfer.id },
                },
            });
            expect((announced.payload as { internal?: boolean }).internal).toBe(true);
            expect(await owner.webhookDelivery.count({ where: { eventId: announced.id } })).toBe(0);
            expect(await owner.ownershipTransfer.count({ where: { recordId: keptId } })).toBe(0);

            const dealOwner = async (externalId: string) =>
                (
                    await owner.opportunity.findUniqueOrThrow({
                        where: { id: (await linkOf('Deals', externalId))!.localId },
                    })
                ).ownerId;
            expect(await dealOwner(byContact!.id)).toBe(memberMemberId);
            expect(await dealOwner(unowned!.id)).toBeNull();

            // A point of contact added in Bigin later: the unowned deal is filled from them.
            await new Promise((resolve) => setTimeout(resolve, 1100));
            bigin.update('Deals', unowned!.id, { Contact_Name: { id: contact!.id } });
            const again = await runToEnd('changes');
            expect(again.status).toBe('succeeded');
            expect(await dealOwner(unowned!.id)).toBe(memberMemberId);
            expect(reportOf(again, 'Deals').ownersFilled).toBe(1);
            const dealId = (await linkOf('Deals', unowned!.id))!.localId;
            expect(await owner.ownershipTransfer.count({ where: { recordId: dealId, reason: 'import_fill' } })).toBe(1);

            // The fill is the import's: no local edit, so Bigin's next change to the deal applies.
            await new Promise((resolve) => setTimeout(resolve, 1100));
            bigin.update('Deals', unowned!.id, { Deal_Name: 'Somebody’s deal' });
            const third = await runToEnd('changes');
            expect(reportOf(third, 'Deals').kept).toEqual([]);
            expect((await owner.opportunity.findUniqueOrThrow({ where: { id: dealId } })).name).toBe('Somebody’s deal');
            expect(await dealOwner(unowned!.id)).toBe(memberMemberId);
        });
    });

    describe('BIGIN-1: the data the importer used to leave behind', () => {
        it('phones without + are +1, an unreadable one is kept as written, descriptions and a company phone are custom fields', async () => {
            const [account] = bigin.seed('Accounts', [
                {
                    Account_Name: 'Phone Co',
                    Website: `https://phone-${stamp}.example`,
                    Phone: '(999) 999-9999 ext 9',
                    Description: 'Long-time wire client',
                    Owner: ownerOf(adminEmail),
                },
            ]);
            const [caller, odd] = bigin.seed('Contacts', [
                {
                    First_Name: 'Nan',
                    Last_Name: 'Pa',
                    Email: `nanpa-${stamp}@phone.example`,
                    Phone: '999.999.9999',
                    Mobile: '1 (999) 999-9998',
                    Description: 'Prefers mornings',
                    Account_Name: { id: account!.id },
                    Owner: ownerOf(memberEmail),
                },
                {
                    First_Name: 'Odd',
                    Last_Name: 'Number',
                    Email: `odd-${stamp}@phone.example`,
                    Phone: '555-1234',
                    Owner: ownerOf(adminEmail),
                },
            ]);
            const [deal] = bigin.seed('Deals', [
                {
                    Deal_Name: 'Phone Co release',
                    Stage: 'New',
                    Account_Name: { id: account!.id },
                    Contact_Name: { id: caller!.id },
                    Description: 'Two releases',
                    Title_of_Press_Release: 'Phone Co rings in the year',
                    Owner: ownerOf(adminEmail),
                },
            ]);
            ids.phoneAccount = account!.id;
            ids.caller = caller!.id;
            ids.phoneDeal = deal!.id;

            const run = await runToEnd('changes');
            expect(run.status, run.error ?? '').toBe('succeeded');
            expect(run.failedRecords, JSON.stringify(run.report.flatMap((r) => r.errors))).toBe(0);

            const person = await owner.person.findUniqueOrThrow({
                where: { id: (await linkOf('Contacts', caller!.id))!.localId },
            });
            expect(person.phones).toEqual({
                primary: { number: '9999999999', countryCode: 'US' },
                additional: [{ number: '9999999998', countryCode: 'US' }],
            });
            expect(person.custom).toMatchObject({ description: 'Prefers mornings' });
            expect((person.custom as Record<string, unknown>).phone_unparsed).toBeUndefined();
            const oddPerson = await owner.person.findUniqueOrThrow({
                where: { id: (await linkOf('Contacts', odd!.id))!.localId },
            });
            expect(oddPerson.phones).toEqual({ primary: null, additional: [] });
            expect(oddPerson.custom).toMatchObject({ phone_unparsed: 'Phone: 555-1234' });
            const unparsed = await owner.customFieldDefinition.findFirstOrThrow({
                where: { workspaceId: workspace, object: 'person', key: 'phone_unparsed' },
            });
            expect(unparsed).toMatchObject({ label: 'Phone (as in Bigin)', type: 'text' });

            const company = await owner.company.findUniqueOrThrow({
                where: { id: (await linkOf('Accounts', account!.id))!.localId },
            });
            expect(company.custom).toMatchObject({
                phone: '+1 9999999999 ext 9',
                description: 'Long-time wire client',
            });
            const opportunity = await owner.opportunity.findUniqueOrThrow({
                where: { id: (await linkOf('Deals', deal!.id))!.localId },
            });
            expect(opportunity.custom).toMatchObject({
                description: 'Two releases',
                press_release_title: 'Phone Co rings in the year',
            });
            const defs = await owner.customFieldDefinition.findMany({
                where: { workspaceId: workspace, key: { in: ['phone', 'description', 'press_release_title'] } },
                select: { object: true, key: true, type: true },
            });
            expect(defs).toEqual(
                expect.arrayContaining([
                    { object: 'company', key: 'phone', type: 'text' },
                    { object: 'company', key: 'description', type: 'text' },
                    { object: 'person', key: 'description', type: 'text' },
                    { object: 'opportunity', key: 'description', type: 'text' },
                    { object: 'opportunity', key: 'press_release_title', type: 'text' },
                ]),
            );
        });

        it('a custom field edited here keeps its value; Bigin’s other fields, custom ones included, still apply', async () => {
            const personId = (await linkOf('Contacts', ids.caller))!.localId;
            // Bigin's record was modified before the local edit: Bigin's description loses, its title applies.
            bigin.update('Contacts', ids.caller, {
                Description: 'From Bigin again',
                Title: 'Editor',
                PR_LINK: 'https://pr.example/nan',
            });
            await new Promise((resolve) => setTimeout(resolve, 1100));
            const edited = await as(admin)
                .patch(w(`/people/${personId}`))
                .send({ custom: { description: 'Edited here' } });
            expect(edited.status, JSON.stringify(edited.body)).toBe(200);
            const run = await runToEnd('changes');
            expect(run.status).toBe('succeeded');
            const person = await owner.person.findUniqueOrThrow({ where: { id: personId } });
            expect(person.jobTitle).toBe('Editor');
            expect(person.custom).toMatchObject({ description: 'Edited here', pr_link: 'https://pr.example/nan' });
            expect(reportOf(run, 'Contacts').kept).toEqual(
                expect.arrayContaining([{ externalId: ids.caller, fields: ['custom.description'] }]),
            );
        });

        it('tasks, events and calls are tasks on their records, assigned by owner; none is told to its assignee; a second run changes nothing', async () => {
            // As Bigin answers a task asked for `What_Id`/`Who_Id` (the fake leaves the links out unless asked):
            // the record as `Related_To`, its module as `$related_module`, `$se_module` null.
            const [task, done, alone] = bigin.seed('Tasks', [
                {
                    Subject: 'Send the draft',
                    Status: 'In Progress',
                    Priority: 'High',
                    Due_Date: '2026-01-15',
                    Description: 'Before the embargo',
                    $se_module: null,
                    Related_To: { id: ids.phoneDeal, name: 'Phone Co release' },
                    $related_module: 'Deals',
                    Who_Id: { id: ids.caller },
                    Owner: ownerOf(memberEmail),
                },
                {
                    Subject: 'Confirm invoice',
                    Status: 'Completed',
                    Closed_Time: '2026-02-01T10:00:00+00:00',
                    $se_module: null,
                    Related_To: { id: ids.phoneAccount, name: 'Phone Co' },
                    $related_module: 'Accounts',
                    Owner: ownerOf(memberEmail),
                },
                { Subject: 'On nothing', Status: 'Not Started', Owner: ownerOf(memberEmail) },
            ]);
            const [event] = bigin.seed('Events', [
                {
                    Event_Title: 'Kick-off',
                    Start_DateTime: '2026-03-01T09:00:00-05:00',
                    End_DateTime: '2026-03-01T10:00:00-05:00',
                    Venue: 'Zoom',
                    Related_To: { id: ids.caller, module: { api_name: 'Contacts' } },
                    Owner: ownerOf(memberEmail),
                },
            ]);
            const [call] = bigin.seed('Calls', [
                {
                    Subject: 'Intro',
                    Call_Start_Time: '2026-04-01T15:00:00+00:00',
                    Call_Duration: '05:30',
                    Call_Type: 'Outbound',
                    Call_Result: 'Interested',
                    $se_module: 'Contacts',
                    What_Id: { id: ids.caller },
                    Owner: ownerOf(memberEmail),
                },
            ]);

            const run = await runToEnd('changes');
            expect(run.status, run.error ?? '').toBe('succeeded');
            expect(counts(reportOf(run, 'Tasks'))).toMatchObject({ read: 3, created: 2, skipped: 1, failed: 0 });
            expect(reportOf(run, 'Tasks').errors).toEqual([
                { externalId: alone!.id, message: 'its record is not in BylineCRM' },
            ]);
            expect(counts(reportOf(run, 'Events'))).toMatchObject({ read: 1, created: 1, failed: 0 });
            expect(counts(reportOf(run, 'Calls'))).toMatchObject({ read: 1, created: 1, failed: 0 });

            const personId = (await linkOf('Contacts', ids.caller))!.localId;
            const taskOf = async (object: BiginImportObject, externalId: string) => {
                const link = (await linkOf(object, externalId))!;
                expect(link.localType).toBe('task');
                return owner.task.findUniqueOrThrow({ where: { id: link.localId }, include: { targets: true } });
            };
            const open = await taskOf('Tasks', task!.id);
            expect(open).toMatchObject({
                title: 'Send the draft',
                status: 'in_progress',
                assigneeId: memberMemberId,
                completedAt: null,
                dueAt: new Date('2026-01-15T00:00:00.000Z'),
            });
            expect(open.bodyText).toContain('Before the embargo');
            expect(open.bodyText).toContain('Priority: High');
            expect(open.createdBy).toEqual({ kind: 'import', id: run.id });
            expect(open.targets.map((t) => `${t.targetType}:${t.targetId}`).sort()).toEqual(
                [`opportunity:${(await linkOf('Deals', ids.phoneDeal))!.localId}`, `person:${personId}`].sort(),
            );
            const closed = await taskOf('Tasks', done!.id);
            expect(closed).toMatchObject({ status: 'done', completedAt: new Date('2026-02-01T10:00:00.000Z') });
            expect(closed.targets.map((t) => t.targetType)).toEqual(['company']);
            const meeting = await taskOf('Events', event!.id);
            expect(meeting).toMatchObject({
                title: 'Meeting: Kick-off',
                status: 'done',
                dueAt: new Date('2026-03-01T14:00:00.000Z'),
                completedAt: new Date('2026-03-01T15:00:00.000Z'),
            });
            expect(meeting.targets.map((t) => `${t.targetType}:${t.targetId}`)).toEqual([`person:${personId}`]);
            expect(meeting.bodyText).toContain('Venue: Zoom');
            const called = await taskOf('Calls', call!.id);
            expect(called).toMatchObject({ title: 'Call: Intro', status: 'done', assigneeId: memberMemberId });
            expect(called.bodyText).toContain('Result: Interested');

            // Nobody is told of a task an import brought over — not as assigned, not as due — while a member
            // handing one over still tells its assignee.
            const imported = [open.id, closed.id, meeting.id, called.id];
            const handed = await as(admin)
                .post(w('/tasks'))
                .send({
                    title: 'Handed over',
                    assigneeId: memberMemberId,
                    targets: [{ type: 'person', id: personId }],
                });
            expect(handed.status, JSON.stringify(handed.body)).toBe(201);
            await settle(app);
            await app.get(TaskNotificationsService).remindDue();
            expect(await owner.notification.count({ where: { taskId: { in: imported } } })).toBe(0);
            expect(
                await owner.notification.count({
                    where: { taskId: (handed.body as { id: string }).id, kind: 'task_assigned' },
                }),
            ).toBe(1);

            // A status set here after Bigin last changed the task stays; Bigin's other changes apply.
            bigin.update('Tasks', task!.id, { Subject: 'Send the final draft' });
            // Read again unchanged in Bigin: nothing to write.
            bigin.update('Tasks', done!.id, {});
            bigin.update('Events', event!.id, {});
            bigin.update('Calls', call!.id, {});
            await new Promise((resolve) => setTimeout(resolve, 1100));
            const marked = await as(member)
                .patch(w(`/tasks/${open.id}`))
                .send({ status: 'done' });
            expect(marked.status, JSON.stringify(marked.body)).toBe(200);

            const again = await runToEnd('changes');
            expect(again.status).toBe('succeeded');
            expect(counts(reportOf(again, 'Tasks'))).toMatchObject({
                created: 0,
                updated: 1,
                unchanged: 1,
                skipped: 1,
            });
            expect(reportOf(again, 'Tasks').kept).toEqual([
                { externalId: task!.id, fields: ['completedAt', 'status'] },
            ]);
            expect(counts(reportOf(again, 'Events'))).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
            expect(counts(reportOf(again, 'Calls'))).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
            expect(await taskOf('Tasks', task!.id)).toMatchObject({ title: 'Send the final draft', status: 'done' });
            expect(
                await owner.task.count({
                    where: { workspaceId: workspace, createdBy: { path: ['kind'], equals: 'import' } },
                }),
            ).toBe(4);

            // Bigin deleting a call flags it for review; its task stays.
            bigin.remove('Calls', call!.id);
            const third = await runToEnd('changes');
            expect(reportOf(third, 'Calls').missingInSource).toBe(1);
            expect((await linkOf('Calls', call!.id))!.missingSince).not.toBeNull();
            expect((await owner.task.findUniqueOrThrow({ where: { id: called.id } })).deletedAt).toBeNull();
        });
    });
});
