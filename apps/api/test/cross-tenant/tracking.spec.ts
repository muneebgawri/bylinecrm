import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_SCOPES,
    SESSION_COOKIE,
    type DomainEvent,
    type EnrolmentBatchResult,
    type SequenceView,
    type TrackingSettingsView,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { RateLimiter } from '../../src/auth/rate-limiter.service';
import { ENV, type Env } from '../../src/config/env';
import { DomainEvents } from '../../src/events/domain-events.service';
import { PrismaService } from '../../src/infra/prisma.service';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MailSendService } from '../../src/mail-send/mail-send.service';
import type { MailOutboundView } from '../../src/mail-send/responses';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { StageRulesService } from '../../src/pipelines/stage-rules.service';
import { DNS_PORT } from '../../src/sending-pool/dns.port';
import { SequenceRunner } from '../../src/sequences/sequence-runner';
import { TRACKING_RATE_LIMIT, trackingRateKey } from '../../src/tracking/tracking.constants';
import { FakeDns } from '../support/fake-dns';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { verifyAddress } from '../support/mail';
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

interface Activity {
    kind: string;
    properties: Record<string, unknown>;
}
interface Page<T> {
    items: T[];
}
interface Deal {
    id: string;
    stageId: string;
}
interface Pipeline {
    id: string;
    stages: { id: string; name: string }[];
}

const t = (text: string) => ({ type: 'text', text });
const link = (text: string, href: string) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });
const para = (...content: object[]) => ({ type: 'paragraph', content });
const doc = (...content: object[]) => ({ type: 'doc', content });

/** The HTML part of a sent message as a reader's client decodes it. */
const htmlPart = (raw: string): string =>
    Buffer.from(
        raw
            .split(/Content-Type: text\/html[^\r\n]*\r\n[^\r\n]*\r\n\r\n/)[1]!
            .split('\r\n--')[0]!
            .replace(/\r\n/g, ''),
        'base64',
    ).toString('utf8');
/** The text part, decoded the same way. */
const textPart = (raw: string): string =>
    Buffer.from(
        raw
            .split(/Content-Type: text\/plain[^\r\n]*\r\n[^\r\n]*\r\n\r\n/)[1]!
            .split('\r\n--')[0]!
            .replace(/\r\n/g, ''),
        'base64',
    ).toString('utf8');
const hrefs = (html: string): string[] =>
    [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
const pixelOf = (html: string): string | undefined =>
    html.match(/<img src="([^"]+)" width="1" height="1" alt="">/)?.[1];

const REPORT = 'https://acme.example/report?x=1&y=2';
const chrome =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

/**
 * Tracking (P3-4, FR-CRMS-8) end to end: a workspace's short-link domain, verified by its CNAME
 * through the DNS port; outreach links rewritten to short links only once it is verified — never the
 * unsubscribe link (P3-1), never personal 1:1 mail; the public redirect that records one `email.clicked`
 * per click through the outbox and shows it on the person's timeline; the open pixel, recorded as
 * `email.opened` and *indicative*: it never moves a stage; scanner hits kept out of every count; opaque,
 * workspace-bound tokens; and one workspace never seeing another's domain, tokens or hits.
 */
describe('FR-CRMS-8 tracking', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let env: Env;
    let send: MailSendService;
    let runner: SequenceRunner;
    let events: EventLog;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);
    const dns = new FakeDns();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const domain = `trk-${stamp}.example`;
    const shortDomain = `go-${stamp}.example`;
    const poolAddress = `pool-${stamp}@${domain}`;
    let admin: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let personalMailbox: string;
    let template: string;
    let pipeline: Pipeline;
    const noWait = { sleep: () => Promise.resolve() };

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const stage = (name: string) => pipeline.stages.find((s) => s.name === name)!;

    let n = 0;
    async function person(label: string, who = admin, ws = workspace): Promise<string> {
        n += 1;
        const res = await as(who)
            .post(w('/people', ws))
            .send({
                nameFirst: `P${n}`,
                nameLast: 'Test',
                source: 'test list',
                emails: { primary: `${label}-${stamp}@prospect.example`, additional: [] },
            });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return (res.body as { id: string }).id;
    }

    async function connect(purpose: 'pool' | 'personal', email: string): Promise<string> {
        const start = await as(admin).post(w('/mailboxes/connect')).send({ purpose });
        expect(start.status, JSON.stringify(start.body)).toBe(201);
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email,
            scopes: [...GMAIL_SCOPES],
        });
        await as(admin).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        const list = (await as(admin).get(w('/mailboxes'))).body as { id: string; email: string }[];
        return list.find((m) => m.email === email)!.id;
    }

    /** One active sequence with one email step of the template, the person enrolled and the step sent. */
    async function stepSent(personId: string): Promise<{ outboundId: string; html: string; seq: SequenceView }> {
        const created = await as(admin)
            .post(w('/sequences'))
            .send({
                name: `Seq ${stamp} ${(n += 1)}`,
                timeZone: 'UTC',
                window: { startMinute: 0, endMinute: 1440, days: 127 },
            });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = (created.body as SequenceView).id;
        const put = await as(admin)
            .put(w(`/sequences/${id}/steps`))
            .send({ steps: [{ kind: 'email', templateId: template }] });
        expect(put.status, JSON.stringify(put.body)).toBe(200);
        const active = await as(admin).post(w(`/sequences/${id}/activate`));
        expect(active.status, JSON.stringify(active.body)).toBe(200);
        const enrolled = await as(admin)
            .post(w(`/sequences/${id}/enrolments`))
            .send({ personIds: [personId] });
        expect((enrolled.body as EnrolmentBatchResult).enrolled, JSON.stringify(enrolled.body)).toEqual([personId]);
        const enrolment = await owner.sequenceEnrolment.findUniqueOrThrow({
            where: { sequenceId_personId: { sequenceId: id, personId } },
        });
        await runner.run(workspace, enrolment.id, new Date());
        const outboundId = (await owner.sequenceEnrolment.findUniqueOrThrow({ where: { id: enrolment.id } }))
            .waitingOutboundId!;
        expect(await send.deliver(workspace, outboundId, noWait, Date.now() + 1000)).toBe('sent');
        await settle(app);
        // A security gateway fetches links as the mail arrives; a person reads it later. Put the
        // delivery ten seconds in the past so the test's own clicks are a person's (the 2 s rule).
        await owner.mailOutbound.update({ where: { id: outboundId }, data: { sentAt: new Date(Date.now() - 10_000) } });
        return { outboundId, html: htmlPart(gmail.sent.at(-1)!.raw), seq: put.body as SequenceView };
    }
    const shortLinks = (html: string) => hrefs(html).filter((h) => h.startsWith(`https://${shortDomain}/r/`));
    const pathOf = (url: string) => new URL(url).pathname;
    const click = (url: string, userAgent = chrome) => http().get(pathOf(url)).set('User-Agent', userAgent);
    const timeline = async (personId: string, who = admin, ws = workspace) =>
        (await as(who).get(w(`/timeline?target=person:${personId}&kinds=linked-email`, ws))).body as Page<Activity>;
    const sends = async (personId: string) =>
        (await as(admin).get(w(`/mail/messages?target=person:${personId}&status=sent`))).body as Page<MailOutboundView>;

    beforeAll(async () => {
        dns.allowGoogle(domain);
        dns.setMx('prospect.example', 'mx.prospect.example');
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .overrideProvider(DNS_PORT)
            .useValue(dns)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        env = app.get<Env>(ENV);
        send = app.get(MailSendService);
        runner = app.get(SequenceRunner);
        events = await eventLog(app, 'email.clicked', 'email.opened', 'deal.*');

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(`trk-admin-${stamp}@example.com`, `Trk ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(
            `trk-other-${stamp}@example.com`,
            `Other trk ${stamp}`,
        ));

        const clientId = `555-t${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const secret = `GOCSPX-trk-${stamp}`;
        const oauth = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(oauth.body as { redirectUri: string }).redirectUri]);
        await as(admin).put(w('/mail/oauth-client')).send({ clientId, clientSecret: secret }).expect(200);
        await connect('pool', poolAddress);
        personalMailbox = await connect('personal', `trk-admin-${stamp}@example.com`);
        const domains = (await as(admin).get(w('/sending-domains'))).body as { id: string; domain: string }[];
        await as(admin)
            .post(w(`/sending-domains/${domains.find((d) => d.domain === domain)!.id}/check`))
            .expect(200);
        const pool = (await as(admin).get(w('/sending-pool'))).body as { settings: Record<string, number> };
        await as(admin)
            .put(w('/sending-pool/settings'))
            .send({
                ...pool.settings,
                warmupStartPerDay: 1,
                warmupDays: 1,
                jitterMinSeconds: 0,
                jitterMaxSeconds: 0,
                dailyCap: 100,
            })
            .expect(200);
        await as(admin)
            .put(w('/settings/mail'))
            .send({
                postalAddress: { line1: '1 Main St', city: 'Springfield', postalCode: '12345', country: 'US' },
                defaultSenderName: null,
                unsubscribeFooterText: 'You received this because we think it is relevant.',
            })
            .expect(200);
        const tpl = await as(admin)
            .post(w('/templates'))
            .send({
                name: 'Report',
                kind: 'outreach',
                subject: 'The report',
                body: doc(para(t('Read '), link('the report', REPORT), t(' or '), link('again', REPORT), t('.'))),
            });
        expect(tpl.status, JSON.stringify(tpl.body)).toBe(201);
        template = (tpl.body as { id: string }).id;
        pipeline = ((await as(admin).get(w('/pipelines'))).body as Pipeline[])[0]!;
    });

    afterAll(async () => {
        await app?.close();
    });

    /** Every test's requests come from one client; the brake is for the public, not for the suite. */
    const clearRate = () =>
        Promise.all(
            ['::ffff:127.0.0.1', '127.0.0.1', '::1'].map((ip) => app.get(RateLimiter).clear(trackingRateKey(ip))),
        );
    beforeEach(clearRate);

    describe('FR-CRMS-8 the short-link domain', () => {
        it('starts unset; links go out untracked until a domain is set and its CNAME verified', async () => {
            const target = new URL(env.APP_URL).hostname;
            expect((await as(admin).get(w('/tracking/domain'))).body).toEqual({ cnameTarget: target, domain: null });
            const dana = await person('untracked');
            const { html } = await stepSent(dana);
            expect(hrefs(html)).toContain(REPORT);
            expect(shortLinks(html)).toEqual([]);
            expect(pixelOf(html)).toBeUndefined();
        });

        it('is set by an admin, shows the CNAME to publish, and is checked on demand through the DNS port', async () => {
            const target = new URL(env.APP_URL).hostname;
            const set = await as(admin)
                .put(w('/tracking/domain'))
                .send({ domain: `GO-${stamp}.Example` });
            expect(set.status, JSON.stringify(set.body)).toBe(200);
            expect(set.body as TrackingSettingsView).toEqual({
                cnameTarget: target,
                domain: {
                    domain: shortDomain,
                    status: 'unchecked',
                    lastCheck: null,
                    checkedAt: null,
                    updatedAt: expect.any(String),
                },
            });
            // Not published yet: the check fails and says why; links stay untracked.
            const missing = ((await as(admin).post(w('/tracking/domain/check'))).body as TrackingSettingsView).domain!;
            expect(missing.status).toBe('fail');
            expect(missing.lastCheck?.message).toMatch(/CNAME/);
            expect(dns.cnameLookups).toContain(shortDomain);
            const dana = await person('unverified');
            expect(shortLinks((await stepSent(dana)).html)).toEqual([]);

            dns.setCname(shortDomain, target);
            const verified = ((await as(admin).post(w('/tracking/domain/check'))).body as TrackingSettingsView).domain!;
            expect(verified).toMatchObject({ status: 'pass', lastCheck: { outcome: 'pass' } });
            expect(verified.checkedAt).toEqual(expect.any(String));
        });

        it('refuses a domain that is not a hostname, a member without admin rights, and a domain another workspace holds', async () => {
            const bad = await as(admin).put(w('/tracking/domain')).send({ domain: 'not a host' });
            expect(bad.status).toBe(400);
            const taken = await as(otherAdmin).put(w('/tracking/domain', otherWorkspace)).send({ domain: shortDomain });
            expect(taken.status).toBe(409);
            expect(
                ((await as(otherAdmin).get(w('/tracking/domain', otherWorkspace))).body as TrackingSettingsView).domain,
            ).toBeNull();
            expect((await as(otherAdmin).get(w('/tracking/domain'))).status).toBe(403);
        });
    });

    describe('FR-CRMS-8 links in outreach mail', () => {
        it('rewrites each link to the short-link domain once verified; the unsubscribe link and the text part are untouched; a pixel is added', async () => {
            const dana = await person('short');
            const { html, outboundId } = await stepSent(dana);
            const short = shortLinks(html);
            // Two occurrences of one URL share one short link.
            expect(short).toHaveLength(2);
            expect(new Set(short).size).toBe(1);
            expect(short[0]).toMatch(new RegExp(`^https://${shortDomain}/r/[A-Za-z0-9_-]{43}$`));
            expect(html).not.toContain('acme.example/report');
            expect(hrefs(html).find((h) => h.includes('/unsubscribe/'))).toMatch(
                new RegExp(`^${env.WEB_URL}/unsubscribe/`),
            );
            expect(pixelOf(html)).toMatch(new RegExp(`^https://${shortDomain}/o/[A-Za-z0-9_-]{43}$`));
            // The text part keeps the real URL: a plain-text reader sees where they are going.
            expect(textPart(gmail.sent.at(-1)!.raw)).toContain(REPORT);
            expect(textPart(gmail.sent.at(-1)!.raw)).not.toContain(shortDomain);
            // The token is opaque: stored hashed, naming neither workspace nor person nor send.
            const token = short[0]!.split('/r/')[1]!;
            const rows = await owner.trackingToken.findMany({ where: { outboundId } });
            expect(rows.map((r) => r.kind).sort()).toEqual(['click', 'open']);
            for (const row of rows) expect(JSON.stringify(row)).not.toContain(token);
            for (const id of [workspace, dana, outboundId]) expect(token).not.toContain(id.replace(/-/g, ''));
        });

        it('never rewrites personal 1:1 mail', async () => {
            const dana = await person('personal');
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({
                    mailboxId: personalMailbox,
                    personId: dana,
                    subject: 'Personal',
                    body: doc(para(t('See '), link('this', REPORT), t('.'))),
                });
            expect(res.status, JSON.stringify(res.body)).toBe(202);
            const { messageId } = res.body as { messageId: string };
            await send.deliver(workspace, messageId, noWait);
            const html = htmlPart(gmail.sent.find((s) => s.raw.includes(messageId))!.raw);
            expect(hrefs(html)).toEqual([REPORT]);
            expect(pixelOf(html)).toBeUndefined();
            expect(await owner.trackingToken.count({ where: { outboundId: messageId } })).toBe(0);
        });
    });

    describe('FR-CRMS-8 clicks and opens', () => {
        it('redirects a click to the original URL and records exactly one email.clicked, on the person’s timeline as “clicked <link>”', async () => {
            const dana = await person('click');
            const { html, outboundId, seq } = await stepSent(dana);
            await events.reset();
            const res = await click(shortLinks(html)[0]!);
            expect(res.status).toBe(302);
            expect(res.headers['location']).toBe(REPORT);
            expect(res.headers['cache-control']).toMatch(/no-store/);
            await settle(app);
            const clicked = (await events.read()).filter((e) => e.type === 'email.clicked');
            expect(clicked).toHaveLength(1);
            expect(clicked[0]).toMatchObject({
                workspaceId: workspace,
                recordId: outboundId,
                related: [{ type: 'person', id: dana }],
                targets: [{ type: 'person', id: dana }],
                tracking: {
                    outboundId,
                    personId: dana,
                    url: REPORT,
                    sequenceStepId: seq.steps[0]!.id,
                    indicative: false,
                },
            });
            const page = await timeline(dana);
            expect(page.items.map((a) => a.kind)).toContain('linked-email.clicked');
            const entry = page.items.find((a) => a.kind === 'linked-email.clicked')!;
            expect(entry.properties).toMatchObject({
                linked: { type: 'email', id: outboundId },
                tracking: { url: REPORT },
            });
            // A second click is a second click (clicks 2, unique 1) — never a replayed first one.
            await click(shortLinks(html)[0]!).expect(302);
            await settle(app);
            expect((await events.read()).filter((e) => e.type === 'email.clicked')).toHaveLength(2);
            const sent = (await sends(dana)).items.find((s) => s.id === outboundId)!;
            expect(sent.tracking).toEqual({ clicks: 2, uniqueClicks: 1, opens: 0 });
        });

        it('records an open from the pixel as indicative, never cached, and counts it', async () => {
            const dana = await person('open');
            const { html, outboundId } = await stepSent(dana);
            await events.reset();
            const res = await http()
                .get(pathOf(pixelOf(html)!))
                .set('User-Agent', chrome);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/^image\/gif/);
            expect(res.headers['cache-control']).toMatch(/no-store/);
            await settle(app);
            const opened = (await events.read()).filter((e) => e.type === 'email.opened');
            expect(opened).toHaveLength(1);
            expect(opened[0]).toMatchObject({ recordId: outboundId, tracking: { url: null, indicative: true } });
            const page = await timeline(dana);
            expect(page.items.find((a) => a.kind === 'linked-email.opened')?.properties).toMatchObject({
                tracking: { indicative: true },
            });
            const sent = (await sends(dana)).items.find((s) => s.id === outboundId)!;
            expect(sent.tracking).toEqual({ clicks: 0, uniqueClicks: 0, opens: 1 });
        });

        it('answers 404 to an unknown or tampered token, naming nothing, and records nothing anywhere', async () => {
            const dana = await person('tamper');
            const { html } = await stepSent(dana);
            await events.reset();
            const real = shortLinks(html)[0]!;
            const token = real.split('/r/')[1]!;
            const flipped = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
            for (const path of [`/r/${flipped}`, '/r/not-a-token', `/o/${flipped}`, `/r/${token}/../x`]) {
                const res = await http().get(path).set('User-Agent', chrome);
                expect(res.status, path).toBe(404);
                expect(res.headers['location']).toBeUndefined();
                for (const id of [workspace, dana]) expect(res.text).not.toContain(id);
            }
            await settle(app);
            expect(await events.read()).toEqual([]);
            // The real token still works for its own workspace alone: the other workspace sees no hit.
            await click(real).expect(302);
            await settle(app);
            expect(await owner.trackingHit.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
            expect((await as(otherAdmin).get(w(`/timeline?target=person:${dana}`, otherWorkspace))).status).toBe(404);
        });

        it('keeps a scanner’s hit — by its user agent, or any hit within 2 s of delivery — out of every count and event', async () => {
            const dana = await person('bot');
            const { html, outboundId } = await stepSent(dana);
            await events.reset();
            const short = shortLinks(html)[0]!;
            // Known scanners and fetch libraries are still redirected (a scanner that gets a 404 flags the mail).
            expect((await click(short, 'curl/8.4.0')).status).toBe(302);
            expect((await click(short, 'Mozilla/5.0 (compatible; Barracuda Sentinel)')).status).toBe(302);
            expect(
                (
                    await http()
                        .get(pathOf(pixelOf(html)!))
                        .set('User-Agent', 'python-requests/2.31')
                ).status,
            ).toBe(200);
            // A browser, but the mail was delivered a moment ago: a gateway following every link.
            await owner.mailOutbound.update({ where: { id: outboundId }, data: { sentAt: new Date() } });
            expect((await click(short)).status).toBe(302);
            await settle(app);
            expect(await events.read()).toEqual([]);
            const hits = await owner.trackingHit.findMany({ where: { outboundId }, orderBy: { createdAt: 'asc' } });
            expect(hits.map((h) => h.botReason)).toEqual([
                'scanner_user_agent',
                'scanner_user_agent',
                'scanner_user_agent',
                'too_soon_after_delivery',
            ]);
            const sent = (await sends(dana)).items.find((s) => s.id === outboundId)!;
            expect(sent.tracking).toEqual({ clicks: 0, uniqueClicks: 0, opens: 0 });
            expect((await timeline(dana)).items.filter((a) => /clicked|opened/.test(a.kind))).toEqual([]);
        });

        it('rate-limits the public routes per client', async () => {
            const limiter = app.get(RateLimiter);
            const key = trackingRateKey('::ffff:127.0.0.1');
            await limiter.clear(key);
            try {
                let limited: Response | undefined;
                for (let i = 0; i <= TRACKING_RATE_LIMIT; i++) {
                    const res = await http().get('/r/not-a-token');
                    if (res.status === 429) {
                        limited = res;
                        break;
                    }
                }
                expect(limited?.status).toBe(429);
            } finally {
                await limiter.clear(key);
            }
        });
    });

    describe('FR-CRMS-8 what tracking may drive', () => {
        let dealCompanyId: string | undefined;
        const dealCompany = async (): Promise<string> =>
            (dealCompanyId ??= (
                (
                    await as(admin)
                        .post(w('/companies'))
                        .send({ name: `Trk Co ${stamp}` })
                ).body as { id: string }
            ).id);

        it('a click may move a deal by a stage rule, like a reply', async () => {
            const made = await as(admin)
                .post(w(`/pipelines/${pipeline.id}/rules`))
                .send({ event: 'email.clicked', toStageId: stage('Replied').id });
            expect(made.status, JSON.stringify(made.body)).toBe(201);
            const dana = await person('rule');
            const companyId = await dealCompany();
            const deal = (
                await as(admin)
                    .post(w('/opportunities'))
                    .send({ name: `Clicked ${stamp}`, companyId, pointOfContactId: dana })
            ).body as Deal;
            expect(deal.stageId).toBe(stage('New').id);
            const { html } = await stepSent(dana);
            await click(shortLinks(html)[0]!).expect(302);
            await settle(app);
            const after = (await as(admin).get(w(`/opportunities/${deal.id}`))).body as Deal;
            expect(after.stageId).toBe(stage('Replied').id);
        });

        it('an open never moves a stage: a rule on email.opened is refused, and an opened event moves nothing', async () => {
            const refused = await as(admin)
                .post(w(`/pipelines/${pipeline.id}/rules`))
                .send({ event: 'email.opened', toStageId: stage('Replied').id });
            expect(refused.status).toBe(400);
            const dana = await person('opened-rule');
            const companyId = await dealCompany();
            const deal = (
                await as(admin)
                    .post(w('/opportunities'))
                    .send({ name: `Opened ${stamp}`, companyId, pointOfContactId: dana })
            ).body as Deal;
            const { html } = await stepSent(dana);
            await http()
                .get(pathOf(pixelOf(html)!))
                .set('User-Agent', chrome)
                .expect(200);
            await settle(app);
            const opened: DomainEvent = {
                type: 'email.opened',
                object: 'email',
                workspaceId: workspace,
                actor: { kind: 'system', id: null },
                occurredAt: new Date().toISOString(),
                recordId: `send-${stamp}`,
                related: [{ type: 'person', id: dana }],
            };
            expect(app.get(StageRulesService).accepts(opened)).toBe(false);
            expect(await app.get(StageRulesService).apply(opened)).toBe(0);
            await app.get(RlsPrismaService).withWorkspace(workspace, (tx) => app.get(DomainEvents).record(tx, opened));
            await settle(app);
            const after = (await as(admin).get(w(`/opportunities/${deal.id}`))).body as Deal;
            expect(after.stageId).toBe(stage('New').id);
        });

        it('counts clicks, unique clicks and indicative opens on the sequence step through its own listing', async () => {
            const dana = await person('counts');
            const { html, seq } = await stepSent(dana);
            const short = shortLinks(html)[0]!;
            await click(short).expect(302);
            await click(short).expect(302);
            await http()
                .get(pathOf(pixelOf(html)!))
                .set('User-Agent', chrome)
                .expect(200);
            await settle(app);
            const view = (await as(admin).get(w(`/sequences/${seq.id}`))).body as SequenceView;
            expect(view.steps[0]!.tracking).toEqual({ clicks: 2, uniqueClicks: 1, opens: 1 });
            // Another workspace reads nothing of it.
            expect((await as(otherAdmin).get(w(`/sequences/${seq.id}`, otherWorkspace))).status).toBe(404);
        });
    });

    describe('FR-CRMS-8 tenant isolation', () => {
        it('one workspace’s domain, tokens and hits are invisible to another, even through the owner connection’s RLS', async () => {
            const rls = app.get(RlsPrismaService);
            expect(await rls.withWorkspace(otherWorkspace, (tx) => tx.trackingDomain.count())).toBe(0);
            expect(await rls.withWorkspace(otherWorkspace, (tx) => tx.trackingToken.count())).toBe(0);
            expect(await rls.withWorkspace(otherWorkspace, (tx) => tx.trackingHit.count())).toBe(0);
            expect(await rls.withWorkspace(workspace, (tx) => tx.trackingDomain.count())).toBe(1);
            expect(await rls.withWorkspace(workspace, (tx) => tx.trackingToken.count())).toBeGreaterThan(0);
            expect(await rls.withWorkspace(workspace, (tx) => tx.trackingHit.count())).toBeGreaterThan(0);
            // Nobody deletes a hit: the record of what happened stays.
            await expect(rls.withWorkspace(workspace, (tx) => tx.trackingHit.deleteMany({}))).rejects.toThrow(
                /permission denied/,
            );
        });

        it('removing the domain stops rewriting; tokens already sent still redirect', async () => {
            const dana = await person('removed');
            const { html } = await stepSent(dana);
            const short = shortLinks(html)[0]!;
            await as(admin).delete(w('/tracking/domain')).expect(204);
            expect(((await as(admin).get(w('/tracking/domain'))).body as TrackingSettingsView).domain).toBeNull();
            const later = await person('after-removal');
            expect(shortLinks((await stepSent(later)).html)).toEqual([]);
            expect((await click(short)).status).toBe(302);
        });
    });
});
