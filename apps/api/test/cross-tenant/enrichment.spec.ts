import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    ENRICHMENT_DEFAULTS,
    ENRICHMENT_SOURCES,
    SESSION_COOKIE,
    type EnrichmentHistoryView,
    type EnrichmentSettingsView,
} from '@bylinecrm/shared';
import type { Queue } from 'bullmq';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { ENRICHMENT_QUEUE, enrichmentJobId } from '../../src/enrichment/enrichment.constants';
import { EnrichmentRunner } from '../../src/enrichment/enrichment-runner';
import { EnrichmentSweep } from '../../src/enrichment/enrichment-sweep';
import { ENRICHMENT_FETCH } from '../../src/enrichment/fetch.port';
import { PrismaService } from '../../src/infra/prisma.service';
import type { CompanyView, PersonView } from '../../src/records/responses';
import { DNS_PORT } from '../../src/sending-pool/dns.port';
import { FakeDns } from '../support/fake-dns';
import { FakeFetch } from '../support/fake-fetch';
import { verifyAddress } from '../support/mail';
import { EventLog, settle } from '../support/outbox';

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

const DAY_MS = 24 * 60 * 60 * 1000;

const homePage = (name: string, linkedin: string, x: string | null) => `<!doctype html><html><head>
<title>${name} | Home</title>
<meta property="og:site_name" content="${name}">
<meta property="og:image" content="/logo.png">
<link rel="icon" href="/favicon.ico">
</head><body><a href="${linkedin}">LinkedIn</a>${x ? `<a href="${x}">X</a>` : ''}</body></html>`;

/**
 * The enricher (P4-2, FR-CRMS-15) end to end against an in-memory web and DNS: free sources asked
 * outside any transaction, every answer stored with its source and the time it was asked, a field
 * overwritten only when the answer is better than what is there, no answer recorded as no answer,
 * a failed source as failed; the workspace's sources on or off and its re-ask age; a record enriched
 * on its own when it is created; and one workspace never seeing another's answers or settings.
 */
describe('FR-CRMS-15 enrichment', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let runner: EnrichmentRunner;
    let sweep: EnrichmentSweep;
    let queue: Queue;
    const dns = new FakeDns();
    const web = new FakeFetch();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;

    let n = 0;
    async function company(fields: Record<string, unknown>, who = admin, ws = workspace): Promise<CompanyView> {
        n += 1;
        const res = await as(who)
            .post(w('/companies', ws))
            .send({ name: `Company ${n}`, ...fields });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body as CompanyView;
    }
    async function person(fields: Record<string, unknown>): Promise<PersonView> {
        n += 1;
        const res = await as(admin)
            .post(w('/people'))
            .send({ nameFirst: `P${n}`, nameLast: 'Test', source: 'test list', ...fields });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body as PersonView;
    }
    const history = async (object: 'person' | 'company', id: string, who = admin, ws = workspace) => {
        const res = await as(who).get(w(`/enrichment/${object}/${id}`, ws));
        return { status: res.status, body: res.body as EnrichmentHistoryView };
    };
    const answer = (h: EnrichmentHistoryView, field: string, source?: string) =>
        h.answers.find((a) => a.field === field && (!source || a.source === source));
    /** Drops the record's queued job: no worker runs here, the runner is driven directly. */
    const drop = async (object: 'person' | 'company', id: string) => {
        await (await queue.getJob(enrichmentJobId(object, id)))?.remove();
    };
    const read = async (object: 'person' | 'company', id: string) =>
        (await as(admin).get(w(`/${object === 'person' ? 'people' : 'companies'}/${id}`))).body as CompanyView &
            PersonView;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(DNS_PORT)
            .useValue(dns)
            .overrideProvider(ENRICHMENT_FETCH)
            .useValue(web)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        runner = app.get(EnrichmentRunner);
        sweep = app.get(EnrichmentSweep);
        queue = app.get<Queue>(getQueueToken(ENRICHMENT_QUEUE));

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(`enr-admin-${stamp}@example.com`, `Enr ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(
            `enr-other-${stamp}@example.com`,
            `Other enr ${stamp}`,
        ));
    });

    afterAll(async () => {
        await app?.close();
    });

    it('FR-CRMS-15: settings — every free source on and a 90-day re-ask age unless set; an admin changes them; the range is refused with the field named', async () => {
        const initial = await as(admin).get(w('/enrichment/settings'));
        expect(initial.status).toBe(200);
        expect(initial.body).toEqual({
            reaskAfterDays: 90,
            sources: Object.fromEntries(ENRICHMENT_SOURCES.map((s) => [s, true])),
            isDefault: true,
            updatedAt: null,
        });
        expect(ENRICHMENT_DEFAULTS.reaskAfterDays).toBe(90);
        const set = await as(admin)
            .put(w('/enrichment/settings'))
            .send({ reaskAfterDays: 30, sources: { ...initial.body.sources, gravatar: false } });
        expect(set.status, JSON.stringify(set.body)).toBe(200);
        expect(set.body as EnrichmentSettingsView).toMatchObject({
            reaskAfterDays: 30,
            sources: { gravatar: false, website: true },
            isDefault: false,
        });
        for (const bad of [{ reaskAfterDays: 0 }, { reaskAfterDays: 366 }, { sources: { website: 'yes' } }]) {
            const res = await as(admin)
                .put(w('/enrichment/settings'))
                .send({ reaskAfterDays: 90, sources: initial.body.sources, ...bad });
            expect(res.status, JSON.stringify(bad)).toBe(400);
        }
        await as(admin)
            .put(w('/enrichment/settings'))
            .send({ reaskAfterDays: 90, sources: initial.body.sources })
            .expect(200);
    });

    it('FR-CRMS-15: Enrich now on a company asks the website and DNS; each answer is kept with its source and time; empty fields are filled; a member’s name is kept; no answer is no answer', async () => {
        const domain = `acme-${stamp}.example`;
        web.page(`https://${domain}/`, homePage('Acme Corporation', 'https://www.linkedin.com/company/acme/', null), {
            finalUrl: `https://www.${domain}/`,
        });
        dns.setMx(domain, 'aspmx.l.google.com');
        const c = await company({ name: 'Acme', domain });
        await settle(app);
        const before = await history('company', c.id);
        expect(before.status).toBe(200);
        expect(before.body).toMatchObject({ object: 'company', recordId: c.id, lastAskedAt: null, answers: [] });

        const log = await EventLog.open(app, ['company.updated']);
        const asked = await as(admin).post(w(`/enrichment/company/${c.id}`));
        expect(asked.status, JSON.stringify(asked.body)).toBe(202);
        expect(asked.body).toMatchObject({ pending: true });
        expect(await queue.getJob(enrichmentJobId('company', c.id))).toBeTruthy();
        // No worker in this suite: the runner is driven directly, as the job would.
        const report = await runner.enrich(workspace, 'company', c.id, { force: true });
        expect(report.asked.sort()).toEqual(['dns', 'website']);
        await drop('company', c.id);

        const after = (await history('company', c.id)).body;
        expect(after.lastAskedAt).not.toBeNull();
        expect(after.pending).toBe(false);
        const name = answer(after, 'name', 'website')!;
        expect(name).toMatchObject({ status: 'answered', value: 'Acme Corporation', applied: false });
        expect(Date.parse(name.askedAt)).toBeGreaterThan(Date.now() - 60_000);
        expect(answer(after, 'logo_url')).toMatchObject({
            status: 'answered',
            value: `https://www.${domain}/logo.png`,
            applied: true,
        });
        expect(answer(after, 'linkedin_url')).toMatchObject({
            value: 'https://www.linkedin.com/company/acme/',
            applied: true,
        });
        // The page named no X profile: no answer, with no value — never an empty string.
        expect(answer(after, 'x_url')).toMatchObject({ status: 'no_answer', value: null, applied: false });
        expect(answer(after, 'domain')).toMatchObject({ status: 'answered', value: domain, applied: false });
        expect(answer(after, 'mail_provider', 'dns')).toMatchObject({
            status: 'answered',
            value: 'google',
            applied: false,
        });

        const row = await read('company', c.id);
        expect(row.name).toBe('Acme');
        expect(row.logoUrl).toBe(`https://www.${domain}/logo.png`);
        expect(row.links.linkedin).toEqual({ url: 'https://www.linkedin.com/company/acme/', label: null });
        expect(row.links.x).toBeNull();
        // One update, by the system, recorded through the one outbox.
        const events = await log.read();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ actor: { kind: 'system' } });
        expect(Object.keys(events[0]!.diff ?? {}).sort()).toEqual(['links', 'logoUrl']);
    });

    it('FR-CRMS-15: better than what is there — an enrichment-written value gives way to an equal-or-better answer; a member’s never; a lower-ranked answer never', async () => {
        const domain = `better-${stamp}.example`;
        web.page(`https://${domain}/`, homePage('Better Inc', 'https://www.linkedin.com/company/better/', null));
        dns.setMx(domain, `mx.${domain}`);
        const c = await company({ name: 'Better', domain });
        await runner.enrich(workspace, 'company', c.id, { force: true });
        expect((await read('company', c.id)).links.linkedin?.url).toBe('https://www.linkedin.com/company/better/');

        // The site now names another profile: same source, same rank — the newer answer wins.
        web.page(`https://${domain}/`, homePage('Better Inc', 'https://www.linkedin.com/company/better-inc/', null));
        await runner.enrich(workspace, 'company', c.id, { force: true });
        expect((await read('company', c.id)).links.linkedin?.url).toBe('https://www.linkedin.com/company/better-inc/');

        // A member sets it by hand: enrichment never touches it again.
        await as(admin)
            .patch(w(`/companies/${c.id}`))
            .send({ links: { linkedin: { url: 'https://www.linkedin.com/company/ours/', label: null }, x: null } })
            .expect(200);
        web.page(`https://${domain}/`, homePage('Better Inc', 'https://www.linkedin.com/company/theirs/', null));
        await runner.enrich(workspace, 'company', c.id, { force: true });
        const h = (await history('company', c.id)).body;
        expect((await read('company', c.id)).links.linkedin?.url).toBe('https://www.linkedin.com/company/ours/');
        expect(h.answers.filter((a) => a.field === 'linkedin_url')[0]).toMatchObject({
            value: 'https://www.linkedin.com/company/theirs/',
            applied: false,
        });

        // The logo came from og:image (rank 2); a page with only an icon (rank 1) does not replace it.
        expect((await read('company', c.id)).logoUrl).toBe(`https://${domain}/logo.png`);
        web.page(`https://${domain}/`, `<title>Better</title><link rel="icon" href="/favicon.ico">`);
        await runner.enrich(workspace, 'company', c.id, { force: true });
        expect((await read('company', c.id)).logoUrl).toBe(`https://${domain}/logo.png`);
    });

    it('FR-CRMS-15 (#170): the website’s name is applied over a placeholder — empty, the domain, a bare host — and recorded like any field; a member’s name never', async () => {
        const domain = `named-${stamp}.example`;
        web.page(`https://${domain}/`, homePage('Named Properly Ltd', 'https://www.linkedin.com/company/named/', null));
        dns.setMx(domain, `mx.${domain}`);
        // An imported company is often named by its domain (the Twenty importer brings such rows).
        const byDomain = await company({ name: domain, domain });
        // Named by its host; its domain is its own (OWN-2c: `www.` is stripped, so it cannot share `domain`).
        const byHost = await company({ name: `www.host-${domain}`, domain: `www.host-${domain}` });
        const named = await company({ name: 'Named by a member', domain: `member-${domain}` });
        web.page(
            `https://host-${domain}/`,
            homePage('Named Properly Ltd', 'https://www.linkedin.com/company/named/', null),
        );
        web.page(
            `https://member-${domain}/`,
            homePage('Named Properly Ltd', 'https://www.linkedin.com/company/named/', null),
        );
        dns.setMx(`host-${domain}`, `mx.${domain}`);
        dns.setMx(`member-${domain}`, `mx.${domain}`);

        const log = await EventLog.open(app, ['company.updated']);
        for (const c of [byDomain, byHost, named]) await runner.enrich(workspace, 'company', c.id, { force: true });

        expect((await read('company', byDomain.id)).name).toBe('Named Properly Ltd');
        expect((await read('company', byHost.id)).name).toBe('Named Properly Ltd');
        expect((await read('company', named.id)).name).toBe('Named by a member');
        expect(answer((await history('company', byDomain.id)).body, 'name', 'website')).toMatchObject({
            value: 'Named Properly Ltd',
            applied: true,
        });
        expect(answer((await history('company', named.id)).body, 'name', 'website')).toMatchObject({
            value: 'Named Properly Ltd',
            applied: false,
        });
        // The overwrite is an update like any other: recorded, by the system, with the name in its diff.
        const events = (await log.read()).filter((e) => e.recordId === byDomain.id);
        expect(events).toHaveLength(1);
        expect(events[0]!.diff?.['name']).toEqual({ from: domain, to: 'Named Properly Ltd' });
    });

    it('FR-CRMS-15: a source that fails is recorded as failed, not as an empty value; a source turned off is not asked', async () => {
        const domain = `down-${stamp}.example`;
        web.fail(`https://${domain}/`);
        dns.setMx(domain, `mx.${domain}`);
        const c = await company({ name: 'Down', domain });
        await runner.enrich(workspace, 'company', c.id, { force: true });
        const h = (await history('company', c.id)).body;
        expect(answer(h, 'name', 'website')).toMatchObject({
            status: 'failed',
            value: null,
            note: expect.stringContaining(domain),
        });
        expect(answer(h, 'mail_provider', 'dns')).toMatchObject({ status: 'answered', value: 'other' });
        expect((await read('company', c.id)).logoUrl).toBeNull();

        const settings = (await as(admin).get(w('/enrichment/settings'))).body as EnrichmentSettingsView;
        await as(admin)
            .put(w('/enrichment/settings'))
            .send({ reaskAfterDays: 90, sources: { ...settings.sources, website: false } })
            .expect(200);
        const gets = web.gets.length;
        const report = await runner.enrich(workspace, 'company', c.id, { force: true });
        expect(report.asked).toEqual(['dns']);
        expect(web.gets.length).toBe(gets);
        await as(admin)
            .put(w('/enrichment/settings'))
            .send({ reaskAfterDays: 90, sources: settings.sources })
            .expect(200);
    });

    it('FR-CRMS-15: re-ask age — within it a run asks nothing again; past it the sweep queues the record and a run asks again', async () => {
        const domain = `age-${stamp}.example`;
        web.page(`https://${domain}/`, homePage('Age Co', 'https://www.linkedin.com/company/age/', null));
        dns.setMx(domain, `mx.${domain}`);
        const c = await company({ name: 'Age', domain });
        await runner.enrich(workspace, 'company', c.id, { force: true });
        await settle(app);
        await drop('company', c.id);
        const gets = web.gets.length;
        expect((await runner.enrich(workspace, 'company', c.id, { force: false })).asked).toEqual([]);
        expect(web.gets.length).toBe(gets);
        expect(await queue.getJob(enrichmentJobId('company', c.id))).toBeFalsy();

        await owner.enrichmentAnswer.updateMany({
            where: { workspaceId: workspace, recordId: c.id },
            data: { askedAt: new Date(Date.now() - 100 * DAY_MS) },
        });
        await sweep.run();
        expect(await queue.getJob(enrichmentJobId('company', c.id))).toBeTruthy();
        const report = await runner.enrich(workspace, 'company', c.id, { force: false });
        expect(report.asked.sort()).toEqual(['dns', 'website']);
        expect(web.gets.length).toBe(gets + 1);
    });

    it('FR-CRMS-15: a person — the avatar from Gravatar, the country from the address’s country domain; a company’s domain from its people’s addresses', async () => {
        const email = `tom-${stamp}@halepr.co.uk`;
        const hash = await sha256(email);
        web.exists(`https://gravatar.com/avatar/${hash}?d=404&s=256`);
        const p = await person({ emails: { primary: email, additional: [] } });
        const report = await runner.enrich(workspace, 'person', p.id, { force: true });
        expect(report.asked.sort()).toEqual(['email_domain', 'gravatar']);
        const row = await read('person', p.id);
        expect(row.avatarUrl).toBe(`https://gravatar.com/avatar/${hash}?d=404&s=256`);
        expect(row.country).toBe('GB');
        const h = (await history('person', p.id)).body;
        expect(answer(h, 'avatar_url', 'gravatar')).toMatchObject({ applied: true });
        expect(answer(h, 'country', 'email_domain')).toMatchObject({ value: 'GB', applied: true });

        const c = await company({ name: 'Hale PR' });
        await person({ emails: { primary: `ann-${stamp}@halepr.co.uk`, additional: [] }, companyId: c.id });
        await person({ emails: { primary: `bob-${stamp}@halepr.co.uk`, additional: [] }, companyId: c.id });
        await person({ emails: { primary: `cat-${stamp}@gmail.com`, additional: [] }, companyId: c.id });
        await runner.enrich(workspace, 'company', c.id, { force: true });
        expect((await read('company', c.id)).domain).toBe('halepr.co.uk');
        expect(answer((await history('company', c.id)).body, 'domain', 'email_domain')).toMatchObject({
            applied: true,
        });
    });

    it('FR-CRMS-15: a new company is enriched on its own — the outbox consumer queues its job', async () => {
        const c = await company({ name: 'Auto', domain: `auto-${stamp}.example` });
        await settle(app);
        expect(await queue.getJob(enrichmentJobId('company', c.id))).toBeTruthy();
    });

    it('a person a source never asked about is queued when opened and by the sweep; once asked, by neither', async () => {
        const p = await person({ emails: { primary: `una-${stamp}@example.com`, additional: [] } });
        await settle(app);
        await drop('person', p.id);
        // Opened: Gravatar and the address were never asked, so its run is queued.
        expect((await history('person', p.id)).body.pending).toBe(true);
        expect(await queue.getJob(enrichmentJobId('person', p.id))).toBeTruthy();
        await drop('person', p.id);
        // Nobody opens it: the sweep queues it, newest first.
        await sweep.run();
        expect(await queue.getJob(enrichmentJobId('person', p.id))).toBeTruthy();
        await drop('person', p.id);

        await runner.enrich(workspace, 'person', p.id, { force: false });
        expect((await history('person', p.id)).body.pending).toBe(false);
        await sweep.run();
        expect(await queue.getJob(enrichmentJobId('person', p.id))).toBeFalsy();

        // A person without an address has nothing to ask with: never queued.
        const bare = await person({});
        await settle(app);
        await drop('person', bare.id);
        expect((await history('person', bare.id)).body.pending).toBe(false);
        await sweep.run();
        expect(await queue.getJob(enrichmentJobId('person', bare.id))).toBeFalsy();
    });

    it('keeps answers and settings to their workspace', async () => {
        const domain = `mine-${stamp}.example`;
        web.page(`https://${domain}/`, homePage('Mine', 'https://www.linkedin.com/company/mine/', null));
        dns.setMx(domain, `mx.${domain}`);
        const c = await company({ name: 'Mine', domain });
        await runner.enrich(workspace, 'company', c.id, { force: true });
        expect((await history('company', c.id, otherAdmin, otherWorkspace)).status).toBe(404);
        expect((await as(otherAdmin).post(w(`/enrichment/company/${c.id}`, otherWorkspace))).status).toBe(404);
        await as(admin)
            .put(w('/enrichment/settings'))
            .send({ reaskAfterDays: 45, sources: ENRICHMENT_DEFAULTS.sources })
            .expect(200);
        expect((await as(otherAdmin).get(w('/enrichment/settings', otherWorkspace))).body).toMatchObject({
            reaskAfterDays: 90,
            isDefault: true,
        });
        expect(await owner.enrichmentAnswer.count({ where: { recordId: c.id } })).toBeGreaterThan(0);
        expect(await owner.enrichmentAnswer.count({ where: { recordId: c.id, workspaceId: otherWorkspace } })).toBe(0);
        await as(admin)
            .put(w('/enrichment/settings'))
            .send({ reaskAfterDays: 90, sources: ENRICHMENT_DEFAULTS.sources })
            .expect(200);
    });
});

async function sha256(text: string): Promise<string> {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}
