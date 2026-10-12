import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_SCOPES,
    SESSION_COOKIE,
    type EnrolmentBatchResult,
    type EnrolmentView,
    type RegionPolicyChange,
    type RegionPolicyEntry,
    type SequenceView,
} from '@bylinecrm/shared';
import type { Queue } from 'bullmq';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MailSendService } from '../../src/mail-send/mail-send.service';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { MailSyncService } from '../../src/mail-sync/mail-sync.service';
import { DNS_PORT } from '../../src/sending-pool/dns.port';
import { SEQUENCE_STEP_QUEUE } from '../../src/sequences/sequences.constants';
import { SequenceRunner, stepJobId } from '../../src/sequences/sequence-runner';
import { SequenceSweep } from '../../src/sequences/sequence-sweep';
import { FakeDns } from '../support/fake-dns';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
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

const t = (text: string) => ({ type: 'text', text });
const v = (path: string) => ({ type: 'variable', attrs: { path } });
const para = (...content: object[]) => ({ type: 'paragraph', content });
const doc = (...content: object[]) => ({ type: 'doc', content });

/**
 * Sequences (P3-3, FR-CRMS-5, -10, -11, -12) end to end, against a fake Gmail and a fake DNS: the
 * enrolment gates — FR-CRMS-11 source, FR-CRMS-12 region policy (EU/UK/Canada blocked by default,
 * D-247), FR-CRMS-10 exclusions, FR-CRMS-7 suppression — each refusing per person with the server's
 * reason; idempotent enrolment; a step sent from the sending pool as outreach (one-click unsubscribe);
 * a reply stopping the sequence before the next step; a cap refusal rescheduling, never dropping, the
 * step; a lost job recovered by the sweep; and one workspace never seeing or enrolling another's.
 */
describe('FR-CRMS-5 sequences', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let send: MailSendService;
    let sync: MailSyncService;
    let runner: SequenceRunner;
    let sweep: SequenceSweep;
    let queue: Queue;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);
    const dns = new FakeDns();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const domain = `seq-${stamp}.example`;
    const poolAddress = `pool-${stamp}@${domain}`;
    let admin: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let poolMailbox: string;
    let template: string;
    let followUp: string;
    const noWait = { sleep: () => Promise.resolve() };

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;

    let n = 0;
    async function person(fields: Record<string, unknown>, who = admin, ws = workspace): Promise<string> {
        n += 1;
        const res = await as(who)
            .post(w('/people', ws))
            .send({ nameFirst: `P${n}`, nameLast: 'Test', source: 'test list', ...fields });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return (res.body as { id: string }).id;
    }
    const address = (label: string) => `${label}-${stamp}@prospect.example`;

    async function sequence(steps: object[], extra: Record<string, unknown> = {}): Promise<SequenceView> {
        const created = await as(admin)
            .post(w('/sequences'))
            .send({
                name: `Seq ${stamp} ${(n += 1)}`,
                timeZone: 'UTC',
                // Open all day, every day: the window logic has its own unit tests.
                window: { startMinute: 0, endMinute: 1440, days: 127 },
                ...extra,
            });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = (created.body as SequenceView).id;
        const put = await as(admin)
            .put(w(`/sequences/${id}/steps`))
            .send({ steps });
        expect(put.status, JSON.stringify(put.body)).toBe(200);
        return put.body as SequenceView;
    }
    async function activate(id: string): Promise<Response> {
        return as(admin).post(w(`/sequences/${id}/activate`));
    }
    async function enrol(seq: string, personIds: string[], who = admin, ws = workspace): Promise<Response> {
        return as(who)
            .post(w(`/sequences/${seq}/enrolments`, ws))
            .send({ personIds });
    }
    const enrolment = (seq: string, personId: string) =>
        owner.sequenceEnrolment.findUniqueOrThrow({ where: { sequenceId_personId: { sequenceId: seq, personId } } });

    async function connectPool(email: string): Promise<string> {
        const start = await as(admin).post(w('/mailboxes/connect')).send({ purpose: 'pool' });
        expect(start.status, JSON.stringify(start.body)).toBe(201);
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email,
            scopes: [...GMAIL_SCOPES],
        });
        await as(admin).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        const list = (await as(admin).get(w('/mailboxes'))).body as { id: string; email: string }[];
        return list.find((m) => m.email === email)!.id;
    }

    beforeAll(async () => {
        dns.allowGoogle(domain);
        // Every prospect domain the tests enrol has a mail server (P3-5 verifies before enrolling).
        for (const d of ['prospect.example', 'halepr.co.uk', `ortiz-${stamp}.agency`, 'x.example']) {
            dns.setMx(d, `mx.${d}`);
        }
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
        send = app.get(MailSendService);
        sync = app.get(MailSyncService);
        runner = app.get(SequenceRunner);
        sweep = app.get(SequenceSweep);
        queue = app.get<Queue>(getQueueToken(SEQUENCE_STEP_QUEUE));

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(`seq-admin-${stamp}@example.com`, `Seq ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(
            `seq-other-${stamp}@example.com`,
            `Other seq ${stamp}`,
        ));

        const clientId = `555-s${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const secret = `GOCSPX-seq-${stamp}`;
        const oauth = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(oauth.body as { redirectUri: string }).redirectUri]);
        await as(admin).put(w('/mail/oauth-client')).send({ clientId, clientSecret: secret }).expect(200);
        poolMailbox = await connectPool(poolAddress);
        const domains = (await as(admin).get(w('/sending-domains'))).body as { id: string; domain: string }[];
        await as(admin)
            .post(w(`/sending-domains/${domains.find((d) => d.domain === domain)!.id}/check`))
            .expect(200);
        // No jitter, no warm-up: each test sets the cap it needs.
        const pool = (await as(admin).get(w('/sending-pool'))).body as { settings: Record<string, number> };
        await as(admin)
            .put(w('/sending-pool/settings'))
            .send({ ...pool.settings, warmupStartPerDay: 1, warmupDays: 1, jitterMinSeconds: 0, jitterMaxSeconds: 0 })
            .expect(200);

        const tpl = async (name: string, subject: string, body: object) => {
            const res = await as(admin).post(w('/templates')).send({ name, kind: 'outreach', subject, body });
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            return (res.body as { id: string }).id;
        };
        template = await tpl('Intro', 'Hello {{person.firstName}}', doc(para(t('Hi '), v('person.firstName'), t('.'))));
        followUp = await tpl('Follow-up', 'Following up', doc(para(t('Just following up.'))));
    });

    afterAll(async () => {
        await app?.close();
    });

    beforeEach(async () => {
        await owner.mailOutbound.updateMany({ where: { mailboxId: poolMailbox }, data: { sentAt: new Date(0) } });
        const pool = (await as(admin).get(w('/sending-pool'))).body as { settings: Record<string, number> };
        await as(admin)
            .put(w('/sending-pool/settings'))
            .send({ ...pool.settings, dailyCap: 100 })
            .expect(200);
    });

    describe('activating', () => {
        it('refuses a sequence with no email step, a personal template, or no postal address for the footer', async () => {
            const waitOnly = await sequence([{ kind: 'wait', waitDays: 2 }]);
            expect((await activate(waitOnly.id)).status).toBe(422);

            const personal = await as(admin)
                .post(w('/templates'))
                .send({ name: 'Personal', kind: 'personal', subject: 'Hi', body: doc(para(t('Hi'))) });
            const withPersonal = await as(admin)
                .post(w('/sequences'))
                .send({ name: `Personal ${stamp}`, timeZone: 'UTC' });
            const put = await as(admin)
                .put(w(`/sequences/${(withPersonal.body as SequenceView).id}/steps`))
                .send({ steps: [{ kind: 'email', templateId: (personal.body as { id: string }).id }] });
            expect(put.status).toBe(422);

            const ok = await sequence([{ kind: 'email', templateId: template }]);
            const refused = await activate(ok.id);
            expect(refused.status, JSON.stringify(refused.body)).toBe(422);
            expect(JSON.stringify(refused.body)).toContain('postal address');

            await as(admin)
                .put(w('/settings/mail'))
                .send({
                    postalAddress: { line1: '1 Main St', city: 'Springfield', postalCode: '12345', country: 'US' },
                    defaultSenderName: null,
                    unsubscribeFooterText: 'You received this because we think it is relevant.',
                })
                .expect(200);
            const active = await activate(ok.id);
            expect(active.status, JSON.stringify(active.body)).toBe(200);
            expect((active.body as SequenceView).status).toBe('active');
        });
    });

    describe('FR-CRMS-10, FR-CRMS-11, FR-CRMS-12, FR-CRMS-7: enrolment gates', () => {
        let seq: SequenceView;
        beforeAll(async () => {
            seq = await sequence([{ kind: 'email', templateId: template }]);
            expect((await activate(seq.id)).status).toBe(200);
        });

        it('refuses each person with the server’s reason, enrols the rest, and skips — never re-enrols — a person already in it', async () => {
            const ok = await person({ emails: { primary: address('ok'), additional: [] }, country: 'US' });
            const noSource = await person({ emails: { primary: address('nosrc'), additional: [] }, source: null });
            const noEmail = await person({ emails: { primary: null, additional: [] } });
            const eu = await person({ emails: { primary: address('eu'), additional: [] }, country: 'DE' });
            const uk = await person({ emails: { primary: `tom-${stamp}@halepr.co.uk`, additional: [] } });
            const customer = await person({ emails: { primary: `r-${stamp}@ortiz-${stamp}.agency`, additional: [] } });
            const worked = await person({ emails: { primary: address('worked'), additional: [] } });
            const suppressed = await person({ emails: { primary: address('supp'), additional: [] } });

            await as(admin)
                .post(w('/outreach/exclusions'))
                .send({ domain: `ortiz-${stamp}.agency`, reason: 'customer', source: 'newswireos' })
                .expect(201);
            await as(admin)
                .post(w('/outreach/exclusions'))
                .send({ address: address('worked'), reason: 'account_managed', accountManagerName: 'Dana Reyes' })
                .expect(201);
            await as(admin)
                .post(w('/suppressions'))
                .send({ address: address('supp') })
                .expect(201);

            const all = [ok, noSource, noEmail, eu, uk, customer, worked, suppressed];
            const preview = await as(admin)
                .post(w(`/sequences/${seq.id}/enrolments/preview`))
                .send({ personIds: all });
            expect(preview.status, JSON.stringify(preview.body)).toBe(200);
            const result = await enrol(seq.id, all);
            expect(result.status, JSON.stringify(result.body)).toBe(200);
            const body = result.body as EnrolmentBatchResult;
            // The preview is the same decision the enrol makes.
            expect(preview.body).toEqual(body);
            expect(body.enrolled).toEqual([ok]);
            const reason = (id: string) => body.refused.find((r) => r.personId === id);
            expect(reason(noSource)).toMatchObject({ code: 'source.missing' });
            expect(reason(noEmail)).toMatchObject({ code: 'email.missing' });
            expect(reason(eu)).toMatchObject({ code: 'region.blocked', message: expect.stringMatching(/EU.*policy/) });
            expect(reason(uk)).toMatchObject({ code: 'region.blocked', message: expect.stringMatching(/UK.*policy/) });
            expect(reason(customer)).toMatchObject({ code: 'excluded', message: expect.stringContaining('customer') });
            expect(reason(worked)).toMatchObject({ code: 'excluded', message: expect.stringContaining('Dana Reyes') });
            expect(reason(suppressed)).toMatchObject({ code: 'suppressed' });

            const again = (await enrol(seq.id, [ok])).body as EnrolmentBatchResult;
            expect(again).toEqual({ enrolled: [], skipped: [ok], refused: [], warnings: [] });
            expect(await owner.sequenceEnrolment.count({ where: { sequenceId: seq.id, personId: ok } })).toBe(1);
        });

        it('opens a region blocked by default only with a lawful basis stated', async () => {
            const missing = await as(admin).put(w('/outreach/region-policy')).send({ region: 'eu', allowed: true });
            expect(missing.status).toBe(400);
            expect(missing.body).toMatchObject({ code: 'validation.failed' });
            const opened = await as(admin)
                .put(w('/outreach/region-policy'))
                .send({ region: 'eu', allowed: true, lawfulBasis: 'Legitimate interest assessment LIA-7, on file.' });
            expect(opened.status, JSON.stringify(opened.body)).toBe(200);
            expect((opened.body as RegionPolicyEntry[]).find((p) => p.region === 'eu')).toMatchObject({
                allowed: true,
                isDefault: false,
            });
            const eu = await person({ emails: { primary: address('eu2'), additional: [] }, country: 'FR' });
            expect(((await enrol(seq.id, [eu])).body as EnrolmentBatchResult).enrolled).toEqual([eu]);
            await as(admin).put(w('/outreach/region-policy')).send({ region: 'eu', allowed: false }).expect(200);
        });

        it('#141 FR-CRMS-12: keeps every region policy change, who made it and why; a no-op is not a change', async () => {
            const before = await as(admin).get(w('/outreach/region-policy/changes'));
            expect(before.status, JSON.stringify(before.body)).toBe(200);
            const known = (before.body as RegionPolicyChange[]).length;
            await as(admin)
                .put(w('/outreach/region-policy'))
                .send({ region: 'ca', allowed: true, lawfulBasis: 'Express consent captured at sign-up.' })
                .expect(200);
            await as(admin).put(w('/outreach/region-policy')).send({ region: 'ca', allowed: false }).expect(200);
            // Setting a region to what it already is records nothing.
            await as(admin).put(w('/outreach/region-policy')).send({ region: 'ca', allowed: false }).expect(200);
            const after = (await as(admin).get(w('/outreach/region-policy/changes'))).body as RegionPolicyChange[];
            expect(after).toHaveLength(known + 2);
            expect(after[0]).toMatchObject({ region: 'ca', allowed: false, lawfulBasis: null });
            expect(after[1]).toMatchObject({
                region: 'ca',
                allowed: true,
                lawfulBasis: 'Express consent captured at sign-up.',
            });
            expect(after[0]!.changedBy).toEqual(expect.any(String));
            // Another workspace sees none of it.
            const theirs = (await as(otherAdmin).get(w('/outreach/region-policy/changes', otherWorkspace)))
                .body as RegionPolicyChange[];
            expect(theirs).toEqual([]);
        });
    });

    describe('running a sequence', () => {
        it('sends the first step from the pool as outreach, then waits, and a reply stops it before the next step', async () => {
            const seq = await sequence([
                { kind: 'email', templateId: template },
                { kind: 'wait', waitDays: 3, businessDays: false },
                { kind: 'email', templateId: followUp, replyInThread: true },
            ]);
            expect((await activate(seq.id)).status).toBe(200);
            const dana = await person({ nameFirst: 'Dana', emails: { primary: address('dana'), additional: [] } });
            expect(((await enrol(seq.id, [dana])).body as EnrolmentBatchResult).enrolled).toEqual([dana]);

            const now = new Date();
            await runner.run(workspace, (await enrolment(seq.id, dana)).id, now);
            const waiting = await enrolment(seq.id, dana);
            expect(waiting).toMatchObject({ status: 'active', stepIndex: 0, nextRunAt: null });
            const outboundId = waiting.waitingOutboundId!;
            const out = await owner.mailOutbound.findUniqueOrThrow({ where: { id: outboundId } });
            expect(out).toMatchObject({ mailboxId: poolMailbox, status: 'scheduled', sequenceEnrolmentId: waiting.id });

            expect(await send.deliver(workspace, outboundId, noWait, Date.now() + 1000)).toBe('sent');
            // Headers as a reader sees them: folded lines joined (RFC 5322 §2.2.3).
            const raw = gmail.sent.at(-1)!.raw.replace(/\r?\n[ \t]+/g, ' ');
            expect(raw).toMatch(/List-Unsubscribe: <https?:\/\/[^>]+>/);
            expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
            expect(raw).toContain('Hello Dana');
            await settle(app);

            const afterSend = await enrolment(seq.id, dana);
            expect(afterSend).toMatchObject({ status: 'active', stepIndex: 1, waitingOutboundId: null });
            await runner.run(workspace, afterSend.id, afterSend.nextRunAt!);
            const afterWait = await enrolment(seq.id, dana);
            expect(afterWait.stepIndex).toBe(2);
            expect(afterWait.nextRunAt!.getTime() - afterSend.nextRunAt!.getTime()).toBeGreaterThanOrEqual(
                3 * 24 * 3600_000 - 60_000,
            );

            // Dana replies before the follow-up is due.
            const sent = gmail.sent.at(-1)!;
            gmail.deliver(poolAddress, {
                from: `"Dana" <${address('dana')}>`,
                to: [poolAddress],
                subject: 'Re: Hello Dana',
                text: 'Not interested, thanks.',
                inReplyTo: sent.messageId,
                ...(sent.threadId ? { threadId: sent.threadId } : {}),
            });
            await sync.syncMailbox(workspace, poolMailbox, noWait);
            await settle(app);
            // Stopped by the event — and the step's own check would stop it too.
            const stopped = await enrolment(seq.id, dana);
            expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'reply' });
            const sends = await owner.mailOutbound.count({ where: { sequenceEnrolmentId: stopped.id } });
            await runner.run(workspace, stopped.id, afterWait.nextRunAt!);
            expect(await owner.mailOutbound.count({ where: { sequenceEnrolmentId: stopped.id } })).toBe(sends);
        });

        it('stops before a step when a reply arrived even if its event never did (the check before every step)', async () => {
            const seq = await sequence([
                { kind: 'wait', waitDays: 1, businessDays: false },
                { kind: 'email', templateId: template },
            ]);
            // Activation needs an email step; it has one.
            expect((await activate(seq.id)).status).toBe(200);
            const kim = await person({ nameFirst: 'Kim', emails: { primary: address('kim'), additional: [] } });
            await enrol(seq.id, [kim]);
            const e = await enrolment(seq.id, kim);
            await runner.run(workspace, e.id, new Date());
            const due = await enrolment(seq.id, kim);
            // A message from Kim is stored, but its stop is not delivered (written straight to the table).
            const thread = await owner.mailThread.create({
                data: { workspaceId: workspace, subject: 'Hi', lastMessageAt: new Date() },
            });
            const stored = await owner.mailMessage.create({
                data: {
                    workspaceId: workspace,
                    threadId: thread.id,
                    identityKey: `kim-${stamp}@prospect.example`,
                    direction: 'inbound',
                    rfc822MessageId: `kim-${stamp}@prospect.example`,
                    fromAddress: address('kim'),
                    sentAt: new Date(),
                    subject: 'Hi',
                    bodyText: 'Hello there',
                },
            });
            expect(stored.id).toBeTruthy();
            await runner.run(workspace, due.id, due.nextRunAt!);
            expect(await enrolment(seq.id, kim)).toMatchObject({ status: 'stopped', stopReason: 'reply' });
            expect(await owner.mailOutbound.count({ where: { sequenceEnrolmentId: due.id } })).toBe(0);
        });

        it('reschedules — never drops — a step its mailbox’s cap refused', async () => {
            const seq = await sequence([{ kind: 'email', templateId: template }]);
            expect((await activate(seq.id)).status).toBe(200);
            const lee = await person({ nameFirst: 'Lee', emails: { primary: address('lee'), additional: [] } });
            await enrol(seq.id, [lee]);
            const e = await enrolment(seq.id, lee);
            await runner.run(workspace, e.id, new Date());
            const outboundId = (await enrolment(seq.id, lee)).waitingOutboundId!;

            // The cap is used up between scheduling and sending: one send went in the last 24 hours and
            // the cap is 1, so the claim refuses this one.
            const pool = (await as(admin).get(w('/sending-pool'))).body as { settings: Record<string, number> };
            await as(admin)
                .put(w('/sending-pool/settings'))
                .send({ ...pool.settings, dailyCap: 1 })
                .expect(200);
            const box = await owner.mailbox.findUniqueOrThrow({ where: { id: poolMailbox } });
            await owner.mailOutbound.create({
                data: {
                    workspaceId: workspace,
                    mailboxId: poolMailbox,
                    senderMemberId: box.ownerMemberId,
                    status: 'sent',
                    rfc822MessageId: `filler-${stamp}@x.example`,
                    toAddresses: ['x@x.example'],
                    subject: 'x',
                    mime: 'x',
                    providerMessageId: `filler-${stamp}`,
                    providerThreadId: `filler-thr-${stamp}`,
                    attempts: 1,
                    sentAt: new Date(),
                    lastAttemptAt: new Date(),
                },
            });
            expect(await send.deliver(workspace, outboundId, noWait, Date.now() + 1000)).toBe('failed');
            await settle(app);

            const after = await enrolment(seq.id, lee);
            expect(after).toMatchObject({ status: 'active', stepIndex: 0, waitingOutboundId: null });
            expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
        });

        it('gives a due enrolment whose job was lost a job again, once', async () => {
            const seq = await sequence([{ kind: 'email', templateId: template }]);
            expect((await activate(seq.id)).status).toBe(200);
            const mo = await person({ emails: { primary: address('mo'), additional: [] } });
            await enrol(seq.id, [mo]);
            const e = await enrolment(seq.id, mo);
            const jobId = stepJobId(e.id, e.nextRunAt!);
            await (await queue.getJob(jobId))?.remove();
            expect(await queue.getJob(jobId)).toBeUndefined();

            const first = await sweep.run();
            expect(first.requeued).toBeGreaterThanOrEqual(1);
            expect(await queue.getJob(jobId)).toBeDefined();
            await sweep.run();
            const jobs = (await queue.getJobs(['delayed', 'waiting'])).filter((j) => j?.id === jobId);
            expect(jobs).toHaveLength(1);
        });

        it('stops an enrolment by hand, and re-enrols it from step 1 only when asked, naming the stop', async () => {
            const seq = await sequence([{ kind: 'email', templateId: template }]);
            expect((await activate(seq.id)).status).toBe(200);
            const ray = await person({ emails: { primary: address('ray'), additional: [] } });
            await enrol(seq.id, [ray]);
            const e = await enrolment(seq.id, ray);
            const stop = await as(admin)
                .post(w(`/enrolments/${e.id}/stop`))
                .send({ note: 'asked us not to' });
            expect(stop.status, JSON.stringify(stop.body)).toBe(200);
            expect(stop.body as EnrolmentView).toMatchObject({ status: 'stopped', stopReason: 'manual' });
            // Enrolling again is a skip, not a re-enrolment.
            expect(((await enrol(seq.id, [ray])).body as EnrolmentBatchResult).skipped).toEqual([ray]);
            const again = await as(admin).post(w(`/enrolments/${e.id}/reenrol`));
            expect(again.status, JSON.stringify(again.body)).toBe(200);
            expect(again.body as EnrolmentView).toMatchObject({ status: 'active', stepIndex: 0, stopReason: null });
            const listed = await as(admin).get(w(`/people/${ray}/enrolments`));
            expect((listed.body as EnrolmentView[]).map((x) => x.id)).toEqual([e.id]);
        });
    });

    describe('D-251 / #142 unknown country: enrolled, flagged, stopped if it turns out blocked', () => {
        it('enrols a person with no known country and flags them in the preview and the enrol', async () => {
            const seq = await sequence([{ kind: 'email', templateId: template }]);
            expect((await activate(seq.id)).status).toBe(200);
            const uma = await person({ emails: { primary: address('uma'), additional: [] } });
            const preview = await as(admin)
                .post(w(`/sequences/${seq.id}/enrolments/preview`))
                .send({ personIds: [uma] });
            expect(preview.status, JSON.stringify(preview.body)).toBe(200);
            const flag = { personId: uma, code: 'region.unknown' };
            expect(preview.body).toMatchObject({ enrolled: [uma], warnings: [flag] });
            const res = await enrol(seq.id, [uma]);
            expect(res.body).toMatchObject({ enrolled: [uma], warnings: [flag] });
            const listed = (await as(admin).get(w(`/people/${uma}/enrolments`))).body as Record<string, unknown>[];
            expect(listed[0]).toMatchObject({ countryUnknownAtEnrol: true });
        });

        it('stops the enrolment when the person’s country is later set to a blocked region', async () => {
            const seq = await sequence([
                { kind: 'wait', waitDays: 1, businessDays: false },
                { kind: 'email', templateId: template },
            ]);
            expect((await activate(seq.id)).status).toBe(200);
            const vic = await person({ emails: { primary: address('vic'), additional: [] } });
            await enrol(seq.id, [vic]);
            const patched = await as(admin)
                .patch(w(`/people/${vic}`))
                .send({ country: 'DE' });
            expect(patched.status, JSON.stringify(patched.body)).toBe(200);
            await settle(app);
            expect(await enrolment(seq.id, vic)).toMatchObject({ status: 'stopped', stopReason: 'region_blocked' });
        });

        it('the check before every step stops it too, even if the update’s event never arrived', async () => {
            const seq = await sequence([{ kind: 'email', templateId: template }]);
            expect((await activate(seq.id)).status).toBe(200);
            const wes = await person({ emails: { primary: address('wes'), additional: [] } });
            await enrol(seq.id, [wes]);
            await owner.person.update({ where: { id: wes }, data: { country: 'FR' } });
            await runner.run(workspace, (await enrolment(seq.id, wes)).id, new Date());
            expect(await enrolment(seq.id, wes)).toMatchObject({ status: 'stopped', stopReason: 'region_blocked' });
        });
    });

    describe('#144 a step’s send belongs to the member who enrolled the person', () => {
        let enroller: Browser;
        let bystander: Browser;
        let enrollerMemberId: string;
        let poolOwnerMemberId: string;

        beforeAll(async () => {
            const role = await as(admin)
                .post(w('/roles'))
                .send({
                    name: `enroller ${stamp}`,
                    capabilities: ['record:read', 'record:write', 'sequence:enrol', 'email:send'],
                    recordScope: 'all',
                })
                .expect(201);
            const roleId = (role.body as { id: string }).id;
            const join = async (email: string) => {
                const invite = await as(admin).post(w('/invites')).send({ email, roleId });
                expect(invite.status, JSON.stringify(invite.body)).toBe(201);
                const joined = await http()
                    .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                    .send({ password });
                expect(joined.status, JSON.stringify(joined.body)).toBe(201);
                await verifyAddress(app, http, email);
                return browserFrom(joined);
            };
            const enrollerEmail = `seq-enroller-${stamp}@example.com`;
            enroller = await join(enrollerEmail);
            bystander = await join(`seq-bystander-${stamp}@example.com`);
            enrollerMemberId = (
                await owner.workspaceMember.findFirstOrThrow({
                    where: { workspaceId: workspace, user: { email: enrollerEmail } },
                })
            ).id;
            poolOwnerMemberId = (await owner.mailbox.findUniqueOrThrow({ where: { id: poolMailbox } })).ownerMemberId;
        });

        it('records the enroller on the enrolment and as the send’s sender, from the pool mailbox', async () => {
            const seq = await sequence([{ kind: 'email', templateId: template }]);
            expect((await activate(seq.id)).status).toBe(200);
            const ivy = await person({ nameFirst: 'Ivy', emails: { primary: address('ivy'), additional: [] } });
            const res = await enrol(seq.id, [ivy], enroller);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const e = await enrolment(seq.id, ivy);
            const listed = (await as(enroller).get(w(`/people/${ivy}/enrolments`))).body as Record<string, unknown>[];
            expect(listed.find((x) => x.id === e.id)).toMatchObject({ enrolledByMemberId: enrollerMemberId });

            await runner.run(workspace, e.id, new Date());
            const out = await owner.mailOutbound.findUniqueOrThrow({
                where: { id: (await enrolment(seq.id, ivy)).waitingOutboundId! },
            });
            expect(enrollerMemberId).not.toBe(poolOwnerMemberId);
            expect(out).toMatchObject({ mailboxId: poolMailbox, senderMemberId: enrollerMemberId });
        });

        it('lets the enroller reschedule and cancel it, refuses a colleague who did not enrol (403), and an admin may', async () => {
            const seq = await sequence([{ kind: 'email', templateId: template }]);
            expect((await activate(seq.id)).status).toBe(200);
            const later = () => new Date(Date.now() + 6 * 3600_000).toISOString();
            const ids: string[] = [];
            for (const name of ['jo', 'kai']) {
                const p = await person({ emails: { primary: address(name), additional: [] } });
                await enrol(seq.id, [p], enroller);
                const e = await enrolment(seq.id, p);
                await runner.run(workspace, e.id, new Date());
                ids.push((await enrolment(seq.id, p)).waitingOutboundId!);
            }
            const [first, second] = ids as [string, string];

            const byBystander = await as(bystander).post(w(`/mail/messages/${first}/cancel`));
            expect(byBystander.status, JSON.stringify(byBystander.body)).toBe(403);
            const moved = await as(enroller)
                .patch(w(`/mail/messages/${first}`))
                .send({ sendAt: later() });
            expect(moved.status, JSON.stringify(moved.body)).toBe(200);
            expect((await as(enroller).post(w(`/mail/messages/${first}/cancel`))).status).toBe(200);
            expect((await as(admin).post(w(`/mail/messages/${second}/cancel`))).status).toBe(200);
        });
    });

    describe('#136 task step (doc 50 §D: "Call if no reply → owner")', () => {
        it('creates a task on the person for their owner, due now, then moves straight on', async () => {
            const seq = await sequence([
                { kind: 'task', taskTitle: 'Call if no reply' },
                { kind: 'email', templateId: template },
            ]);
            expect((await activate(seq.id)).status).toBe(200);
            const xan = await person({ emails: { primary: address('xan'), additional: [] } });
            const ownerId = (await owner.person.findUniqueOrThrow({ where: { id: xan } })).ownerId;
            expect(ownerId).not.toBeNull();
            await enrol(seq.id, [xan]);
            const before = Date.now();
            await runner.run(workspace, (await enrolment(seq.id, xan)).id, new Date());

            const tasks = await owner.task.findMany({
                where: { targets: { some: { targetType: 'person', targetId: xan } } },
            });
            expect(tasks).toHaveLength(1);
            expect(tasks[0]).toMatchObject({ title: 'Call if no reply', assigneeId: ownerId, status: 'todo' });
            expect(tasks[0]!.dueAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
            const e = await enrolment(seq.id, xan);
            expect(e).toMatchObject({ status: 'active', stepIndex: 1 });
            expect(e.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
            // Run again on the same step's job: no second task.
            await runner.run(workspace, e.id, new Date());
            expect(
                await owner.task.count({ where: { targets: { some: { targetType: 'person', targetId: xan } } } }),
            ).toBe(1);

            // #158: the enrolment view carries the step's task — which step, its title, its state — so a
            // record's sequences card can show it; completing the task shows there, and drives nothing.
            const listed = (await as(admin).get(w(`/people/${xan}/enrolments`))).body as EnrolmentView[];
            const mine = listed.find((x) => x.id === e.id)!;
            expect(mine.tasks).toEqual([
                {
                    id: tasks[0]!.id,
                    stepId: seq.steps[0]!.id,
                    title: 'Call if no reply',
                    status: 'todo',
                    dueAt: tasks[0]!.dueAt!.toISOString(),
                    completedAt: null,
                    assigneeId: ownerId,
                },
            ]);
            await as(admin)
                .patch(w(`/tasks/${tasks[0]!.id}`))
                .send({ status: 'done' })
                .expect(200);
            const after = ((await as(admin).get(w(`/people/${xan}/enrolments`))).body as EnrolmentView[]).find(
                (x) => x.id === e.id,
            )!;
            expect(after.tasks[0]).toMatchObject({ status: 'done', completedAt: expect.any(String) });
            expect(after).toMatchObject({ status: 'active', stepIndex: 1 });
            // The other workspace reads none of it.
            expect((await as(otherAdmin).get(w(`/people/${xan}/enrolments`, otherWorkspace))).status).toBe(404);
        });

        it('assigns the task to the member who enrolled the person when the person has no owner', async () => {
            const seq = await sequence([
                { kind: 'task', taskTitle: 'Research the agency' },
                { kind: 'email', templateId: template },
            ]);
            expect((await activate(seq.id)).status).toBe(200);
            const yan = await person({ emails: { primary: address('yan'), additional: [] } });
            await owner.person.update({ where: { id: yan }, data: { ownerId: null } });
            await enrol(seq.id, [yan]);
            const e = await enrolment(seq.id, yan);
            await runner.run(workspace, e.id, new Date());
            const task = await owner.task.findFirstOrThrow({
                where: { targets: { some: { targetType: 'person', targetId: yan } } },
            });
            expect(task.assigneeId).toBe(e.enrolledByMemberId);
        });

        it('refuses a task step without a title', async () => {
            const created = await as(admin)
                .post(w('/sequences'))
                .send({ name: `No title ${stamp}`, timeZone: 'UTC' });
            const put = await as(admin)
                .put(w(`/sequences/${(created.body as { id: string }).id}/steps`))
                .send({ steps: [{ kind: 'task' }] });
            expect(put.status).toBe(400);
        });
    });

    describe('cross-tenant', () => {
        it('another workspace cannot see a sequence, enrol into it, or enrol a person from elsewhere', async () => {
            const seq = await sequence([{ kind: 'email', templateId: template }]);
            expect((await as(otherAdmin).get(w(`/sequences/${seq.id}`, otherWorkspace))).status).toBe(404);
            const theirs = await person(
                { emails: { primary: address('theirs'), additional: [] } },
                otherAdmin,
                otherWorkspace,
            );
            expect((await enrol(seq.id, [theirs], otherAdmin, otherWorkspace)).status).toBe(404);
            // A person id from the other workspace is refused as not found, never enrolled.
            expect((await activate(seq.id)).status).toBe(200);
            const res = (await enrol(seq.id, [theirs])).body as EnrolmentBatchResult;
            expect(res.refused).toEqual([{ personId: theirs, code: 'person.not_found', message: expect.any(String) }]);
            const list = await as(otherAdmin).get(w('/sequences', otherWorkspace));
            expect((list.body as SequenceView[]).map((s) => s.id)).not.toContain(seq.id);
        });
    });
});
