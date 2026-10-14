import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_SCOPES,
    SESSION_COOKIE,
    type PoolMailboxHealth,
    type SendingDomainView,
    type SendingPoolView,
    POSTMASTER_SCOPES,
    SENDING_DOMAIN_RECHECK_MS,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MailSendService } from '../../src/mail-send/mail-send.service';
import { buildMime, newMessageId } from '../../src/mail-send/mime';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { MailSyncService } from '../../src/mail-sync/mail-sync.service';
import { DNS_PORT } from '../../src/sending-pool/dns.port';
import { POSTMASTER_PORT } from '../../src/sending-pool/postmaster.port';
import { postmasterDay } from '../../src/sending-pool/postmaster.http';
import { SendingPoolService } from '../../src/sending-pool/sending-pool.service';
import { SuppressionService } from '../../src/suppression/suppression.service';
import { FakeDns } from '../support/fake-dns';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { FakePostmaster } from '../support/fake-postmaster';
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

interface BusEvent {
    type: string;
    workspaceId: string;
    recordId: string;
    bounce?: {
        mailboxId: string;
        address: string;
        permanent: boolean;
        status: string | null;
        outboundId: string | null;
    };
    pause?: { code: string; rateBps: number; thresholdBps: number };
}

/**
 * The sending pool (P3-2, FR-CRMS-6, FR-CRMS-13) end to end: the one gate every pool send passes —
 * paused, sending domain verified by DNS, the rolling-24-hour allowance (cap and warm-up day) —
 * enforced at the claim that moves a send to `sending`, so a retry of a counted send is never refused
 * and two workers never take the last slot; rotation across the pool; bounce reports suppressing the
 * address and pausing a mailbox past its rate; and one workspace never seeing or changing another's.
 */
describe('FR-CRMS-6 / FR-CRMS-13 sending pool', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let send: MailSendService;
    let sync: MailSyncService;
    let pool: SendingPoolService;
    let suppressions: SuppressionService;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);
    const dns = new FakeDns();
    const postmaster = new FakePostmaster();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const goodDomain = `out-${stamp}.example`;
    const badDomain = `bad-${stamp}.example`;
    const adminEmail = `pool-admin-${stamp}@example.com`;
    const otherEmail = `pool-other-${stamp}@example.com`;
    let admin: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    /** Pool mailboxes on the good domain, by address. */
    const mailbox: Record<string, string> = {};
    const poolAddresses = ['a', 'b', 'c'].map((n) => `pool-${n}-${stamp}@${goodDomain}`);
    const badAddress = `pool-x-${stamp}@${badDomain}`;
    let log: EventLog;
    const recorded = async () => (await log.read()) as unknown as BusEvent[];

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const noWait = { sleep: () => Promise.resolve() };

    async function view(who = admin, ws = workspace): Promise<SendingPoolView> {
        const res = await as(who).get(w('/sending-pool', ws));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as SendingPoolView;
    }
    const health = async (id: string): Promise<PoolMailboxHealth> =>
        (await view()).mailboxes.find((m) => m.mailboxId === id)!;
    const domainOf = async (name: string): Promise<SendingDomainView> =>
        (await view()).domains.find((d) => d.domain === name)!;

    async function settings(patch: Record<string, number>): Promise<void> {
        const current = (await view()).settings;
        const res = await as(admin)
            .put(w('/sending-pool/settings'))
            .send({ ...current, ...patch });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    /**
     * A send from a pool mailbox, queued as a sequence (P3-3) will queue one: built and stored, waiting
     * for its job. The job is `deliver`, called directly so each test decides when it runs.
     */
    async function queuePoolSend(mailboxId: string, to: string): Promise<string> {
        const id = randomUUID();
        const rfc822MessageId = newMessageId();
        const box = await owner.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
        await owner.mailOutbound.create({
            data: {
                id,
                workspaceId: box.workspaceId,
                mailboxId,
                senderMemberId: box.ownerMemberId,
                status: 'queued',
                rfc822MessageId,
                toAddresses: [to],
                subject: 'Quick question',
                mime: buildMime({
                    from: { address: box.email, name: 'Pool' },
                    to: [{ address: to, name: null }],
                    cc: [],
                    bcc: [],
                    subject: 'Quick question',
                    text: 'Hello',
                    html: '<p>Hello</p>',
                    messageId: rfc822MessageId,
                    crmId: id,
                    inReplyTo: null,
                    references: [],
                    date: new Date(),
                }),
            },
        });
        return id;
    }
    const outcome = async (id: string) =>
        owner.mailOutbound.findUniqueOrThrow({ where: { id }, select: { status: true, lastError: true } });
    /** Sends that already went from a mailbox, `hoursAgo` ago — history for the allowance and the rates. */
    async function history(mailboxId: string, count: number, hoursAgo = 1): Promise<string[]> {
        const ids: string[] = [];
        for (let i = 0; i < count; i += 1) {
            const id = await queuePoolSend(mailboxId, `hist-${i}-${randomUUID().slice(0, 8)}@acme.example`);
            const at = new Date(Date.now() - hoursAgo * 3600_000);
            await owner.mailOutbound.update({
                where: { id },
                data: {
                    status: 'sent',
                    sentAt: at,
                    lastAttemptAt: at,
                    attempts: 1,
                    providerMessageId: `hist-${id}`,
                    providerThreadId: `hist-thr-${id}`,
                },
            });
            ids.push(id);
        }
        return ids;
    }
    async function connect(email: string, purpose: 'pool' | 'personal' = 'pool'): Promise<string> {
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
    async function checkDomain(name: string): Promise<SendingDomainView> {
        const domain = await domainOf(name);
        const res = await as(admin).post(w(`/sending-domains/${domain.id}/check`));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as SendingDomainView;
    }
    /** Clears every pool mailbox's sends and pause, so each test starts from an empty 24 hours. */
    async function reset(): Promise<void> {
        const ids = Object.values(mailbox);
        await owner.mailBounce.deleteMany({ where: { mailboxId: { in: ids } } });
        await owner.suppression.deleteMany({ where: { workspaceId: workspace } });
        await owner.mailOutbound.deleteMany({ where: { mailboxId: { in: ids } } });
        await owner.mailbox.updateMany({
            where: { id: { in: ids } },
            data: { pausedAt: null, pauseReason: Prisma.DbNull, poolDailyCap: null },
        });
    }

    beforeAll(async () => {
        dns.allowGoogle(goodDomain);
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .overrideProvider(DNS_PORT)
            .useValue(dns)
            .overrideProvider(POSTMASTER_PORT)
            .useValue(postmaster)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        send = app.get(MailSendService);
        sync = app.get(MailSyncService);
        pool = app.get(SendingPoolService);
        suppressions = app.get(SuppressionService);
        log = await eventLog(app, 'email.bounced', 'mailbox.paused', 'mailbox.resumed');

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Pool ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other pool ${stamp}`));

        const clientId = `555-p${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const secret = `GOCSPX-pool-${stamp}`;
        const oauth = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(oauth.body as { redirectUri: string }).redirectUri]);
        await as(admin).put(w('/mail/oauth-client')).send({ clientId, clientSecret: secret }).expect(200);
        for (const address of poolAddresses) mailbox[address] = await connect(address);
        mailbox[badAddress] = await connect(badAddress);
        await checkDomain(goodDomain);
        await checkDomain(badDomain);
    });

    afterAll(async () => {
        await app?.close();
    });

    beforeEach(async () => {
        await reset();
        // Out of warm-up, cap 10, a judged rate needs 3 sends — each test narrows what it needs.
        await settings({
            dailyCap: 10,
            warmupStartPerDay: 1,
            warmupDays: 1,
            rateMinSample: 3,
            bouncePauseBps: 2000,
            complaintPauseBps: 20,
        });
    });

    describe('FR-CRMS-6 the allowance', () => {
        it('enforces the daily cap at the claim, and never refuses a retry of a send already counted', async () => {
            await settings({ dailyCap: 2 });
            const a = mailbox[poolAddresses[0]!]!;
            const first = await queuePoolSend(a, `r1-${stamp}@acme.example`);
            // Gmail fails the first attempt transiently: the send stays `sending` and counts.
            gmail.failNext(poolAddresses[0]!, 'send', 503, 99);
            await expect(send.deliver(workspace, first, noWait)).rejects.toThrow();
            gmail.clearFailures();
            expect((await outcome(first)).status).toBe('sending');

            const second = await queuePoolSend(a, `r2-${stamp}@acme.example`);
            expect(await send.deliver(workspace, second, noWait)).toBe('sent');
            // The cap (2) is used: the queue's retry of the first still goes — it was counted once.
            expect(await send.deliver(workspace, first, noWait)).toMatch(/sent/);
            const third = await queuePoolSend(a, `r3-${stamp}@acme.example`);
            expect(await send.deliver(workspace, third, noWait)).toBe('failed');
            expect(await outcome(third)).toMatchObject({
                status: 'failed',
                lastError: { code: 'mailbox.cap_reached', message: expect.stringContaining('2') },
            });
            expect((await health(a)).used).toBe(2);
        });

        it('lets only one of two sends racing for the last slot through', async () => {
            await settings({ dailyCap: 1 });
            const a = mailbox[poolAddresses[0]!]!;
            const [x, y] = [
                await queuePoolSend(a, `race1-${stamp}@acme.example`),
                await queuePoolSend(a, `race2-${stamp}@acme.example`),
            ];
            const results = await Promise.all([
                send.deliver(workspace, x!, noWait),
                send.deliver(workspace, y!, noWait),
            ]);
            expect(results.filter((r) => r === 'sent')).toHaveLength(1);
            expect(results.filter((r) => r === 'failed')).toHaveLength(1);
        });

        it('limits a mailbox on warm-up day N to that day’s ramp, and reports it', async () => {
            await settings({ dailyCap: 40, warmupStartPerDay: 5, warmupDays: 21 });
            const a = mailbox[poolAddresses[0]!]!;
            await owner.mailbox.update({
                where: { id: a },
                data: { warmupStartedAt: new Date(Date.now() - 10 * 24 * 3600_000 - 60_000) },
            });
            expect(await health(a)).toMatchObject({ warmupDay: 11, warmupLimit: 22, allowance: 22, used: 0 });
            await history(a, 22);
            const next = await queuePoolSend(a, `warm-${stamp}@acme.example`);
            expect(await send.deliver(workspace, next, noWait)).toBe('failed');
            expect((await outcome(next)).lastError).toMatchObject({
                code: 'mailbox.cap_reached',
                message: expect.stringContaining('warm-up day 11'),
            });
            // Sends older than 24 hours no longer count: the window rolls.
            await owner.mailOutbound.updateMany({
                where: { mailboxId: a, status: 'sent' },
                data: {
                    sentAt: new Date(Date.now() - 25 * 3600_000),
                    lastAttemptAt: new Date(Date.now() - 25 * 3600_000),
                },
            });
            expect((await health(a)).used).toBe(0);
            await owner.mailbox.update({ where: { id: a }, data: { warmupStartedAt: new Date() } });
        });

        it('applies a mailbox’s own cap over the workspace’s', async () => {
            const a = mailbox[poolAddresses[0]!]!;
            const res = await as(admin)
                .put(w(`/mailboxes/${a}/pool`))
                .send({ dailyCap: 1 });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(await health(a)).toMatchObject({ dailyCapOverride: 1, dailyCap: 1, allowance: 1 });
            await history(a, 1);
            const next = await queuePoolSend(a, `own-${stamp}@acme.example`);
            expect(await send.deliver(workspace, next, noWait)).toBe('failed');
        });
    });

    describe('FR-CRMS-6 rotation and jitter', () => {
        it('spreads sends evenly across the pool by share of allowance used', async () => {
            const counts = new Map<string, number>();
            for (let i = 0; i < 24; i += 1) {
                const picked = await pool.pick(workspace);
                expect(picked).not.toBeNull();
                const id = await queuePoolSend(picked!, `rot-${i}-${stamp}@acme.example`);
                expect(await send.deliver(workspace, id, noWait)).toBe('sent');
                counts.set(picked!, (counts.get(picked!) ?? 0) + 1);
            }
            // The mailbox on the failing domain is never picked; the three good ones share evenly.
            expect(counts.has(mailbox[badAddress]!)).toBe(false);
            expect([...counts.values()].sort()).toEqual([8, 8, 8]);
        });

        it('picks nothing when every mailbox has used its allowance', async () => {
            await settings({ dailyCap: 1 });
            for (const address of poolAddresses) await history(mailbox[address]!, 1);
            expect(await pool.pick(workspace)).toBeNull();
        });

        it('spaces two sends from one mailbox by the jitter window', async () => {
            await settings({ jitterMinSeconds: 60, jitterMaxSeconds: 120 });
            const a = mailbox[poolAddresses[0]!]!;
            const [last] = await history(a, 1, 0);
            const lastAt = (await owner.mailOutbound.findUniqueOrThrow({ where: { id: last! } })).sentAt!.getTime();
            for (let i = 0; i < 10; i += 1) {
                const at = (await pool.nextSendAt(workspace, a, new Date())).getTime();
                expect(at - lastAt).toBeGreaterThanOrEqual(60_000);
                expect(at - lastAt).toBeLessThanOrEqual(120_000);
            }
            const later = new Date(Date.now() + 3600_000);
            expect((await pool.nextSendAt(workspace, a, later)).getTime()).toBeGreaterThanOrEqual(later.getTime());
        });
    });

    describe('FR-CRMS-13 sending domains', () => {
        it('refuses every send from a domain that failed its DNS check, naming what failed', async () => {
            const domain = await domainOf(badDomain);
            expect(domain.status).toBe('fail');
            expect(domain.lastCheck).toMatchObject({
                spf: { outcome: 'fail' },
                dkim: { outcome: 'fail', message: expect.stringContaining(`google._domainkey.${badDomain}`) },
                dmarc: { outcome: 'fail' },
            });
            const id = await queuePoolSend(mailbox[badAddress]!, `dns-${stamp}@acme.example`);
            expect(await send.deliver(workspace, id, noWait)).toBe('failed');
            expect((await outcome(id)).lastError).toMatchObject({ code: 'mailbox.domain_unverified' });
            expect((await health(mailbox[badAddress]!)).canSend).toBe(false);
        });

        it('lets the domain send once its records are fixed and it is checked again', async () => {
            dns.allowGoogle(badDomain, 'mail');
            const domain = await domainOf(badDomain);
            await as(admin)
                .put(w(`/sending-domains/${domain.id}`))
                .send({ dkimSelector: 'mail' })
                .expect(200);
            expect((await checkDomain(badDomain)).status).toBe('pass');
            const id = await queuePoolSend(mailbox[badAddress]!, `dns-ok-${stamp}@acme.example`);
            expect(await send.deliver(workspace, id, noWait)).toBe('sent');
            // Broken again for the other tests.
            dns.set(badDomain);
            dns.set(`_dmarc.${badDomain}`);
            dns.set(`mail._domainkey.${badDomain}`);
            expect((await checkDomain(badDomain)).status).toBe('fail');
        });

        it('does not gate a personal mailbox', async () => {
            const personal = `personal-${stamp}@${badDomain}`;
            const id = await connect(personal, 'personal');
            const queued = await queuePoolSend(id, `pers-${stamp}@acme.example`);
            expect(await send.deliver(workspace, queued, noWait)).toBe('sent');
        });
    });

    describe('FR-CRMS-6 / FR-CRMS-13 bounces, complaints and auto-pause', () => {
        it('suppresses a permanently bounced address and pauses the mailbox past its bounce rate', async () => {
            const address = poolAddresses[1]!;
            const b = mailbox[address]!;
            const [bounced] = await history(b, 3);
            const to = (await owner.mailOutbound.findUniqueOrThrow({ where: { id: bounced! } })).toAddresses[0]!;
            gmail.deliverBounce(address, { recipient: to, status: '5.1.1', crmId: bounced! });
            await sync.syncMailbox(workspace, b, noWait);
            await settle(app);

            const entry = (await suppressions.check(workspace, [to])).get(to);
            expect(entry?.reason).toBe('hard_bounce');
            const row = await owner.suppression.findFirstOrThrow({ where: { workspaceId: workspace, address: to } });
            expect(row).toMatchObject({ source: 'provider', outboundId: bounced });
            const events = await recorded();
            expect(events.filter((e) => e.type === 'email.bounced' && e.bounce?.address === to)).toEqual([
                expect.objectContaining({
                    bounce: { mailboxId: b, address: to, permanent: true, status: '5.1.1', outboundId: bounced },
                }),
            ]);
            // 1 bounce in 3 sends = 33% ≥ 20%: paused, with the reason shown.
            const paused = await health(b);
            expect(paused.paused).toMatchObject({ code: 'bounce_rate', rateBps: 3333, thresholdBps: 2000, sends: 3 });
            expect(paused.canSend).toBe(false);
            expect(events.filter((e) => e.type === 'mailbox.paused' && e.recordId === b)).toHaveLength(1);

            const next = await queuePoolSend(b, `after-${stamp}@acme.example`);
            expect(await send.deliver(workspace, next, noWait)).toBe('failed');
            expect((await outcome(next)).lastError).toMatchObject({ code: 'mailbox.paused' });
            for (let i = 0; i < 6; i += 1) expect(await pool.pick(workspace)).not.toBe(b);

            // A redelivered report changes nothing: one bounce row, one suppression, one pause.
            await settle(app);
            expect(await owner.mailBounce.count({ where: { mailboxId: b } })).toBe(1);
        });

        it('records a transient bounce without suppressing or counting it', async () => {
            const address = poolAddresses[2]!;
            const c = mailbox[address]!;
            const [sent] = await history(c, 3);
            const to = (await owner.mailOutbound.findUniqueOrThrow({ where: { id: sent! } })).toAddresses[0]!;
            gmail.deliverBounce(address, { recipient: to, status: '4.2.2', crmId: sent! });
            await sync.syncMailbox(workspace, c, noWait);
            await settle(app);
            expect((await suppressions.check(workspace, [to])).size).toBe(0);
            expect(await owner.mailBounce.count({ where: { mailboxId: c, permanent: false } })).toBe(1);
            expect((await health(c)).paused).toBeNull();
        });

        it('pauses a mailbox on its complaint rate before Google’s 0.3%, and an admin resumes it with a note', async () => {
            const a = mailbox[poolAddresses[0]!]!;
            const sent = await history(a, 3);
            const to = (await owner.mailOutbound.findUniqueOrThrow({ where: { id: sent[0]! } })).toAddresses[0]!;
            await suppressions.suppress(workspace, {
                address: to,
                reason: 'complaint',
                source: 'member',
                outboundId: sent[0]!,
            });
            await settle(app);
            expect((await health(a)).paused).toMatchObject({ code: 'complaint_rate', thresholdBps: 20 });

            const noNote = await as(admin)
                .post(w(`/mailboxes/${a}/resume`))
                .send({});
            expect(noNote.status).toBe(400);
            const resumed = await as(admin)
                .post(w(`/mailboxes/${a}/resume`))
                .send({ note: 'list cleaned' });
            expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
            expect((await health(a)).paused).toBeNull();
            expect((await recorded()).filter((e) => e.type === 'mailbox.resumed' && e.recordId === a)).toHaveLength(1);
        });
    });

    describe('workspace isolation', () => {
        it('never shows, resumes or checks another workspace’s pool', async () => {
            const theirs = await view(otherAdmin, otherWorkspace);
            expect(theirs.mailboxes).toHaveLength(0);
            expect(theirs.domains).toHaveLength(0);
            const a = mailbox[poolAddresses[0]!]!;
            expect(
                (
                    await as(otherAdmin)
                        .post(w(`/mailboxes/${a}/resume`, otherWorkspace))
                        .send({ note: 'x' })
                ).status,
            ).toBe(404);
            expect(
                (
                    await as(otherAdmin)
                        .put(w(`/mailboxes/${a}/pool`, otherWorkspace))
                        .send({ dailyCap: 5 })
                ).status,
            ).toBe(404);
            const domain = await domainOf(goodDomain);
            expect((await as(otherAdmin).post(w(`/sending-domains/${domain.id}/check`, otherWorkspace))).status).toBe(
                404,
            );
            expect(await pool.pick(otherWorkspace)).toBeNull();
        });
    });

    describe('#129 FR-CRMS-13 Postmaster Tools spam rate per sending domain', () => {
        const yesterday = postmasterDay(new Date());
        const connectPostmaster = async (
            who = admin,
            ws = workspace,
            scopes: readonly string[] = POSTMASTER_SCOPES,
        ) => {
            const start = await as(who).post(w('/sending-pool/postmaster/connect', ws));
            expect(start.status, JSON.stringify(start.body)).toBe(201);
            const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
                email: who === admin ? adminEmail : otherEmail,
                scopes: [...scopes],
            });
            const callback = await as(who).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
            return new URL(String(callback.headers['location'])).searchParams.get('connect');
        };
        /** Makes the domain's Postmaster read due again (#183 reads a day once; a test asks sooner). */
        const due = (name: string) =>
            owner.sendingDomain.updateMany({
                where: { workspaceId: workspace, domain: name },
                data: { postmasterNextReadAt: null, postmasterLimitedTimes: 0 },
            });
        /** The next try is about `ms` from now (within the test's own running time). */
        const expectAbout = (iso: string | null, ms: number) => {
            const wait = new Date(iso ?? 0).getTime() - Date.now();
            expect(wait, `next try in ${wait} ms, expected about ${ms}`).toBeGreaterThan(ms - 30_000);
            expect(wait).toBeLessThanOrEqual(ms);
        };
        const nextUtcMidnight = () => {
            const d = new Date();
            return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
        };

        it('connects Postmaster Tools through the workspace’s OAuth client with its own scope — never Gmail’s — and shows the account on the pool', async () => {
            expect((await view()).postmaster).toBeNull();
            // The consent asks for Postmaster’s read scope and the account’s address, nothing of Gmail.
            const start = await as(admin).post(w('/sending-pool/postmaster/connect'));
            const scope =
                new URL((start.body as { authorizeUrl: string }).authorizeUrl).searchParams.get('scope') ?? '';
            expect(scope.split(' ').sort()).toEqual([...POSTMASTER_SCOPES].sort());
            expect(scope).not.toContain('gmail');
            // A grant without the Postmaster scope is refused.
            expect(await connectPostmaster(admin, workspace, [GMAIL_SCOPES[1]])).toBe('scope_missing');
            expect(await connectPostmaster()).toBe('connected');
            expect((await view()).postmaster).toMatchObject({ email: adminEmail, status: 'connected' });
            expect(await owner.postmasterConnection.count({ where: { workspaceId: workspace } })).toBe(1);
            // The refresh token is sealed, never stored as given.
            const row = await owner.postmasterConnection.findUniqueOrThrow({ where: { workspaceId: workspace } });
            expect(row.refreshTokenCiphertext).not.toContain('refresh');
        });

        it('reads the domain’s user-reported spam rate with the check, shows it, and pauses every pool mailbox on a domain at or past the complaint threshold', async () => {
            await log.reset();
            postmaster.setSpamRate(goodDomain, 35);
            const checked = await checkDomain(goodDomain);
            expect(checked.status).toBe('pass');
            expect(checked.postmaster).toEqual({ status: 'ok', message: null, nextReadAt: nextUtcMidnight() });
            expect(checked.spamRate).toEqual({ day: yesterday, rateBps: 35 });
            expect(postmaster.lookups.at(-1)).toMatchObject({ domain: goodDomain, day: yesterday });
            expect(
                await owner.sendingDomainStat.count({ where: { workspaceId: workspace, domainId: checked.id } }),
            ).toBe(1);

            const after = await view();
            for (const address of poolAddresses) {
                const m = after.mailboxes.find((x) => x.mailboxId === mailbox[address]!)!;
                expect(m.paused, address).toMatchObject({ code: 'domain_spam_rate', rateBps: 35, thresholdBps: 20 });
                expect(m.paused!.message).toContain(goodDomain);
                expect(m.canSend).toBe(false);
            }
            const paused = (await recorded()).filter((e) => e.type === 'mailbox.paused');
            expect(paused).toHaveLength(poolAddresses.length);
            // Checked again with the same rate: nothing is paused twice, nothing announced twice.
            await checkDomain(goodDomain);
            expect((await recorded()).filter((e) => e.type === 'mailbox.paused')).toHaveLength(poolAddresses.length);

            // An admin resumes them; a rate under the threshold pauses nothing.
            for (const address of poolAddresses) {
                await as(admin)
                    .post(w(`/mailboxes/${mailbox[address]!}/resume`))
                    .send({ note: 'Postmaster rate reviewed' })
                    .expect(200);
            }
            postmaster.setSpamRate(goodDomain, 5);
            await due(goodDomain);
            expect((await checkDomain(goodDomain)).spamRate).toEqual({ day: yesterday, rateBps: 5 });
            expect((await view()).mailboxes.every((m) => m.paused === null)).toBe(true);
            // The day's row was replaced, not added to.
            expect(
                await owner.sendingDomainStat.count({ where: { workspaceId: workspace, domainId: checked.id } }),
            ).toBe(1);
        });

        it('says when a domain is not verified in Postmaster Tools, when the lookup failed, and when nothing is connected; another workspace sees none of it', async () => {
            await due(badDomain);
            postmaster.notVerified(badDomain);
            const unverified = await checkDomain(badDomain);
            expect(unverified.postmaster).toMatchObject({ status: 'not_verified' });
            expect(unverified.spamRate).toBeNull();

            await due(goodDomain);
            postmaster.failNext();
            const failed = await checkDomain(goodDomain);
            // A 5xx is transient (#183): no warning, tried again at the check's cadence.
            expect(failed.postmaster).toMatchObject({ status: 'unreachable', message: expect.stringContaining('503') });
            // The last known rate stays what it was: a failed lookup is not a zero.
            expect(failed.spamRate).toEqual({ day: yesterday, rateBps: 5 });

            expect((await view(otherAdmin, otherWorkspace)).postmaster).toBeNull();
            expect(await owner.sendingDomainStat.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
            expect((await as(otherAdmin).delete(w('/sending-pool/postmaster', otherWorkspace))).status).toBe(404);

            await as(admin).delete(w('/sending-pool/postmaster')).expect(204);
            expect((await view()).postmaster).toBeNull();
            await due(goodDomain);
            expect((await checkDomain(goodDomain)).postmaster).toMatchObject({ status: 'not_connected' });
        });

        it('#183 reads Postmaster once per domain per day: a day’s reading is kept until the next day, UTC', async () => {
            expect(await connectPostmaster()).toBe('connected');
            await due(goodDomain);
            postmaster.setSpamRate(goodDomain, 5);
            const first = await checkDomain(goodDomain);
            expect(first.postmaster).toEqual({ status: 'ok', message: null, nextReadAt: nextUtcMidnight() });
            expect(first.spamRate).toEqual({ day: yesterday, rateBps: 5 });
            // Checked again today: the reading stands, Postmaster is not asked.
            const reads = postmaster.lookups.length;
            const second = await checkDomain(goodDomain);
            expect(postmaster.lookups).toHaveLength(reads);
            expect(second.spamRate).toEqual({ day: yesterday, rateBps: 5 });
            expect(second.postmaster).toEqual(first.postmaster);
            expect(second.status).toBe('pass');
        });

        it('#183 a 429 is a rate limit: the last reading stays, nothing is a warning, and the next try waits for Retry-After or backs off from the check’s cadence', async () => {
            await log.reset();
            await due(goodDomain);
            postmaster.rateLimitNext(1, 120);
            const limited = await checkDomain(goodDomain);
            expect(limited.status).toBe('pass');
            expect(limited.spamRate).toEqual({ day: yesterday, rateBps: 5 });
            expect(limited.postmaster.status).toBe('rate_limited');
            expect(limited.postmaster.message).toMatch(/rate-limiting/);
            expectAbout(limited.postmaster.nextReadAt, 120_000);
            expect((await recorded()).filter((e) => e.type === 'mailbox.paused')).toHaveLength(0);
            expect((await view()).mailboxes.every((m) => m.paused === null)).toBe(true);
            // Not asked again before then.
            const reads = postmaster.lookups.length;
            expect((await checkDomain(goodDomain)).postmaster).toEqual(limited.postmaster);
            expect(postmaster.lookups).toHaveLength(reads);
            // Without a Retry-After: the check's cadence, doubled on each consecutive limit.
            await due(goodDomain);
            postmaster.rateLimitNext(1);
            expectAbout((await checkDomain(goodDomain)).postmaster.nextReadAt, SENDING_DOMAIN_RECHECK_MS);
            await owner.sendingDomain.updateMany({
                where: { workspaceId: workspace, domain: goodDomain },
                data: { postmasterNextReadAt: null },
            });
            postmaster.rateLimitNext(1);
            expectAbout((await checkDomain(goodDomain)).postmaster.nextReadAt, 2 * SENDING_DOMAIN_RECHECK_MS);
            // A reading ends the backoff: the day is read, and the next read waits for tomorrow.
            await owner.sendingDomain.updateMany({
                where: { workspaceId: workspace, domain: goodDomain },
                data: { postmasterNextReadAt: null },
            });
            const back = await checkDomain(goodDomain);
            expect(back.postmaster).toEqual({ status: 'ok', message: null, nextReadAt: nextUtcMidnight() });
            expect(
                await owner.sendingDomain.findFirst({ where: { workspaceId: workspace, domain: goodDomain } }),
            ).toMatchObject({
                postmasterLimitedTimes: 0,
            });
        });

        it('#183 no answer is transient too (tried again at the cadence, no warning); a refused token is the warning', async () => {
            await due(goodDomain);
            postmaster.failNext(1, 503);
            const down = await checkDomain(goodDomain);
            expect(down.postmaster).toMatchObject({ status: 'unreachable', message: expect.stringContaining('503') });
            expectAbout(down.postmaster.nextReadAt, SENDING_DOMAIN_RECHECK_MS);
            expect(down.spamRate).toEqual({ day: yesterday, rateBps: 5 });
            await due(goodDomain);
            postmaster.failNext(1, 401);
            const refused = await checkDomain(goodDomain);
            expect(refused.postmaster).toMatchObject({ status: 'failed', message: expect.stringContaining('401') });
            expectAbout(refused.postmaster.nextReadAt, SENDING_DOMAIN_RECHECK_MS);
        });
    });
});
