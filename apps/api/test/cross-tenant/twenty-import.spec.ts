import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    SYSTEM_ROLES,
    TWENTY_IMPORT_OBJECTS,
    TWENTY_IMPORT_SOURCE,
    TWENTY_LIST_VIEW_PREFIX,
    TWENTY_SYNC_INTERVAL_MS,
    type TwentyImportMode,
    type TwentyImportObject,
    type TwentyImportObjectReport,
    type TwentyImportOverview,
    type TwentyImportPreview,
    type TwentyImportRunView,
    type TwentyImportSettingsView,
    type TwentyImportSyncView,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import type { VerifiedIdentity } from '../../src/auth/auth.service';
import { OidcService } from '../../src/auth/oidc.service';
import { ENV, parseEnv, type Env } from '../../src/config/env';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { TwentyImportRunner } from '../../src/twenty-import/import-runner';
import { TWENTY_IMPORT_QUEUE } from '../../src/twenty-import/twenty-import.constants';
import { TwentyImportWorkers } from '../../src/twenty-import/twenty-import.workers';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { FakeTwenty, type FakeTwentyRecord } from '../support/fake-twenty';
import { deliverMail, mailTo, verifyAddress } from '../support/mail';
import { eventLog, settle, type EventLog } from '../support/outbox';

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

interface ApiError {
    code: string;
    message: string;
    fieldErrors?: { path: string; message: string }[];
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
    createdBy: { kind: string; id: string | null };
}
interface DealRow {
    id: string;
    name: string;
    amount: { amountMinor: number; currency: string } | null;
    stage: { name: string; kind: string };
    lostReason: string | null;
    closedAt: string | null;
    pointOfContactId: string | null;
    companyId: string | null;
    ownerId: string | null;
    custom: Record<string, unknown>;
}

const link = (url: string) => ({ primaryLinkUrl: url, primaryLinkLabel: '', secondaryLinks: [] });
const money = (amountMicros: number | null, currencyCode: string | null) => ({ amountMicros, currencyCode });

/**
 * The Twenty importer (P4-4, doc 48 §11) end to end against a fake Twenty REST API: the connection
 * (the key sealed, never shown again), the counts before a run, a run that maps every object by its
 * Twenty id into the records BylineCRM has — merging into existing people and companies by email and
 * domain, closing imported deals through the one stage writer, attaching notes and tasks, turning
 * lead lookups into FR-CRMS-10 exclusions — a repeated run that changes nothing, a `changes` run that
 * reads only what moved, a cancel, and one workspace never seeing another's import.
 */
describe('P4-4 (doc 48 §11) Twenty importer', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let runner: TwentyImportRunner;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);
    const twenty = new FakeTwenty();
    /** The configuration, mutable so a test can close sign-up (#184). */
    let env: Env;
    /** The identity the fake provider answers the next callback with (#184: a member's first Google sign-in). */
    let nextIdentity: VerifiedIdentity | null = null;
    const fakeOidc: Pick<OidcService, 'available' | 'start' | 'finish'> = {
        available: () => ['fake'],
        start: () => Promise.resolve(new URL('https://idp.example/authorize')),
        finish: () => {
            if (!nextIdentity) throw new Error('no identity queued for the fake provider');
            return Promise.resolve(nextIdentity);
        },
    };

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const adminEmail = `twenty-admin-${stamp}@example.com`;
    const memberEmail = `twenty-member-${stamp}@example.com`;
    const otherEmail = `twenty-other-${stamp}@example.com`;
    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let adminMemberId: string;
    let log: EventLog;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const err = (res: Response) => res.body as ApiError;

    // The Twenty records, seeded once; later tests change a few.
    const existingPersonEmail = `dana-${stamp}@acme.example`;
    const ids: Record<string, string> = {};
    let firstRun: TwentyImportRunView;

    const reportOf = (run: TwentyImportRunView, object: TwentyImportObject): TwentyImportObjectReport =>
        run.report.find((r) => r.object === object)!;
    const counts = (r: TwentyImportObjectReport) => ({
        read: r.read,
        created: r.created,
        updated: r.updated,
        unchanged: r.unchanged,
        merged: r.merged,
        skipped: r.skipped,
        failed: r.failed,
    });
    const zero = { read: 0, created: 0, updated: 0, unchanged: 0, merged: 0, skipped: 0, failed: 0 };

    async function startRun(mode: TwentyImportMode = 'full'): Promise<TwentyImportRunView> {
        const res = await as(admin).post(w('/import/twenty/runs')).send({ mode });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        return res.body as TwentyImportRunView;
    }
    async function runToEnd(mode: TwentyImportMode = 'full'): Promise<TwentyImportRunView> {
        const queued = await startRun(mode);
        await runner.run(queued.id);
        const res = await as(admin).get(w(`/import/twenty/runs/${queued.id}`));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as TwentyImportRunView;
    }
    async function people(): Promise<PersonRow[]> {
        const res = await as(admin).get(w('/people?limit=100'));
        expect(res.status).toBe(200);
        return (res.body as Listed<PersonRow>).items;
    }
    /** The deals as the API lists them, each with its stage's name and kind looked up (the view carries the id). */
    async function deals(): Promise<DealRow[]> {
        const res = await as(admin).get(w('/opportunities?limit=100'));
        expect(res.status).toBe(200);
        const stages = await owner.pipelineStage.findMany({ where: { workspaceId: workspace } });
        return (res.body as Listed<DealRow & { stageId: string }>).items.map((d) => {
            const stage = stages.find((s) => s.id === d.stageId)!;
            return { ...d, stage: { name: stage.name, kind: stage.kind } };
        });
    }

    beforeAll(async () => {
        await twenty.start();
        env = { ...parseEnv(process.env), SIGNUP_MODE: 'open' };
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(ENV)
            .useValue(env)
            .overrideProvider(OidcService)
            .useValue(fakeOidc)
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        runner = app.get(TwentyImportRunner);
        log = await eventLog(app, 'person.*', 'deal.*', 'company.*');

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Twenty ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other twenty ${stamp}`));

        const me = await as(admin).get(w('/me'));
        adminMemberId = (me.body as { memberId: string }).memberId;

        // A member who is not an admin, to show the importer is an admin's.
        const roles = await as(admin).get(w('/roles'));
        const memberRoleId = (roles.body as { id: string; name: string }[]).find(
            (r) => r.name === SYSTEM_ROLES.member,
        )!.id;
        const invite = await as(admin).post(w('/invites')).send({ email: memberEmail, roleId: memberRoleId });
        expect(invite.status, JSON.stringify(invite.body)).toBe(201);
        const token = (invite.body as { token: string }).token;
        const accepted = await http().post(`/api/auth/invites/${token}/signup`).send({ password });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
        member = browserFrom(accepted);
        await verifyAddress(app, http, memberEmail);

        // A person who exists before the import, with an email Twenty also has: the import must merge into it.
        const existing = await as(admin)
            .post(w('/people'))
            .send({
                nameFirst: 'Dana',
                nameLast: 'Existing',
                emails: { primary: existingPersonEmail, additional: [] },
            });
        expect(existing.status, JSON.stringify(existing.body)).toBe(201);
        ids.existingPerson = (existing.body as { id: string }).id;

        // The Twenty workspace, as the ledger describes Pinion's (parity/LEDGER.md, "Pinion workspace objects").
        const [m1, m2] = twenty.seed('workspaceMembers', [
            { name: { firstName: 'Admin', lastName: 'Person' }, userEmail: adminEmail.toUpperCase(), salesTeam: true },
            { name: { firstName: 'Nobody', lastName: 'Here' }, userEmail: `nobody-${stamp}@example.com` },
        ]);
        const [c1, c2] = twenty.seed('companies', [
            {
                name: 'Robert Half',
                domainName: link('https://www.roberthalf.com/'),
                employees: 120,
                idealCustomerProfile: true,
                annualRecurringRevenue: money(1_250_000_000, 'USD'),
                address: {
                    addressStreet1: '1 Main St',
                    addressCity: 'Menlo Park',
                    addressState: 'CA',
                    addressPostcode: '94025',
                    addressCountry: 'US',
                },
                linkedinLink: link(''),
                xLink: link(''),
                accountOwnerId: m1!.id,
                biginrecordid: 'zcrm_c1',
                stripeltv: money(null, 'USD'),
            },
            { name: 'How 2 Media', domainName: link(''), accountOwnerId: m2!.id, biginrecordid: '' },
        ]);
        const [p1, p2, p3] = twenty.seed('people', [
            {
                name: { firstName: 'Matthew', lastName: 'Croteau' },
                emails: { primaryEmail: 'Matthew.Croteau@roberthalf.com', additionalEmails: [] },
                phones: {
                    primaryPhoneNumber: '9782522121',
                    primaryPhoneCountryCode: 'US',
                    primaryPhoneCallingCode: '+1',
                    additionalPhones: [],
                },
                jobTitle: 'VP Marketing',
                city: 'Boston',
                linkedinLink: link(''),
                xLink: link(''),
                companyId: c1!.id,
                personOwnerId: m1!.id,
                inboundLeadSource: 'MANUAL',
                prLink: 'https://www.newswire.ca/news-releases/robert-half',
                emailStatus: 'DELIVERABLE',
                enrichedAt: '2026-10-02T16:24:11.794Z',
            },
            {
                name: { firstName: 'Dana', lastName: 'FromTwenty' },
                emails: { primaryEmail: existingPersonEmail, additionalEmails: [] },
                jobTitle: 'Editor',
                personOwnerId: m2!.id,
            },
            {
                name: { firstName: 'Josh', lastName: '' },
                emails: { primaryEmail: '', additionalEmails: [] },
                companyId: c2!.id,
            },
        ]);
        // Journalists exist in Twenty but are not read (D-252): the fake holds the object so a read of it would answer, and none happens.
        twenty.seed('journalists', [{ name: 'Ada Byron', outlet: 'The Times' }]);
        const [o1, o2, o3] = twenty.seed('opportunities', [
            {
                name: 'Open deal',
                amount: money(12_500_000_000, 'USD'),
                closeDate: null,
                stage: 'NEW',
                lostReason: null,
                companyId: c1!.id,
                pointOfContactId: p1!.id,
                ownerId: m1!.id,
                leadfollowupstage: 'First Followup Done',
                gatekeeperblocked: false,
            },
            {
                name: 'Won deal',
                amount: money(5_000_000_000, 'USD'),
                closeDate: '2024-12-05T00:00:00.000Z',
                stage: 'CUSTOMER',
                lostReason: null,
                companyId: c1!.id,
            },
            {
                name: 'Lost deal',
                amount: money(null, null),
                stage: 'CLOSED_LOST',
                lostReason: 'NO_RESPONSE',
                objectioncategory: 'TIMING',
            },
        ]);
        twenty.seed('notes', [
            {
                title: 'voice mail',
                bodyV2: { markdown: 'Left a message.\n\nCall back Monday.' },
                createdBy: { source: 'MANUAL', workspaceMemberId: m1!.id, name: 'Admin' },
                noteTargets: [
                    { id: 'nt-1', noteId: 'later', targetPersonId: p1!.id },
                    { id: 'nt-2', targetCompanyId: c1!.id },
                ],
            },
            {
                title: 'on a lookup',
                bodyV2: { markdown: 'nothing here' },
                createdBy: { source: 'API' },
                noteTargets: [{ id: 'nt-3', targetLeadLookupId: 'll-x' }],
            },
        ]);
        twenty.seed('tasks', [
            {
                title: 'Follow up',
                bodyV2: { markdown: '' },
                status: 'DONE',
                dueAt: '2026-10-20T09:00:00.000Z',
                assigneeId: m1!.id,
                taskTargets: [{ id: 'tt-1', targetOpportunityId: o1!.id }],
            },
        ]);
        const [l1] = twenty.seed('leadLookups', [
            {
                name: '',
                email: `raphael-${stamp}@comexposium.example`,
                status: 'Assigned',
                assignedToName: 'Tom Lane',
                assignedToEmail: 'tom@example.com',
            },
            {
                name: '',
                email: `free-${stamp}@example.com`,
                status: 'Unassigned',
                assignedToName: '',
                assignedToEmail: '',
            },
        ]);
        twenty.seed('leadViews', [
            {
                firstName: 'Margaret',
                lastName: 'McKoin',
                email: `magaret-${stamp}@thetimegroup.example`,
                phone: '+18949294879',
                companyName: 'Thetimegroup',
                leadId: 'lead-1',
                personId: null,
                assignedAm: 'Steve Hardy',
                assignedAmMemberId: m1!.id,
                lifetimeValue: money(2_500_000_000, 'USD'),
                opportunityStage: '',
                leadCreatedAt: '2026-08-08T08:01:48.082Z',
            },
            {
                firstName: 'Matthew',
                lastName: 'Croteau',
                email: 'matthew.croteau@roberthalf.com',
                personId: p1!.id,
                leadId: 'lead-7',
                assignedAm: 'Admin Person',
                lifetimeValue: money(null, null),
            },
        ]);
        const [ml1] = twenty.seed('messageLists', [{ name: 'Tech press', description: 'Journalists we brief' }]);
        twenty.seed('messageListMembers', [
            { listId: ml1!.id, personId: p1!.id },
            // A member whose person is not a Twenty person (a journalist's id): no home here, skipped.
            { listId: ml1!.id, personId: 'not-a-person' },
        ]);
        twenty.seed('messageCampaigns', [
            {
                name: 'Launch',
                subject: 'Hello',
                bodyTemplate: 'Hi\n\nThanks.',
                fromAddress: { primaryEmail: 'news@example.com' },
                status: 'SENT',
                sentCount: 10,
                listId: ml1!.id,
            },
        ]);

        Object.assign(ids, {
            m1: m1!.id,
            c1: c1!.id,
            c2: c2!.id,
            p1: p1!.id,
            p2: p2!.id,
            p3: p3!.id,
            o1: o1!.id,
            o2: o2!.id,
            o3: o3!.id,
            l1: l1!.id,
            ml1: ml1!.id,
        });
    }, 60_000);

    afterAll(async () => {
        await app?.close();
        await twenty.close();
    });

    describe('the connection', () => {
        it('starts unconfigured, and is an admin’s to see and set', async () => {
            const res = await as(admin).get(w('/import/twenty'));
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const overview = res.body as TwentyImportOverview;
            expect(overview.settings).toEqual({
                createMembers: null,
                configured: false,
                baseUrl: null,
                apiKeyLast4: null,
                configuredBy: null,
                updatedAt: null,
            });
            expect(overview.latestRun).toBeNull();
            expect(overview.linked.map((l) => l.object)).toEqual([...TWENTY_IMPORT_OBJECTS]);
            expect(overview.linked.every((l) => l.count === 0)).toBe(true);

            expect((await as(member).get(w('/import/twenty'))).status).toBe(403);
            expect(
                (await as(member).put(w('/import/twenty/settings')).send({ baseUrl: twenty.baseUrl, apiKey: 'x' }))
                    .status,
            ).toBe(403);
        });

        it('stores the key sealed and shows only its last four characters; the base URL is checked', async () => {
            const bad = await as(admin)
                .put(w('/import/twenty/settings'))
                .send({ baseUrl: 'not a url', apiKey: 'abcd1234' });
            expect(bad.status).toBe(400);
            expect(err(bad).fieldErrors?.map((f) => f.path)).toContain('baseUrl');

            const res = await as(admin)
                .put(w('/import/twenty/settings'))
                .send({ baseUrl: `${twenty.baseUrl}/`, apiKey: 'wrong-key-9876' });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const view = res.body as TwentyImportSettingsView;
            expect(view).toMatchObject({
                configured: true,
                baseUrl: twenty.baseUrl,
                apiKeyLast4: '9876',
                configuredBy: adminMemberId,
            });
            expect(JSON.stringify(res.body)).not.toContain('wrong-key');
            const stored = await owner.twentyImportSettings.findUniqueOrThrow({ where: { workspaceId: workspace } });
            expect(stored.apiKeyCiphertext).not.toContain('wrong-key');
            expect(stored.apiKeyCiphertext.startsWith('v1.')).toBe(true);
        });

        it('a preview with a key Twenty refuses says so at the key; a run cannot start on it', async () => {
            const res = await as(admin).post(w('/import/twenty/preview'));
            expect(res.status, JSON.stringify(res.body)).toBe(422);
            expect(err(res).fieldErrors).toEqual([{ path: 'apiKey', message: expect.stringMatching(/refused/i) }]);
            const run = await as(admin).post(w('/import/twenty/runs')).send({ mode: 'full' });
            expect(run.status).toBe(422);
        });

        it('a preview with the right key counts every object in Twenty beside what is mapped here', async () => {
            const put = await as(admin)
                .put(w('/import/twenty/settings'))
                .send({ baseUrl: twenty.baseUrl, apiKey: twenty.apiKey });
            expect(put.status).toBe(200);
            const res = await as(admin).post(w('/import/twenty/preview'));
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const preview = res.body as TwentyImportPreview;
            const remote = Object.fromEntries(preview.objects.map((o) => [o.object, o.remote]));
            expect(remote).toEqual({
                workspaceMembers: 2,
                companies: 2,
                people: 3,
                opportunities: 3,
                notes: 2,
                tasks: 1,
                leadLookups: 2,
                leadViews: 2,
                messageLists: 1,
                messageListMembers: 2,
                messageCampaigns: 1,
            });
            expect(preview.objects.every((o) => o.linked === 0 && o.error === null)).toBe(true);
        });
    });

    describe('a full run', () => {
        it('is queued once: a second start while one is queued or running is refused', async () => {
            const queued = await startRun();
            expect(queued).toMatchObject({ status: 'queued', mode: 'full', phase: null, startedBy: adminMemberId });
            const again = await as(admin).post(w('/import/twenty/runs')).send({ mode: 'full' });
            expect(again.status).toBe(409);
            await runner.run(queued.id);
            const res = await as(admin).get(w(`/import/twenty/runs/${queued.id}`));
            firstRun = res.body as TwentyImportRunView;
            expect(firstRun.status, JSON.stringify(firstRun.report)).toBe('succeeded');
            expect(firstRun.startedAt).not.toBeNull();
            expect(firstRun.finishedAt).not.toBeNull();
        });

        it('reports, per object, what Twenty held and what the run did', () => {
            const by = Object.fromEntries(firstRun.report.map((r) => [r.object, r]));
            expect(firstRun.report.map((r) => r.object)).toEqual([...TWENTY_IMPORT_OBJECTS]);
            expect(counts(by.workspaceMembers!)).toEqual({ ...zero, read: 2, created: 1, skipped: 1 });
            expect(by.workspaceMembers!.errors[0]).toMatchObject({ message: expect.stringMatching(/no member/i) });
            expect(counts(by.companies!)).toEqual({ ...zero, read: 2, created: 2 });
            expect(counts(by.people!)).toEqual({ ...zero, read: 3, created: 2, merged: 1 });
            expect(counts(by.opportunities!)).toEqual({ ...zero, read: 3, created: 3 });
            expect(counts(by.notes!)).toEqual({ ...zero, read: 2, created: 1, skipped: 1 });
            expect(counts(by.tasks!)).toEqual({ ...zero, read: 1, created: 1 });
            expect(counts(by.leadLookups!)).toEqual({ ...zero, read: 2, created: 1, skipped: 1 });
            expect(counts(by.leadViews!)).toEqual({ ...zero, read: 2, created: 1, updated: 1 });
            expect(counts(by.messageLists!)).toEqual({ ...zero, read: 1, created: 1 });
            expect(counts(by.messageListMembers!)).toEqual({ ...zero, read: 2, updated: 1, skipped: 1 });
            expect(counts(by.messageCampaigns!)).toEqual({ ...zero, read: 1, created: 1 });
            for (const r of firstRun.report) {
                expect(r.remote, r.object).toBe(r.read);
                expect(r.before, r.object).toBe(0);
                expect(r.after, r.object).toBe(r.created + r.merged + r.updated + r.unchanged);
            }
        });

        it('companies: fields, owner through the member match, Twenty’s extra fields as custom fields', async () => {
            const res = await as(admin).get(w('/companies?limit=100'));
            const rows = (
                res.body as Listed<{
                    name: string;
                    domain: string | null;
                    employeeCount: number | null;
                    icp: boolean;
                    arr: unknown;
                    ownerId: string | null;
                    custom: Record<string, unknown>;
                    address: { city: string | null };
                }>
            ).items;
            const rh = rows.find((c) => c.name === 'Robert Half')!;
            expect(rh).toMatchObject({
                domain: 'roberthalf.com',
                employeeCount: 120,
                icp: true,
                arr: { amountMinor: 125000, currency: 'USD' },
                ownerId: adminMemberId,
                address: { city: 'Menlo Park' },
            });
            expect(rh.custom).toMatchObject({ biginrecordid: 'zcrm_c1', stripeltv_currency: 'USD' });
            expect(rows.find((c) => c.name === 'How 2 Media')).toMatchObject({ domain: null, ownerId: null });
            const fields = await as(admin).get(w('/custom-fields?object=company'));
            expect((fields.body as { key: string; type: string }[]).map((f) => [f.key, f.type])).toEqual(
                expect.arrayContaining([
                    ['biginrecordid', 'text'],
                    ['stripeltv_currency', 'text'],
                ]),
            );
        });

        it('people: created by the import, linked to their company and owner, merged by email into who was already here', async () => {
            const rows = await people();
            const matthew = rows.find((p) => p.emails.primary === 'matthew.croteau@roberthalf.com')!;
            expect(matthew).toMatchObject({
                nameFirst: 'Matthew',
                nameLast: 'Croteau',
                jobTitle: 'VP Marketing',
                ownerId: adminMemberId,
                source: `${TWENTY_IMPORT_SOURCE}:manual`,
            });
            expect(matthew.companyId).not.toBeNull();
            expect(matthew.createdBy).toEqual({ kind: 'import', id: firstRun.id });
            expect(matthew.custom).toMatchObject({
                pr_link: 'https://www.newswire.ca/news-releases/robert-half',
                email_status: 'DELIVERABLE',
            });
            expect(rows.filter((p) => p.emails.primary === 'matthew.croteau@roberthalf.com')).toHaveLength(1);

            const dana = rows.find((p) => p.id === ids.existingPerson)!;
            expect(dana, 'the person who existed was updated, not duplicated').toMatchObject({
                nameLast: 'FromTwenty',
                jobTitle: 'Editor',
            });
            expect(rows.filter((p) => p.emails.primary === existingPersonEmail)).toHaveLength(1);

            // Journalists are not imported (D-252): nobody here carries the journalist's address.
            expect(rows.find((p) => p.emails.primary === 'ada@thetimes.example')).toBeUndefined();
            expect(rows.find((p) => p.nameFirst === 'Josh')).toMatchObject({ source: TWENTY_IMPORT_SOURCE });
        });

        it('deals: amounts in minor units, the stage by name in the default pipeline, closed ones closed through the stage writer', async () => {
            const rows = await deals();
            const open = rows.find((d) => d.name === 'Open deal')!;
            expect(open).toMatchObject({
                amount: { amountMinor: 1250000, currency: 'USD' },
                stage: { name: 'New', kind: 'open' },
                ownerId: adminMemberId,
                closedAt: null,
            });
            expect(open.pointOfContactId).not.toBeNull();
            expect(open.companyId).not.toBeNull();
            expect(open.custom).toMatchObject({ leadfollowupstage: 'First Followup Done', gatekeeperblocked: false });
            const won = rows.find((d) => d.name === 'Won deal')!;
            expect(won).toMatchObject({ stage: { name: 'Customer', kind: 'won' } });
            expect(won.closedAt).not.toBeNull();
            const lost = rows.find((d) => d.name === 'Lost deal')!;
            expect(lost).toMatchObject({
                stage: { name: 'Closed lost', kind: 'lost' },
                lostReason: 'No response',
                amount: null,
            });
            const history = await owner.opportunityStageHistory.findMany({
                where: { opportunityId: lost.id },
                orderBy: { enteredAt: 'asc' },
            });
            expect(history.map((h) => [h.reason, h.toStageName])).toEqual([
                ['import', 'New'],
                ['close', 'Closed lost'],
            ]);
            const stages = await owner.pipelineStage.findMany({
                where: { workspaceId: workspace },
                orderBy: { position: 'asc' },
            });
            // The two stages Twenty had and the pipeline did not were added at the end, in the order the deals were read.
            expect(stages.slice(0, 6).map((s) => s.name)).toEqual([
                'New',
                'Contacted',
                'Replied',
                'Meeting',
                'Won',
                'Lost',
            ]);
            expect(
                stages
                    .slice(6)
                    .map((s) => [s.name, s.kind])
                    .sort(),
            ).toEqual([
                ['Closed lost', 'lost'],
                ['Customer', 'won'],
            ]);
        });

        it('notes and tasks sit on the records they were on, with their author and assignee; a note with no home is skipped', async () => {
            const matthew = (await people()).find((p) => p.emails.primary === 'matthew.croteau@roberthalf.com')!;
            const notes = await as(admin).get(w(`/notes?target=person:${matthew.id}`));
            expect(notes.status).toBe(200);
            const note = (
                notes.body as Listed<{
                    title: string;
                    bodyText: string;
                    authorId: string | null;
                    targets: { type: string }[];
                }>
            ).items[0]!;
            expect(note).toMatchObject({
                title: 'voice mail',
                bodyText: 'Left a message.\nCall back Monday.',
                authorId: adminMemberId,
            });
            expect(note.targets.map((t) => t.type).sort()).toEqual(['company', 'person']);
            const open = (await deals()).find((d) => d.name === 'Open deal')!;
            const tasks = await as(admin).get(w(`/tasks?target=opportunity:${open.id}`));
            const task = (
                tasks.body as Listed<{
                    title: string;
                    status: string;
                    completedAt: string | null;
                    assigneeId: string | null;
                    dueAt: string | null;
                }>
            ).items[0]!;
            expect(task).toMatchObject({
                title: 'Follow up',
                status: 'done',
                assigneeId: adminMemberId,
                dueAt: '2026-10-20T09:00:00.000Z',
            });
            expect(task.completedAt).not.toBeNull();
            const skipped = reportOf(firstRun, 'notes').errors;
            expect(skipped).toEqual([
                { externalId: twenty.all('notes')[1]!.id, message: expect.stringMatching(/no target/i) },
            ]);
        });

        it('FR-CRMS-10: an assigned lead lookup is an outreach exclusion naming its account manager, from Twenty', async () => {
            const res = await as(admin).get(w('/outreach/exclusions'));
            expect(res.status).toBe(200);
            const rows = res.body as {
                address: string | null;
                reason: string;
                accountManagerName: string | null;
                source: string;
                externalRef: string | null;
            }[];
            expect(rows).toEqual([
                expect.objectContaining({
                    address: `raphael-${stamp}@comexposium.example`,
                    reason: 'account_managed',
                    accountManagerName: 'Tom Lane',
                    source: TWENTY_IMPORT_SOURCE,
                    externalRef: ids.l1,
                }),
            ]);
        });

        it('lead views: a lead with a Twenty person adds its fields to them; one without becomes a person', async () => {
            const rows = await people();
            const matthew = rows.find((p) => p.emails.primary === 'matthew.croteau@roberthalf.com')!;
            expect(matthew.custom).toMatchObject({ lead_id: 'lead-7', lead_assigned_am: 'Admin Person' });
            const margaret = rows.find((p) => p.emails.primary === `magaret-${stamp}@thetimegroup.example`)!;
            expect(margaret).toMatchObject({
                nameFirst: 'Margaret',
                nameLast: 'McKoin',
                source: `${TWENTY_IMPORT_SOURCE}:lead`,
            });
            expect(margaret.custom).toMatchObject({
                lead_id: 'lead-1',
                lead_assigned_am: 'Steve Hardy',
                lead_lifetime_value: 2500,
                lead_lifetime_value_currency: 'USD',
                lead_company_name: 'Thetimegroup',
            });
        });

        it('message lists: the "Lists" field on people names each list a person is on, and each list has a shared view', async () => {
            const rows = await people();
            const matthew = rows.find((p) => p.emails.primary === 'matthew.croteau@roberthalf.com')!;
            expect(matthew.custom.lists).toEqual(['Tech press']);
            const views = await as(admin).get(w('/views?object=person'));
            expect(views.status).toBe(200);
            const view = (views.body as { name: string; isShared: boolean; filter: unknown }[]).find(
                (v) => v.name === `${TWENTY_LIST_VIEW_PREFIX}Tech press`,
            )!;
            expect(view).toMatchObject({
                isShared: true,
                filter: { and: [{ field: 'custom.lists', op: 'contains', value: 'Tech press' }] },
            });
            const fields = await as(admin).get(w('/custom-fields?object=person'));
            expect(
                (fields.body as { key: string; type: string; options: string[] }[]).find((f) => f.key === 'lists'),
            ).toMatchObject({ type: 'multiselect', options: ['Tech press'] });
        });

        it('campaigns: an outreach template with the campaign’s name, subject and body', async () => {
            const res = await as(admin).get(w('/templates?kind=outreach'));
            expect(res.status).toBe(200);
            const launch = (res.body as Listed<{ name: string; subject: string; kind: string }>).items.find(
                (t) => t.name === 'Launch',
            );
            expect(launch).toMatchObject({ kind: 'outreach', subject: 'Hello' });
        });

        it('every imported record was announced as the import’s, through the outbox, with the run as the actor', async () => {
            await settle(app);
            const events = await log.read();
            const created = events.filter((e) => e.type === 'person.created' && e.actor.kind === 'import');
            expect(created.length).toBe(3); // Matthew, Josh and the lead's Margaret; Dana existed
            expect(created.every((e) => e.actor.id === firstRun.id)).toBe(true);
            expect(events.some((e) => e.type === 'deal.won')).toBe(true);
            expect(events.some((e) => e.type === 'deal.lost')).toBe(true);
            const timeline = await owner.timelineActivity.count({
                where: { workspaceId: workspace, kind: 'person.created' },
            });
            expect(timeline).toBeGreaterThanOrEqual(3);
        });

        it('the overview now shows what is mapped, and the latest run', async () => {
            const res = await as(admin).get(w('/import/twenty'));
            const overview = res.body as TwentyImportOverview;
            expect(overview.latestRun?.id).toBe(firstRun.id);
            const linked = Object.fromEntries(overview.linked.map((l) => [l.object, l.count]));
            expect(linked).toMatchObject({
                workspaceMembers: 1,
                companies: 2,
                people: 3,
                opportunities: 3,
                notes: 1,
                tasks: 1,
                leadLookups: 1,
                leadViews: 2,
                messageLists: 1,
                messageCampaigns: 1,
            });
        });
    });

    describe('running again', () => {
        it('a second full run changes nothing: every record is mapped already and unchanged', async () => {
            const before = await owner.person.count({ where: { workspaceId: workspace } });
            const run = await runToEnd('full');
            expect(run.status).toBe('succeeded');
            for (const r of run.report) {
                expect(r.created, r.object).toBe(0);
                expect(r.merged, r.object).toBe(0);
                expect(r.failed, r.object).toBe(0);
                expect(r.before, r.object).toBe(r.after);
            }
            expect(counts(reportOf(run, 'people'))).toEqual({ ...zero, read: 3, unchanged: 3 });
            expect(counts(reportOf(run, 'opportunities'))).toEqual({ ...zero, read: 3, unchanged: 3 });
            expect(counts(reportOf(run, 'leadLookups'))).toEqual({ ...zero, read: 2, unchanged: 1, skipped: 1 });
            expect(await owner.person.count({ where: { workspaceId: workspace } })).toBe(before);
            expect(await owner.opportunityStageHistory.count({ where: { workspaceId: workspace } })).toBe(5);
        });

        it('a changes run reads only what Twenty changed since the last successful run, and applies it', async () => {
            const previous = (await as(admin).get(w('/import/twenty/runs'))).body as TwentyImportRunView[];
            const lastStart = previous[0]!.startedAt!;
            const later = new Date(Date.parse(lastStart) + 60_000).toISOString();
            twenty.update('people', ids.p1!, { jobTitle: 'CMO' }, later);
            twenty.update('leadLookups', ids.l1!, { status: 'Unassigned', assignedToName: '' }, later);
            twenty.update('opportunities', ids.o1!, { stage: 'PROPOSAL' }, later);

            const run = await runToEnd('changes');
            expect(run.status, JSON.stringify(run.report)).toBe('succeeded');
            expect(run.since).toBe(lastStart);
            expect(counts(reportOf(run, 'people'))).toEqual({ ...zero, read: 1, updated: 1 });
            expect(counts(reportOf(run, 'companies'))).toEqual(zero);
            expect(counts(reportOf(run, 'leadLookups'))).toEqual({ ...zero, read: 1, updated: 1 });
            expect(counts(reportOf(run, 'opportunities'))).toEqual({ ...zero, read: 1, updated: 1 });

            const matthew = (await people()).find((p) => p.emails.primary === 'matthew.croteau@roberthalf.com')!;
            expect(matthew.jobTitle).toBe('CMO');
            const exclusions = (await as(admin).get(w('/outreach/exclusions'))).body as unknown[];
            expect(exclusions, 'the released address is no longer excluded').toEqual([]);
            const open = (await deals()).find((d) => d.name === 'Open deal')!;
            expect(open.stage).toMatchObject({ name: 'Proposal', kind: 'open' });
        });

        it('a cancelled run stops where it is and says so', async () => {
            const queued = await startRun('full');
            const cancel = await as(admin).post(w(`/import/twenty/runs/${queued.id}/cancel`));
            expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
            expect((cancel.body as TwentyImportRunView).cancelRequested).toBe(true);
            await runner.run(queued.id);
            const res = await as(admin).get(w(`/import/twenty/runs/${queued.id}`));
            expect((res.body as TwentyImportRunView).status).toBe('cancelled');
            const again = await startRun('full');
            expect(again.status).toBe('queued');
            await runner.run(again.id);
        });

        it('#156 D-252: a reconcile run flags records Twenty no longer returns as missing in source, for review — never deletes them', async () => {
            twenty.remove('companies', ids.c2!);
            const link = await owner.twentyImportLink.findFirstOrThrow({
                where: { workspaceId: workspace, object: 'companies', externalId: ids.c2! },
            });
            const run = await runToEnd('reconcile');
            expect(run.status, run.error ?? '').toBe('succeeded');
            expect(run.mode).toBe('reconcile');
            const companies = reportOf(run, 'companies');
            expect(companies.missingInSource).toBe(1);
            expect(companies.read).toBe(companies.remote);
            for (const r of run.report) if (r.object !== 'companies') expect(r.missingInSource, r.object).toBe(0);
            // A reconcile pass writes no record: the counts of a pass that imports stay zero.
            expect(counts(companies)).toEqual({ ...zero, read: companies.read });

            // The flag is on the link, for a person to review; the record itself is untouched.
            const listed = (await as(admin).get(w('/import/twenty/missing'))).body as {
                items: {
                    object: string;
                    externalId: string;
                    localType: string;
                    localId: string;
                    name: string | null;
                    missingSince: string;
                }[];
                nextCursor: string | null;
            };
            expect(listed.items).toEqual([
                {
                    object: 'companies',
                    externalId: ids.c2!,
                    localType: 'company',
                    localId: link.localId,
                    name: expect.any(String),
                    missingSince: expect.any(String),
                },
            ]);
            expect((await as(admin).get(w(`/companies/${link.localId}`))).status).toBe(200);
            expect(await owner.company.count({ where: { id: link.localId, deletedAt: null } })).toBe(1);

            // Back in Twenty, the next run that sees it clears the flag.
            twenty.restore('companies', ids.c2!);
            const again = await runToEnd('full');
            expect(reportOf(again, 'companies').missingInSource).toBeNull();
            expect(((await as(admin).get(w('/import/twenty/missing'))).body as { items: unknown[] }).items).toEqual([]);
            // Another workspace reads none of it.
            expect(
                ((await as(otherAdmin).get(w('/import/twenty/missing', otherWorkspace))).body as { items: unknown[] })
                    .items,
            ).toEqual([]);
        });

        it('#168: a record that fails to map or write counts as Failed with its reason and Twenty id; the run goes on', async () => {
            // Twenty would never send this, but a bad record is what the issue is about: its timestamp does
            // not parse, so writing its link throws something that is not a service's refusal.
            const [bad] = twenty.seed('companies', [
                {
                    name: `Broken ${stamp}`,
                    domainName: { primaryLinkUrl: `https://broken-${stamp}.example` },
                    updatedAt: 'not a date',
                },
            ]);
            const run = await runToEnd('full');
            expect(run.status, run.error ?? '').toBe('succeeded');
            expect(run.error).toBeNull();
            const companies = reportOf(run, 'companies');
            expect(companies.failed).toBe(1);
            expect(companies.errors).toContainEqual({ externalId: bad!.id, message: expect.stringMatching(/date/i) });
            // The page's other records were written as if the bad one were not there.
            expect(companies.read).toBe(3);
            expect(companies.unchanged).toBe(2);
            expect(await owner.company.count({ where: { workspaceId: workspace, name: `Broken ${stamp}` } })).toBe(0);
            for (const r of run.report) if (r.object !== 'companies') expect(r.failed, r.object).toBe(0);
        });

        it('the run list is newest first and an admin’s', async () => {
            const res = await as(admin).get(w('/import/twenty/runs'));
            expect(res.status).toBe(200);
            const runs = res.body as TwentyImportRunView[];
            expect(runs.length).toBeGreaterThanOrEqual(4);
            expect(runs.map((r) => r.queuedAt)).toEqual([...runs.map((r) => r.queuedAt)].sort().reverse());
            expect((await as(member).get(w('/import/twenty/runs'))).status).toBe(403);
        });
    });

    /**
     * Scheduled sync (#185, P4-4f): a workspace setting makes the importer run its `changes` mode on
     * its own — one BullMQ scheduler per workspace, never two runs of one workspace, each run from
     * the last successful run's start — with the failures told to the admins after three in a row,
     * Twenty the source for the fields it maps unless a person edited one here more recently, and a
     * cutover that stops it for good.
     */
    describe('#185 P4-4f scheduled sync', () => {
        const DAY = 24 * 60 * 60 * 1000;
        let queue: Queue;
        let workers: TwentyImportWorkers;
        const schedulerId = (ws: string) => `sync:${ws}`;
        const overview = async (who = admin, ws = workspace) => {
            const res = await as(who).get(w('/import/twenty', ws));
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            return res.body as TwentyImportOverview;
        };
        const setSync = async (interval: string, who = admin, ws = workspace) =>
            as(who).put(w('/import/twenty/sync', ws)).send({ interval });
        const runOf = async (runId: string) => {
            const res = await as(admin).get(w(`/import/twenty/runs/${runId}`));
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            return res.body as TwentyImportRunView;
        };
        const lastSuccessStart = async () => {
            const runs = (await as(admin).get(w('/import/twenty/runs'))).body as TwentyImportRunView[];
            return runs.find((r) => r.status === 'succeeded')!.startedAt!;
        };
        /** The last run finished long ago, as far as the schedule's backoff is concerned. */
        const ageLastRun = (runId: string) =>
            owner.twentyImportRun.update({
                where: { id: runId },
                data: { finishedAt: new Date(Date.now() - 2 * DAY) },
            });

        beforeAll(() => {
            queue = app.get<Queue>(getQueueToken(TWENTY_IMPORT_QUEUE));
            workers = app.get(TwentyImportWorkers);
        });

        it('is a workspace setting, off by default: one scheduler per workspace at the interval — replaced, never added — and none when off', async () => {
            expect((await overview()).sync).toEqual({
                interval: 'off',
                nextRunAt: null,
                failures: 0,
                lastError: null,
                cutoverAt: null,
            } satisfies TwentyImportSyncView);
            expect(await queue.getJobScheduler(schedulerId(workspace))).toBeUndefined();

            const on = await setSync('15m');
            expect(on.status, JSON.stringify(on.body)).toBe(200);
            const view = on.body as TwentyImportSyncView;
            expect(view).toMatchObject({ interval: '15m', failures: 0, cutoverAt: null });
            // The first tick is at once (BullMQ runs an `every` scheduler's first job immediately), then every interval.
            const wait = Date.parse(view.nextRunAt!) - Date.now();
            expect(wait).toBeGreaterThan(-10_000);
            expect(wait).toBeLessThanOrEqual(TWENTY_SYNC_INTERVAL_MS['15m']);
            expect(await queue.getJobScheduler(schedulerId(workspace))).toMatchObject({
                every: TWENTY_SYNC_INTERVAL_MS['15m'],
                template: { data: { workspaceId: workspace } },
            });

            // A new interval replaces the scheduler; the workspace never has two.
            expect((await setSync('hourly')).body).toMatchObject({ interval: 'hourly' });
            expect(await queue.getJobScheduler(schedulerId(workspace))).toMatchObject({
                every: TWENTY_SYNC_INTERVAL_MS.hourly,
            });
            const mine = (await queue.getJobSchedulers(0, -1)).filter((s) => s.key.includes(workspace));
            expect(mine).toHaveLength(1);
            expect((await overview()).sync).toMatchObject({ interval: 'hourly' });

            // Off: no scheduler, nothing next.
            expect((await setSync('off')).body).toMatchObject({ interval: 'off', nextRunAt: null });
            expect(await queue.getJobScheduler(schedulerId(workspace))).toBeUndefined();

            expect((await setSync('weekly')).status).toBe(400);
            // Without a connection there is nothing to sync: a 422 at the key, as a run start says.
            const elsewhere = await setSync('15m', otherAdmin, otherWorkspace);
            expect(elsewhere.status).toBe(422);
            expect(err(elsewhere).fieldErrors).toEqual([{ path: 'apiKey', message: expect.any(String) }]);
            expect((await setSync('15m', member)).status).toBe(403);
        });

        it('a tick starts one changes run from the last successful run’s start, marked automatic — and never a second while one is queued or running', async () => {
            expect((await setSync('hourly')).status).toBe(200);
            const since = await lastSuccessStart();
            const runId = await workers.tick(workspace);
            expect(runId).toBeTruthy();
            expect(await runOf(runId!)).toMatchObject({
                status: 'queued',
                mode: 'changes',
                scheduled: true,
                since,
                startedBy: null,
            });
            // The run lock the importer has: a second tick starts nothing, a person's start is refused.
            expect(await workers.tick(workspace)).toBeNull();
            expect((await as(admin).post(w('/import/twenty/runs')).send({ mode: 'changes' })).status).toBe(409);
            await runner.run(runId!);
            expect((await runOf(runId!)).status).toBe('succeeded');
            expect((await overview()).sync).toMatchObject({ failures: 0, lastError: null });
        });

        it('a run that fails keeps the cursor and the schedule backs off; three failures in a row tell the admins once; a success resets', async () => {
            const since = await lastSuccessStart();
            const failOnce = async () => {
                twenty.failNext(401, 1);
                const runId = (await workers.tick(workspace))!;
                expect(runId).toBeTruthy();
                await runner.run(runId);
                const run = await runOf(runId);
                expect(run).toMatchObject({ status: 'failed', scheduled: true, since });
                expect(run.error).toBeTruthy();
                return run;
            };
            // Due now: the last scheduled run is old.
            const previous = (await as(admin).get(w('/import/twenty/runs'))).body as TwentyImportRunView[];
            await ageLastRun(previous[0]!.id);
            let last = await failOnce();
            expect((await overview()).sync).toMatchObject({ failures: 1, lastError: last.error });
            // Backing off: the next try waits twice the interval after the failed run — not now.
            expect(await workers.tick(workspace)).toBeNull();
            await ageLastRun(last.id);
            last = await failOnce();
            expect((await overview()).sync).toMatchObject({ failures: 2 });
            await deliverMail(app);
            expect(mailTo(adminEmail, 'twenty_sync_failing')).toHaveLength(0);
            await ageLastRun(last.id);
            last = await failOnce();
            expect((await overview()).sync).toMatchObject({ failures: 3, lastError: last.error });
            await deliverMail(app);
            // The third failure in a row tells every admin of the workspace — once — and nobody else.
            const notices = mailTo(adminEmail, 'twenty_sync_failing');
            expect(notices).toHaveLength(1);
            expect(notices[0]!.text).toContain(last.error);
            expect(notices[0]!.text).toContain(`/w/${workspace}/settings/import-twenty`);
            expect(mailTo(memberEmail, 'twenty_sync_failing')).toHaveLength(0);
            expect(mailTo(otherEmail, 'twenty_sync_failing')).toHaveLength(0);
            // It keeps trying, and a fourth failure is not a second notice.
            await ageLastRun(last.id);
            last = await failOnce();
            expect((await overview()).sync).toMatchObject({ failures: 4 });
            await deliverMail(app);
            expect(mailTo(adminEmail, 'twenty_sync_failing')).toHaveLength(1);
            // Twenty answers again: the run resumes from the last successful run's start, and the streak ends.
            await ageLastRun(last.id);
            const runId = (await workers.tick(workspace))!;
            await runner.run(runId);
            expect(await runOf(runId)).toMatchObject({ status: 'succeeded', since });
            expect((await overview()).sync).toMatchObject({ failures: 0, lastError: null });
        });

        it('precedence: Twenty is the source for the fields it maps, but a field edited here after Twenty last touched the record keeps BylineCRM’s value and counts as a conflict — until Twenty changes the record again', async () => {
            const matthew = (await people()).find((p) => p.emails.primary === 'matthew.croteau@roberthalf.com')!;
            twenty.update('people', ids.p1!, { city: 'Lyon' }, new Date().toISOString());
            await new Promise((resolve) => setTimeout(resolve, 5));
            const edited = await as(admin)
                .patch(w(`/people/${matthew.id}`))
                .send({ jobTitle: 'Head of Growth' });
            expect(edited.status, JSON.stringify(edited.body)).toBe(200);
            await settle(app);

            const previous = (await as(admin).get(w('/import/twenty/runs'))).body as TwentyImportRunView[];
            await ageLastRun(previous[0]!.id);
            const runId = (await workers.tick(workspace))!;
            await runner.run(runId);
            const run = await runOf(runId);
            expect(run.status, JSON.stringify(run.report)).toBe('succeeded');
            const report = reportOf(run, 'people');
            expect(counts(report)).toEqual({ ...zero, read: 1, updated: 1 });
            expect(report.conflicts).toBe(1);
            expect(report.kept).toEqual([{ externalId: ids.p1, fields: ['jobTitle'] }]);
            let person = (await people()).find((p) => p.id === matthew.id)!;
            expect(person.jobTitle).toBe('Head of Growth');
            expect((person as unknown as { city: string | null }).city).toBe('Lyon');

            // Twenty changes the record after the edit here: Twenty's value applies, nothing is kept.
            twenty.update('people', ids.p1!, { jobTitle: 'CMO' }, new Date().toISOString());
            await ageLastRun(runId);
            const again = (await workers.tick(workspace))!;
            await runner.run(again);
            const second = reportOf(await runOf(again), 'people');
            expect(counts(second)).toEqual({ ...zero, read: 1, updated: 1 });
            expect(second.conflicts).toBe(0);
            expect(second.kept).toEqual([]);
            person = (await people()).find((p) => p.id === matthew.id)!;
            expect(person.jobTitle).toBe('CMO');
        });

        it('Stop syncing (cutover) disables the schedule and records the moment; a tick after it starts nothing; another workspace has no schedule to see or stop', async () => {
            const before = ((await as(admin).get(w('/import/twenty/runs'))).body as TwentyImportRunView[]).length;
            const stop = await as(admin).post(w('/import/twenty/sync/cutover'));
            expect(stop.status, JSON.stringify(stop.body)).toBe(200);
            const view = stop.body as TwentyImportSyncView;
            expect(view).toMatchObject({ interval: 'off', nextRunAt: null });
            expect(Date.now() - Date.parse(view.cutoverAt!)).toBeLessThan(10_000);
            expect(await queue.getJobScheduler(schedulerId(workspace))).toBeUndefined();
            expect(await workers.tick(workspace)).toBeNull();
            expect(((await as(admin).get(w('/import/twenty/runs'))).body as TwentyImportRunView[]).length).toBe(before);
            expect((await overview()).sync).toMatchObject({ interval: 'off', cutoverAt: view.cutoverAt });
            // Syncing again is a decision that undoes the cutover.
            expect((await setSync('daily')).body).toMatchObject({ interval: 'daily', cutoverAt: null });
            expect((await setSync('off')).body).toMatchObject({ interval: 'off', cutoverAt: null });

            expect((await overview(otherAdmin, otherWorkspace)).sync).toMatchObject({
                interval: 'off',
                cutoverAt: null,
                failures: 0,
            });
            expect((await as(otherAdmin).post(w('/import/twenty/sync/cutover', otherWorkspace))).status).toBe(422);
            expect((await as(member).post(w('/import/twenty/sync/cutover'))).status).toBe(403);
        });
    });

    describe('cross-tenant', () => {
        it('another workspace sees no connection, no runs and none of the imported records', async () => {
            const overview = (await as(otherAdmin).get(w('/import/twenty', otherWorkspace)))
                .body as TwentyImportOverview;
            expect(overview.settings.configured).toBe(false);
            expect(overview.latestRun).toBeNull();
            expect(overview.linked.every((l) => l.count === 0)).toBe(true);
            expect((await as(otherAdmin).get(w(`/import/twenty/runs/${firstRun.id}`, otherWorkspace))).status).toBe(
                404,
            );
            expect(
                (await as(otherAdmin).post(w(`/import/twenty/runs/${firstRun.id}/cancel`, otherWorkspace))).status,
            ).toBe(404);
            expect((await as(otherAdmin).get(w('/import/twenty/runs', otherWorkspace))).body).toEqual([]);
            const theirs = (await as(otherAdmin).get(w('/people?limit=100', otherWorkspace))).body as Listed<PersonRow>;
            expect(theirs.items.map((p) => p.emails.primary)).not.toContain('matthew.croteau@roberthalf.com');
            // The links, settings and runs are the workspace's own rows: nothing of them is readable across.
            expect(await owner.twentyImportLink.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
            expect(await owner.twentyImportRun.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
        });

        it('a run id from another workspace cannot be driven there', async () => {
            const theirs = await as(otherAdmin)
                .put(w('/import/twenty/settings', otherWorkspace))
                .send({ baseUrl: twenty.baseUrl, apiKey: twenty.apiKey });
            expect(theirs.status).toBe(200);
            const queued = (await as(otherAdmin).post(w('/import/twenty/runs', otherWorkspace)).send({ mode: 'full' }))
                .body as TwentyImportRunView;
            expect((await as(admin).get(w(`/import/twenty/runs/${queued.id}`))).status).toBe(404);
            await runner.run(queued.id);
            const done = (await as(otherAdmin).get(w(`/import/twenty/runs/${queued.id}`, otherWorkspace)))
                .body as TwentyImportRunView;
            expect(done.status).toBe('succeeded');
            // Their import made their own people, mapped to the same Twenty ids, in their workspace only.
            expect(reportOf(done, 'people').created).toBe(3);
            expect(
                await owner.twentyImportLink.count({ where: { workspaceId: otherWorkspace, object: 'people' } }),
            ).toBe(3);
            const removed = await as(otherAdmin).delete(w('/import/twenty/settings', otherWorkspace));
            expect(removed.status).toBe(204);
            expect(
                ((await as(otherAdmin).get(w('/import/twenty', otherWorkspace))).body as TwentyImportOverview).settings
                    .configured,
            ).toBe(false);
        });
    });

    describe('#184 P4-4e accounts for Twenty members who are not here yet', () => {
        const nobodyEmail = `nobody-${stamp}@example.com`;
        const patEmail = `pat-${stamp}@example.com`;
        const goneEmail = `gone-${stamp}@example.com`;
        const idleEmail = `idle-${stamp}@example.com`;
        let amRoleId: string;
        let gone: FakeTwentyRecord;
        const runWith = async (body: Record<string, unknown>): Promise<TwentyImportRunView> => {
            const res = await as(admin).post(w('/import/twenty/runs')).send(body);
            expect(res.status, JSON.stringify(res.body)).toBe(202);
            const queued = res.body as TwentyImportRunView;
            await runner.run(queued.id);
            const read = await as(admin).get(w(`/import/twenty/runs/${queued.id}`));
            return read.body as TwentyImportRunView;
        };
        const seatOf = (email: string) =>
            owner.workspaceMember.findFirst({
                where: { workspaceId: workspace, user: { email } },
                include: { user: true, role: true },
            });
        const memberRows = async () =>
            (await as(admin).get(w('/members'))).body as { id: string; email: string; hasSignedIn: boolean }[];
        const companyOwner = async (name: string) =>
            (
                await owner.company.findFirstOrThrow({
                    where: { workspaceId: workspace, name },
                    select: { ownerId: true },
                })
            ).ownerId;

        it('previews how many accounts the option would create, and takes only a role of this workspace', async () => {
            const [, g, idle] = twenty.seed('workspaceMembers', [
                { name: { firstName: 'Pat', lastName: 'Manager' }, userEmail: patEmail },
                { name: { firstName: 'Gone', lastName: 'Owner' }, userEmail: goneEmail },
                { name: { firstName: 'Idle', lastName: 'Nobody' }, userEmail: idleEmail },
            ]);
            gone = g!;
            twenty.seed('companies', [
                { name: 'Gone Co', domainName: link(`https://gone-${stamp}.example`), accountOwnerId: gone.id },
            ]);
            // Deactivated in Twenty: one still owns a company, one owns nothing.
            twenty.remove('workspaceMembers', gone.id);
            twenty.remove('workspaceMembers', idle!.id);

            const preview = await as(admin).post(w('/import/twenty/preview'));
            expect(preview.status, JSON.stringify(preview.body)).toBe(200);
            // Nobody Here and Pat Manager; the admin is here already, the deactivated two are no accounts to create.
            expect((preview.body as TwentyImportPreview).accountsToCreate).toBe(2);

            const role = await as(admin)
                .post(w('/roles'))
                .send({ name: 'Account manager', capabilities: ['record:read', 'record:write', 'outreach:write'] });
            expect(role.status, JSON.stringify(role.body)).toBe(201);
            amRoleId = (role.body as { id: string }).id;

            const foreign = (
                (await as(otherAdmin).get(w('/roles', otherWorkspace))).body as { id: string; name: string }[]
            ).find((r) => r.name === SYSTEM_ROLES.member)!.id;
            const refused = await as(admin)
                .post(w('/import/twenty/runs'))
                .send({ mode: 'full', createMembers: { roleId: foreign } });
            expect(refused.status, JSON.stringify(refused.body)).toBe(422);
            expect(err(refused).fieldErrors?.[0]?.path).toBe('roleId');
        });

        it('creates each account (no password, unverified) and its seat with the chosen role, sends no mail, and attributes owners on the same run', async () => {
            const run = await runWith({ mode: 'full', createMembers: { roleId: amRoleId } });
            expect(run.status, run.error ?? JSON.stringify(run.report)).toBe('succeeded');
            expect(run.createMembers).toEqual({ roleId: amRoleId });
            // Nobody Here, Pat Manager, and Gone Owner (deactivated, but a company is theirs); not Idle Nobody.
            expect(run.accountsCreated).toBe(3);
            expect(counts(reportOf(run, 'workspaceMembers'))).toEqual({ ...zero, read: 3, created: 2, unchanged: 1 });

            for (const [email, name] of [
                [nobodyEmail, 'Nobody Here'],
                [patEmail, 'Pat Manager'],
            ] as const) {
                const seat = await seatOf(email);
                expect(seat, email).not.toBeNull();
                expect(seat!.user).toMatchObject({ passwordHash: null, emailVerifiedAt: null, displayName: name });
                expect(seat!).toMatchObject({ roleId: amRoleId, leftAt: null, source: 'twenty-import' });
                expect(
                    await owner.twentyImportLink.findFirst({
                        where: { workspaceId: workspace, object: 'workspaceMembers', localId: seat!.id },
                    }),
                ).toMatchObject({ localType: 'member' });
            }
            // The deactivated owner exists for the record's sake and has left: history is theirs, access is not.
            const left = await seatOf(goneEmail);
            expect(left!.leftAt).not.toBeNull();
            expect(left!.source).toBe('twenty-import');
            expect(await companyOwner('Gone Co')).toBe(left!.id);
            expect(await owner.user.count({ where: { email: idleEmail } })).toBe(0);
            // Owners resolve on the same run: a company the first import left unowned is theirs now.
            expect(await companyOwner('How 2 Media')).toBe((await seatOf(nobodyEmail))!.id);

            // The import sends nothing; the admin invites later, from Members.
            await deliverMail(app);
            for (const email of [nobodyEmail, patEmail, goneEmail]) expect(mailTo(email), email).toEqual([]);

            const rows = await memberRows();
            expect(rows.find((m) => m.email === nobodyEmail)).toMatchObject({ hasSignedIn: false });
            expect(rows.find((m) => m.email === patEmail)).toMatchObject({ hasSignedIn: false });
            expect(rows.find((m) => m.email === adminEmail)).toMatchObject({ hasSignedIn: true });
            expect(rows.find((m) => m.email === goneEmail)).toBeUndefined();
            const summary = (await as(admin).get(w('/members/summary'))).body as {
                memberId: string;
                leftAt: string | null;
            }[];
            expect(summary.find((m) => m.memberId === left!.id)?.leftAt).not.toBeNull();
        });

        it('is idempotent: a second run creates nothing twice, and a member who is here is matched, never duplicated', async () => {
            const again = await runWith({ mode: 'full', createMembers: { roleId: amRoleId } });
            expect(again.status, again.error ?? '').toBe('succeeded');
            expect(again.accountsCreated).toBe(0);
            expect(counts(reportOf(again, 'workspaceMembers'))).toEqual({ ...zero, read: 3, unchanged: 3 });
            expect(await owner.user.count({ where: { email: { in: [nobodyEmail, patEmail, goneEmail] } } })).toBe(3);
            expect(
                await owner.workspaceMember.count({
                    where: {
                        workspaceId: workspace,
                        user: { email: { in: [nobodyEmail, patEmail, goneEmail, adminEmail] } },
                    },
                }),
            ).toBe(4);
        });

        it('a Google sign-in by an imported member lands in the workspace while sign-up is closed', async () => {
            env.SIGNUP_MODE = 'closed';
            try {
                nextIdentity = { provider: 'fake', subject: `sub-${nobodyEmail}`, email: nobodyEmail.toUpperCase() };
                const res = await http().get('/api/auth/oidc/fake/callback?code=c&state=s').expect(302);
                expect(res.headers.location).toBe(env.WEB_URL);
                const signedIn = browserFrom(res);
                const spaces = await as(signedIn).get('/api/me/workspaces');
                expect(spaces.status, JSON.stringify(spaces.body)).toBe(200);
                expect((spaces.body as { id: string }[]).map((s) => s.id)).toEqual([workspace]);
                const user = await owner.user.findUniqueOrThrow({ where: { email: nobodyEmail } });
                expect(user.emailVerifiedAt).not.toBeNull();
                expect(await owner.user.count({ where: { email: nobodyEmail } })).toBe(1);
                expect((await memberRows()).find((m) => m.email === nobodyEmail)).toMatchObject({ hasSignedIn: true });
            } finally {
                env.SIGNUP_MODE = 'open';
            }
        });

        it('an admin sends the invitation later; accepting it sets a password on the account the import made, the same seat', async () => {
            const invite = await as(admin).post(w('/invites')).send({ email: patEmail, roleId: amRoleId });
            expect(invite.status, JSON.stringify(invite.body)).toBe(201);
            await deliverMail(app);
            expect(mailTo(patEmail, 'workspace_invitation')).toHaveLength(1);
            const seatBefore = (await seatOf(patEmail))!.id;

            const token = (invite.body as { token: string }).token;
            const accepted = await http().post(`/api/auth/invites/${token}/signup`).send({ password });
            expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
            const seat = await seatOf(patEmail);
            expect(seat!.id).toBe(seatBefore);
            expect(seat!.user.passwordHash).not.toBeNull();
            expect(await owner.user.count({ where: { email: patEmail } })).toBe(1);

            await verifyAddress(app, http, patEmail);
            const login = await http().post('/api/auth/login').send({ email: patEmail, password });
            expect(login.status, JSON.stringify(login.body)).toBe(200);
            const spaces = await as(browserFrom(login)).get('/api/me/workspaces');
            expect((spaces.body as { id: string }[]).map((s) => s.id)).toEqual([workspace]);
            expect((await memberRows()).find((m) => m.email === patEmail)).toMatchObject({ hasSignedIn: true });
        });

        it('#185: a scheduled run uses the workspace’s saved accounts choice and role — the last start’s — and never mails; a start without the option turns it off for the schedule too', async () => {
            const workers = app.get(TwentyImportWorkers);
            const samEmail = `sam-${stamp}@example.com`;
            const sueEmail = `sue-${stamp}@example.com`;
            const saved = async () =>
                ((await as(admin).get(w('/import/twenty'))).body as TwentyImportOverview).settings.createMembers;
            // The last start chose the account-manager role: that is the workspace's choice.
            expect(await saved()).toEqual({ roleId: amRoleId });
            // Seeded as just added in Twenty, so the schedule's changes run reads them.
            const [sam] = twenty.seed('workspaceMembers', [
                { name: { firstName: 'Sam', lastName: 'Scheduled' }, userEmail: samEmail },
            ]);
            twenty.update('workspaceMembers', sam!.id, {}, new Date().toISOString());
            expect((await as(admin).put(w('/import/twenty/sync')).send({ interval: 'hourly' })).status).toBe(200);
            const runId = (await workers.tick(workspace))!;
            expect(runId).toBeTruthy();
            await runner.run(runId);
            const run = (await as(admin).get(w(`/import/twenty/runs/${runId}`))).body as TwentyImportRunView;
            expect(run, run.error ?? JSON.stringify(reportOf(run, 'workspaceMembers'))).toMatchObject({
                status: 'succeeded',
                scheduled: true,
                createMembers: { roleId: amRoleId },
                accountsCreated: 1,
            });
            const seat = await seatOf(samEmail);
            expect(seat!.role.id).toBe(amRoleId);
            expect(seat!.user).toMatchObject({
                passwordHash: null,
                emailVerifiedAt: null,
                displayName: 'Sam Scheduled',
            });
            await deliverMail(app);
            expect(mailTo(samEmail)).toEqual([]);

            // A start without the option is the new choice: the schedule creates none either.
            const plain = await runWith({ mode: 'changes' });
            expect(plain.status).toBe('succeeded');
            expect(plain.createMembers).toBeNull();
            expect(await saved()).toBeNull();
            const [sue] = twenty.seed('workspaceMembers', [
                { name: { firstName: 'Sue', lastName: 'Later' }, userEmail: sueEmail },
            ]);
            twenty.update('workspaceMembers', sue!.id, {}, new Date().toISOString());
            const second = (await workers.tick(workspace))!;
            expect(second).toBeTruthy();
            await runner.run(second);
            const read = (await as(admin).get(w(`/import/twenty/runs/${second}`))).body as TwentyImportRunView;
            expect(read).toMatchObject({
                status: 'succeeded',
                scheduled: true,
                createMembers: null,
                accountsCreated: 0,
            });
            expect(await owner.user.count({ where: { email: sueEmail } })).toBe(0);
            expect((await as(admin).put(w('/import/twenty/sync')).send({ interval: 'off' })).status).toBe(200);
        });

        it('another workspace sees none of it', async () => {
            expect(
                await owner.workspaceMember.count({
                    where: { workspaceId: otherWorkspace, user: { email: { in: [nobodyEmail, patEmail, goneEmail] } } },
                }),
            ).toBe(0);
            const rows = (await as(otherAdmin).get(w('/members', otherWorkspace))).body as { email: string }[];
            expect(rows.map((m) => m.email)).toEqual([otherEmail]);
        });
    });
});
