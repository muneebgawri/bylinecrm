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
    type TwentyImportRunView,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { BiginImportWorkers } from '../../src/bigin-import/bigin-import.workers';
import { BiginImportRunner } from '../../src/bigin-import/import-runner';
import { ENV, parseEnv } from '../../src/config/env';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { TwentyImportRunner } from '../../src/twenty-import/import-runner';
import { FakeBigin } from '../support/fake-bigin';
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
        | 'orphan';
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
            .send({ name: 'Globex', domain: `globex-${stamp}.com` });
        expect(globex.status, JSON.stringify(globex.body)).toBe(201);
        ids.existingCompany = (globex.body as { id: string }).id;
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
            expect(overview.linked.map((l) => l.count)).toEqual([0, 0, 0, 0]);
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
});
