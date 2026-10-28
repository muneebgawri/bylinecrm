import { Prisma } from '@prisma/client';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, type SendingPoolView } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { MailSendService } from '../../src/mail-send/mail-send.service';
import { buildMime, newMessageId } from '../../src/mail-send/mime';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { MailSyncService } from '../../src/mail-sync/mail-sync.service';
import { DNS_PORT } from '../../src/sending-pool/dns.port';
import { SMTP2GO_PORT } from '../../src/smtp2go/smtp2go.port';
import { SuppressionService } from '../../src/suppression/suppression.service';
import { FakeDns } from '../support/fake-dns';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { FakeSmtp2Go } from '../support/fake-smtp2go';
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

interface Smtp2GoView {
    mailbox: { id: string; email: string; purpose: string; transport: string; status: string };
    hookUrl: string;
    hookAuthorization: string | null;
    lastHookResult: string | null;
}

/**
 * SMTP2Go as the outreach pool's second transport (TRANS-1) end to end: an admin adds an SMTP2Go pool mailbox
 * (the key sealed, never shown back); a pool send goes through SMTP2Go after the pool's gate and is stored like
 * a Gmail send; 1:1 mail never goes that way; an attempt that may have reached SMTP2Go is never repeated; the
 * webhook, proven by the mailbox's secret, records bounces, complaints, opens and clicks into the tables the
 * Gmail path writes; and one workspace never sees, changes or reports into another's.
 */
describe('TRANS-1 SMTP2Go pool transport (FR-CRMS-6, FR-CRMS-7, FR-CRMS-8, FR-CRMS-13)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let send: MailSendService;
    let sync: MailSyncService;
    let suppressions: SuppressionService;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);
    const dns = new FakeDns();
    const smtp2go = new FakeSmtp2Go();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const domain = `s2g-${stamp}.example`;
    const otherDomain = `s2g-other-${stamp}.example`;
    const apiKey = `api-${randomUUID().replace(/-/g, '')}`;
    const otherKey = `api-${randomUUID().replace(/-/g, '')}`;
    let admin: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let mine: Smtp2GoView;
    let theirs: Smtp2GoView;
    let log: EventLog;
    const noWait = { sleep: () => Promise.resolve() };

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const hook = (view: Smtp2GoView, body: object, authorization = view.hookAuthorization) => {
        const req = http().post(new URL(view.hookUrl).pathname);
        return (authorization ? req.set('Authorization', authorization) : req).send(body);
    };

    /** A pool send queued from the SMTP2Go mailbox, as a sequence step queues one (`outreach`). */
    async function queueSend(mailboxId: string, to: string, kind: 'outreach' | 'personal' = 'outreach') {
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
                request: { kind },
                mime: buildMime({
                    from: { address: box.email, name: 'Pool' },
                    to: [{ address: to, name: null }],
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
        return { id, rfc822MessageId };
    }
    const outcome = (id: string) =>
        owner.mailOutbound.findUniqueOrThrow({
            where: { id },
            select: { status: true, lastError: true, providerMessageId: true, mailMessageId: true },
        });
    async function sent(to: string) {
        const queued = await queueSend(mine.mailbox.id, to);
        expect(await send.deliver(workspace, queued.id, noWait)).toBe('sent');
        const row = await outcome(queued.id);
        return { ...queued, emailId: row.providerMessageId!.replace(/^smtp2go:/, '') };
    }

    beforeAll(async () => {
        for (const [d, sel] of [
            [domain, 's123'],
            [otherDomain, 's456'],
        ] as const) {
            dns.set(d, 'v=spf1 include:spf.smtp2go.com ~all');
            dns.set(`${sel}._domainkey.${d}`, 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEB');
            dns.set(`_dmarc.${d}`, 'v=DMARC1; p=none');
        }
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .overrideProvider(DNS_PORT)
            .useValue(dns)
            .overrideProvider(SMTP2GO_PORT)
            .useValue(smtp2go)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        send = app.get(MailSendService);
        sync = app.get(MailSyncService);
        suppressions = app.get(SuppressionService);
        log = await eventLog(
            app,
            'email.bounced',
            'email.complained',
            'email.opened',
            'email.clicked',
            'email.sent',
            'email.failed',
            'suppression.added',
        );

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(`s2g-admin-${stamp}@example.com`, `S2G ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(
            `s2g-other-${stamp}@example.com`,
            `S2G other ${stamp}`,
        ));

        const add = async (who: Browser, ws: string, email: string, key: string, dkimSelector: string) => {
            const res = await as(who)
                .post(w('/smtp2go/mailboxes', ws))
                .send({ email, apiKey: key, dkimSelector, label: 'Outreach' });
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            return res.body as Smtp2GoView;
        };
        mine = await add(admin, workspace, `Pool-${stamp}@${domain}`, apiKey, 's123');
        theirs = await add(otherAdmin, otherWorkspace, `pool-${stamp}@${otherDomain}`, otherKey, 's456');
        for (const [who, ws] of [
            [admin, workspace],
            [otherAdmin, otherWorkspace],
        ] as const) {
            const view = (await as(who).get(w('/sending-pool', ws))).body as SendingPoolView;
            for (const d of view.domains) {
                await as(who)
                    .post(w(`/sending-domains/${d.id}/check`, ws))
                    .expect(200);
            }
            await as(who)
                .put(w('/sending-pool/settings', ws))
                .send({ ...view.settings, dailyCap: 50, warmupStartPerDay: 50, warmupDays: 1, rateMinSample: 100 })
                .expect(200);
        }
    });

    afterAll(async () => {
        await app?.close();
    });

    beforeEach(async () => {
        smtp2go.clear();
        await log.reset();
    });

    describe('adding an SMTP2Go pool mailbox (admin only)', () => {
        it('adds a pool mailbox whose key is sealed and never shown back', async () => {
            expect(mine.mailbox).toMatchObject({
                email: `pool-${stamp}@${domain}`,
                purpose: 'pool',
                transport: 'smtp2go',
                status: 'connected',
            });
            expect(mine.hookUrl).toMatch(new RegExp(`/api/hooks/smtp2go/${mine.mailbox.id}$`));
            expect(mine.hookAuthorization).toMatch(/^Bearer \S{20,}$/);
            const listed = await as(admin).get(w('/smtp2go/mailboxes')).expect(200);
            const mailboxes = await as(admin).get(w('/mailboxes')).expect(200);
            for (const body of [listed.text, mailboxes.text, JSON.stringify(mine)]) expect(body).not.toContain(apiKey);
            const row = await owner.mailbox.findUniqueOrThrow({ where: { id: mine.mailbox.id } });
            expect(row.transportKeyCiphertext).toBeTruthy();
            expect(row.transportKeyCiphertext).not.toContain(apiKey);
            expect(row.warmupStartedAt).not.toBeNull();
            const domainRow = await owner.sendingDomain.findFirstOrThrow({ where: { workspaceId: workspace, domain } });
            expect(domainRow).toMatchObject({ dkimSelector: 'google', extraDkimSelectors: ['s123'], status: 'pass' });
        });

        it('refuses a malformed key and an address already connected', async () => {
            await as(admin)
                .post(w('/smtp2go/mailboxes'))
                .send({ email: `x-${stamp}@${domain}`, apiKey: 'not-a-key' })
                .expect(400);
            const again = await as(admin)
                .post(w('/smtp2go/mailboxes'))
                .send({ email: mine.mailbox.email, apiKey: otherKey });
            expect(again.status).toBe(409);
        });

        it('never lets an SMTP2Go mailbox be personal: the database refuses it', async () => {
            await expect(
                owner.mailbox.update({ where: { id: mine.mailbox.id }, data: { purpose: 'personal' } }),
            ).rejects.toThrow();
        });

        it('keeps another workspace from seeing or changing it', async () => {
            const list = (await as(otherAdmin).get(w('/smtp2go/mailboxes', otherWorkspace)).expect(200))
                .body as Smtp2GoView[];
            expect(list.map((m) => m.mailbox.id)).toEqual([theirs.mailbox.id]);
            await as(otherAdmin)
                .put(w(`/smtp2go/mailboxes/${mine.mailbox.id}/api-key`, otherWorkspace))
                .send({ apiKey: otherKey })
                .expect(404);
            await as(otherAdmin)
                .post(w(`/smtp2go/mailboxes/${mine.mailbox.id}/rotate-secret`, otherWorkspace))
                .expect(404);
            await as(otherAdmin).get(w('/smtp2go/mailboxes')).expect(403);
        });
    });

    describe('sending through SMTP2Go', () => {
        it('sends a pool send through SMTP2Go with the mailbox’s key, and stores it as Gmail sends are', async () => {
            const queued = await queueSend(mine.mailbox.id, `ann-${stamp}@acme.example`);
            expect(await send.deliver(workspace, queued.id, noWait)).toBe('sent');
            expect(smtp2go.sent).toHaveLength(1);
            expect(smtp2go.sent[0]!.apiKey).toBe(apiKey);
            expect(smtp2go.sent[0]!.mime).toContain(`Message-ID: <${queued.rfc822MessageId}>`);
            expect(gmail.sent.filter((m) => m.email === mine.mailbox.email)).toHaveLength(0);
            const row = await outcome(queued.id);
            expect(row).toMatchObject({ status: 'sent', providerMessageId: `smtp2go:${smtp2go.sent[0]!.emailId}` });
            expect(row.mailMessageId).not.toBeNull();
            const message = await owner.mailMessage.findUniqueOrThrow({ where: { id: row.mailMessageId! } });
            expect(message).toMatchObject({ direction: 'outbound', rfc822MessageId: queued.rfc822MessageId });
            expect((await log.read()).filter((e) => e.type === 'email.sent' && e.recordId === message.id)).toHaveLength(
                1,
            );
        });

        it('never sends 1:1 or personal mail through SMTP2Go', async () => {
            const queued = await queueSend(mine.mailbox.id, `bob-${stamp}@acme.example`, 'personal');
            expect(await send.deliver(workspace, queued.id, noWait)).toBe('failed');
            expect((await outcome(queued.id)).lastError).toMatchObject({ code: 'transport.pool_only' });
            expect(smtp2go.sent).toHaveLength(0);
        });

        it('rechecks the suppression list before the attempt', async () => {
            const to = `supp-${stamp}@acme.example`;
            const queued = await queueSend(mine.mailbox.id, to);
            await suppressions.suppress(workspace, { address: to, reason: 'manual', source: 'member' });
            expect(await send.deliver(workspace, queued.id, noWait)).toBe('failed');
            expect((await outcome(queued.id)).lastError).toMatchObject({ code: 'recipient.suppressed' });
            expect(smtp2go.sent).toHaveLength(0);
        });

        it('retries an attempt that certainly did not go, and never repeats one that may have', async () => {
            const first = await queueSend(mine.mailbox.id, `retry-${stamp}@acme.example`);
            smtp2go.failNext('retry');
            await expect(send.deliver(workspace, first.id, noWait)).rejects.toThrow();
            expect(await outcome(first.id)).toMatchObject({
                status: 'sending',
                lastError: { code: 'smtp2go.not_sent' },
            });
            expect(await send.deliver(workspace, first.id, noWait)).toBe('sent');

            const second = await queueSend(mine.mailbox.id, `lost-${stamp}@acme.example`);
            smtp2go.failNext('unconfirmed');
            expect(await send.deliver(workspace, second.id, noWait)).toBe('failed');
            expect((await outcome(second.id)).lastError).toMatchObject({ code: 'smtp2go.unconfirmed' });

            const third = await queueSend(mine.mailbox.id, `refused-${stamp}@acme.example`);
            smtp2go.failNext('refused');
            expect(await send.deliver(workspace, third.id, noWait)).toBe('failed');
            expect((await outcome(third.id)).lastError).toMatchObject({ code: 'smtp2go.api_key_invalid' });
            expect(smtp2go.sent).toHaveLength(1);
        });

        it('is never read by mail sync', async () => {
            expect(await sync.syncMailbox(workspace, mine.mailbox.id, noWait)).toMatchObject({ mode: 'skipped' });
        });
    });

    describe('"Send test" (admin only)', () => {
        const used = async () =>
            (
                (await as(admin).get(w('/sending-pool'))).body as {
                    mailboxes: { mailboxId: string; used: number }[];
                }
            ).mailboxes.find((m) => m.mailboxId === mine.mailbox.id)?.used;

        it('sends one message to the admin through the mailbox, matched by its webhook, outside the allowance', async () => {
            const before = await used();
            const res = await as(admin)
                .post(w(`/smtp2go/mailboxes/${mine.mailbox.id}/test`))
                .expect(200);
            const result = res.body as { outcome: string; to: string; outboundId: string };
            expect(result).toMatchObject({ outcome: 'sent', to: `s2g-admin-${stamp}@example.com`, error: null });
            expect(smtp2go.sent).toHaveLength(1);
            expect(smtp2go.sent[0]!.apiKey).toBe(apiKey);
            expect(smtp2go.sent[0]!.mime).toContain(`X-BylineCRM-Id: ${result.outboundId}`);
            const row = await owner.mailOutbound.findUniqueOrThrow({ where: { id: result.outboundId } });
            expect(row).toMatchObject({ status: 'sent', isTest: true, mailboxId: mine.mailbox.id, personId: null });
            expect(await used()).toBe(before);

            const emailId = row.providerMessageId!.replace(/^smtp2go:/, '');
            const delivered = {
                event: 'delivered',
                email_id: emailId,
                rcpt: result.to,
                time: new Date().toISOString(),
            };
            expect((await hook(mine, delivered).expect(200)).body).toEqual({ result: 'recorded' });
            const listed = (await as(admin).get(w('/smtp2go/mailboxes')).expect(200)).body as Smtp2GoView[];
            expect(listed.find((m) => m.mailbox.id === mine.mailbox.id)?.lastHookResult).toBe('recorded');
        });

        it('never passes the suppression list, and says when SMTP2Go refuses it', async () => {
            const me = `s2g-admin-${stamp}@example.com`;
            const entry = await suppressions.suppress(workspace, { address: me, reason: 'manual', source: 'member' });
            const refused = (
                await as(admin)
                    .post(w(`/smtp2go/mailboxes/${mine.mailbox.id}/test`))
                    .expect(200)
            ).body;
            expect(refused).toMatchObject({
                outcome: 'refused',
                outboundId: null,
                error: { code: 'recipient.suppressed' },
            });
            expect(smtp2go.sent).toHaveLength(0);
            await owner.suppression.update({
                where: { id: entry.id },
                data: { removedAt: new Date(), removalNote: 'test over' },
            });

            smtp2go.failNext('refused');
            const failed = (
                await as(admin)
                    .post(w(`/smtp2go/mailboxes/${mine.mailbox.id}/test`))
                    .expect(200)
            ).body as {
                outboundId: string;
            };
            expect(failed).toMatchObject({ outcome: 'refused', error: { code: 'smtp2go.api_key_invalid' } });
            expect((await owner.mailOutbound.findUniqueOrThrow({ where: { id: failed.outboundId } })).status).toBe(
                'failed',
            );
        });

        it('is an admin’s, for this workspace’s mailboxes only', async () => {
            await as(otherAdmin)
                .post(w(`/smtp2go/mailboxes/${mine.mailbox.id}/test`, otherWorkspace))
                .expect(404);
            expect(smtp2go.sent).toHaveLength(0);
        });
    });

    describe('SMTP2Go’s webhook', () => {
        it('refuses a delivery without this mailbox’s secret, and another workspace’s secret', async () => {
            const body = { event: 'processed', email_id: 'x' };
            await hook(mine, body, null).expect(401);
            await hook(mine, body, 'Bearer wrong').expect(401);
            await hook(mine, body, theirs.hookAuthorization).expect(401);
            expect((await owner.mailbox.findUniqueOrThrow({ where: { id: mine.mailbox.id } })).lastHookResult).toBe(
                'bad_secret',
            );
            await http()
                .post(`/api/hooks/smtp2go/${randomUUID()}`)
                .set('Authorization', mine.hookAuthorization!)
                .send(body)
                .expect(404);
            expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'ignored' });
        });

        it('records a hard bounce, suppresses the address, and changes nothing when redelivered', async () => {
            const to = `bounce-${stamp}@acme.example`;
            const s = await sent(to);
            const body = {
                event: 'bounce',
                email_id: s.emailId,
                rcpt: to,
                bounce: 'hard',
                message: '550 5.1.1 user unknown',
                time: new Date().toISOString(),
            };
            expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'recorded' });
            expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'duplicate' });
            await settle(app);
            const bounces = await owner.mailBounce.findMany({ where: { mailboxId: mine.mailbox.id, address: to } });
            expect(bounces).toEqual([
                expect.objectContaining({ permanent: true, status: '5.1.1', outboundId: s.id, messageId: null }),
            ]);
            expect((await suppressions.check(workspace, [to])).get(to)?.reason).toBe('hard_bounce');
            const events = (await log.read()).filter((e) => e.type === 'email.bounced');
            expect(events).toEqual([
                expect.objectContaining({
                    bounce: {
                        mailboxId: mine.mailbox.id,
                        address: to,
                        permanent: true,
                        status: '5.1.1',
                        outboundId: s.id,
                    },
                }),
            ]);
        });

        it('suppresses a complaint (counted for the pool’s rate) and announces it once', async () => {
            const to = `spam-${stamp}@acme.example`;
            const s = await sent(to);
            const body = { event: 'spam', 'message-id': `<${s.rfc822MessageId}>`, rcpt: to, time: '1760954400' };
            expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'recorded' });
            expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'duplicate' });
            const entry = await owner.suppression.findFirstOrThrow({
                where: { workspaceId: workspace, address: to, removedAt: null },
            });
            expect(entry).toMatchObject({ reason: 'complaint', source: 'provider', outboundId: s.id });
            expect((await log.read()).filter((e) => e.type === 'email.complained')).toEqual([
                expect.objectContaining({
                    recordId: s.id,
                    complaint: { mailboxId: mine.mailbox.id, address: to, outboundId: s.id },
                }),
            ]);
        });

        it('records opens and clicks into the tracking tables, once each', async () => {
            const to = `open-${stamp}@acme.example`;
            const s = await sent(to);
            const later = new Date(Date.now() + 10 * 60_000).toISOString();
            const open = { event: 'open', email_id: s.emailId, rcpt: to, time: later, 'user-agent': 'Mozilla/5.0' };
            const click = { ...open, event: 'click', url: 'https://acme.example/pricing' };
            expect((await hook(mine, open).expect(200)).body).toEqual({ result: 'recorded' });
            expect((await hook(mine, click).expect(200)).body).toEqual({ result: 'recorded' });
            expect((await hook(mine, click).expect(200)).body).toEqual({ result: 'duplicate' });
            const hits = await owner.trackingHit.findMany({ where: { outboundId: s.id }, orderBy: { kind: 'asc' } });
            expect(hits.map((h) => [h.kind, h.tokenId, h.url, h.botReason])).toEqual([
                ['click', null, 'https://acme.example/pricing', null],
                ['open', null, null, null],
            ]);
            const events = await log.read();
            expect(events.filter((e) => e.type === 'email.opened' && e.recordId === s.id)).toHaveLength(1);
            expect(events.filter((e) => e.type === 'email.clicked' && e.recordId === s.id)).toEqual([
                expect.objectContaining({ tracking: expect.objectContaining({ url: 'https://acme.example/pricing' }) }),
            ]);
        });

        it('fails a send SMTP2Go rejected for a reason on our side, once, and suppresses nothing', async () => {
            const to = `reject-${stamp}@acme.example`;
            const s = await sent(to);
            const body = {
                event: 'reject',
                email_id: s.emailId,
                rcpt: to,
                message: 'Sender address is not verified',
                time: new Date().toISOString(),
            };
            expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'recorded' });
            expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'duplicate' });
            expect((await hook(mine, { ...body, event: 'rejected' }).expect(200)).body).toEqual({
                result: 'duplicate',
            });
            const row = await owner.mailOutbound.findUniqueOrThrow({ where: { id: s.id } });
            expect(row.status).toBe('failed');
            expect(row.lastError).toMatchObject({
                code: 'smtp2go.rejected',
                message: expect.stringContaining('not verified'),
            });
            expect((await log.read()).filter((e) => e.type === 'email.failed' && e.recordId === s.id)).toEqual([
                expect.objectContaining({ failure: expect.objectContaining({ code: 'smtp2go.rejected' }) }),
            ]);
            expect((await suppressions.check(workspace, [to])).has(to)).toBe(false);
        });

        it('reads the reject’s wording when SMTP2Go’s suppressions cannot be read', async () => {
            const cases = [
                ['unsub', 'Recipient is on the suppression list (unsubscribed)', 'unsubscribe'],
                ['spam', 'Recipient suppressed: spam complaint', 'complaint'],
                ['hard', 'Recipient suppressed after a hard bounce', 'hard_bounce'],
            ] as const;
            for (const [tag, message, reason] of cases) {
                const to = `reject-${tag}-${stamp}@acme.example`;
                const s = await sent(to);
                const body = {
                    event: 'reject',
                    email_id: s.emailId,
                    rcpt: to,
                    message,
                    time: new Date().toISOString(),
                };
                expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'recorded' });
                expect((await owner.mailOutbound.findUniqueOrThrow({ where: { id: s.id } })).lastError).toMatchObject({
                    code: 'smtp2go.rejected_suppressed',
                });
                expect(
                    await owner.suppression.findFirstOrThrow({
                        where: { workspaceId: workspace, address: to, removedAt: null },
                    }),
                ).toMatchObject({ reason, source: 'provider', outboundId: s.id });
            }
            await settle(app);
            expect((await owner.mailbox.findUniqueOrThrow({ where: { id: mine.mailbox.id } })).pausedAt).toBeNull();
        });

        it('asks SMTP2Go’s suppressions whose a reject was, whatever its wording says', async () => {
            const held = `reject-held-${stamp}@acme.example`;
            const blocked = `reject-blocked-${stamp}@acme.example`;
            const free = `reject-free-${stamp}@acme.example`;
            smtp2go.holdSuppressions({ [held]: 'spam', [blocked]: 'compliance' });
            const reject = async (to: string, message: string) => {
                const s = await sent(to);
                const body = {
                    event: 'reject',
                    email_id: s.emailId,
                    rcpt: to,
                    message,
                    time: new Date().toISOString(),
                };
                expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'recorded' });
                return s;
            };
            // The wording names no suppression; SMTP2Go's list says it is a complaint.
            const a = await reject(held, 'Message rejected');
            expect((await owner.mailOutbound.findUniqueOrThrow({ where: { id: a.id } })).lastError).toMatchObject({
                code: 'smtp2go.rejected_suppressed',
            });
            expect(
                await owner.suppression.findFirstOrThrow({ where: { workspaceId: workspace, address: held } }),
            ).toMatchObject({ reason: 'complaint', source: 'provider', outboundId: a.id });
            // A block SMTP2Go names otherwise is still the recipient's: manual here.
            await reject(blocked, 'Message rejected');
            expect(
                await owner.suppression.findFirstOrThrow({ where: { workspaceId: workspace, address: blocked } }),
            ).toMatchObject({ reason: 'manual', source: 'provider' });
            // Wording that sounds like a suppression, but SMTP2Go holds none: ours, and nothing suppressed.
            const c = await reject(free, 'Recipient is on the suppression list (unsubscribed)');
            expect((await owner.mailOutbound.findUniqueOrThrow({ where: { id: c.id } })).lastError).toMatchObject({
                code: 'smtp2go.rejected',
            });
            expect(await owner.suppression.count({ where: { workspaceId: workspace, address: free } })).toBe(0);
        });

        it('suppresses an address unsubscribed through SMTP2Go, from the provider; a resubscribe lifts nothing', async () => {
            const to = `unsub-${stamp}@acme.example`;
            const s = await sent(to);
            const body = { event: 'unsubscribe', email_id: s.emailId, rcpt: to, time: new Date().toISOString() };
            expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'recorded' });
            expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'duplicate' });
            const resubscribe = { ...body, event: 'resubscribe', time: new Date(Date.now() + 60_000).toISOString() };
            expect((await hook(mine, resubscribe).expect(200)).body).toEqual({ result: 'ignored' });
            const entries = await owner.suppression.findMany({ where: { workspaceId: workspace, address: to } });
            expect(entries).toEqual([
                expect.objectContaining({
                    reason: 'unsubscribe',
                    source: 'provider',
                    outboundId: s.id,
                    removedAt: null,
                }),
            ]);
            expect((await log.read()).filter((e) => e.type === 'suppression.added')).toHaveLength(1);
            expect((await log.read()).filter((e) => e.type === 'email.complained')).toHaveLength(0);
        });

        it('records when the send was delivered, the first report kept', async () => {
            const to = `delivered-${stamp}@acme.example`;
            const s = await sent(to);
            const at = '2026-10-20T10:00:00.000Z';
            const body = { event: 'delivered', 'message-id': `<${s.rfc822MessageId}>`, rcpt: to, time: at };
            expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'recorded' });
            expect((await hook(mine, body).expect(200)).body).toEqual({ result: 'duplicate' });
            expect((await hook(mine, { ...body, time: '2026-10-20T11:00:00.000Z' }).expect(200)).body).toEqual({
                result: 'duplicate',
            });
            const row = await owner.mailOutbound.findUniqueOrThrow({ where: { id: s.id } });
            expect(row.deliveredAt?.toISOString()).toBe(at);
            expect(row.status).toBe('sent');
            expect((await hook(mine, { event: 'processed', email_id: s.emailId }).expect(200)).body).toEqual({
                result: 'ignored',
            });
        });

        it('pauses the mailbox and tells its admins after a few rejects on our side in a row; tests never count', async () => {
            const reject = async (s: { emailId: string }, to: string) =>
                hook(mine, {
                    event: 'reject',
                    email_id: s.emailId,
                    rcpt: to,
                    message: 'API key is sandboxed',
                    time: new Date().toISOString(),
                }).expect(200);
            for (let i = 0; i < 2; i += 1) {
                const to = `misconf-${i}-${stamp}@acme.example`;
                await reject(await sent(to), to);
            }
            // A rejected test send between them is no part of the run.
            const test = (
                await as(admin)
                    .post(w(`/smtp2go/mailboxes/${mine.mailbox.id}/test`))
                    .expect(200)
            ).body as {
                outboundId: string;
                to: string;
            };
            const testRow = await owner.mailOutbound.findUniqueOrThrow({ where: { id: test.outboundId } });
            await reject({ emailId: testRow.providerMessageId!.replace(/^smtp2go:/, '') }, test.to);
            await settle(app);
            expect((await owner.mailbox.findUniqueOrThrow({ where: { id: mine.mailbox.id } })).pausedAt).toBeNull();

            const to = `misconf-2-${stamp}@acme.example`;
            await reject(await sent(to), to);
            await settle(app);
            const paused = await owner.mailbox.findUniqueOrThrow({ where: { id: mine.mailbox.id } });
            expect(paused.pausedAt).not.toBeNull();
            expect(paused.pauseReason).toMatchObject({ code: 'rejected_sends', sends: 3 });
            expect(
                await owner.guardrailEvent.findMany({ where: { workspaceId: workspace, kind: 'rejected_sends' } }),
            ).toEqual([expect.objectContaining({ outcome: 'blocked', severity: 'high' })]);
            // Back to work for the tests after this one.
            await owner.mailbox.update({
                where: { id: mine.mailbox.id },
                data: { pausedAt: null, pauseReason: Prisma.DbNull, resumedAt: new Date() },
            });
        });

        it('matches only this mailbox’s sends: another workspace’s hook cannot report on ours', async () => {
            const to = `cross-${stamp}@acme.example`;
            const s = await sent(to);
            const body = {
                event: 'bounce',
                email_id: s.emailId,
                rcpt: to,
                bounce: 'hard',
                time: new Date().toISOString(),
            };
            expect((await hook(theirs, body).expect(200)).body).toEqual({ result: 'unmatched' });
            expect(await owner.mailBounce.count({ where: { address: to } })).toBe(0);
        });

        it('stops hearing a mailbox once it is disconnected, and its key is wiped', async () => {
            const extra = (
                await as(admin)
                    .post(w('/smtp2go/mailboxes'))
                    .send({ email: `gone-${stamp}@${domain}`, apiKey })
                    .expect(201)
            ).body as Smtp2GoView;
            await as(admin)
                .delete(w(`/mailboxes/${extra.mailbox.id}`))
                .expect(200);
            const row = await owner.mailbox.findUniqueOrThrow({ where: { id: extra.mailbox.id } });
            expect(row).toMatchObject({
                status: 'disconnected',
                transportKeyCiphertext: null,
                hookSecretCiphertext: null,
            });
            await hook(extra, { event: 'delivered' }).expect(404);
        });
    });
});
