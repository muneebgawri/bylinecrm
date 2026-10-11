import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, GMAIL_SCOPES, SESSION_COOKIE, SYSTEM_ROLES, type RichText } from '@bylinecrm/shared';
import type { Queue } from 'bullmq';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MAIL_SEND_QUEUE } from '../../src/mail-send/mail-send.constants';
import { MailSendService } from '../../src/mail-send/mail-send.service';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { MailSyncService } from '../../src/mail-sync/mail-sync.service';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';

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

interface Outbound {
    id: string;
    mailboxId: string;
    status: 'queued' | 'sending' | 'sent' | 'failed';
    subject: string;
    to: string[];
    sentAt: string | null;
    mailMessageId: string | null;
    threadId: string | null;
    error: { code: string; message: string } | null;
}
interface BusEvent {
    type: string;
    workspaceId: string;
    recordId: string;
    related?: { type: string; id: string }[];
    email?: { messageId: string; direction: string; rfc822MessageId: string | null };
    reply?: {
        messageId: string;
        inReplyToOutboundId: string;
        inReplyToMessageId: string | null;
        threadId: string;
        personIds: string[];
        dealIds: string[];
    };
}
interface Stage {
    id: string;
    name: string;
}
interface ApiError {
    code: string;
    message: string;
    fieldErrors?: { path: string; message: string }[];
}

const body = (...content: object[]): RichText => ({ type: 'doc', content }) as RichText;
const para = (...content: object[]) => ({ type: 'paragraph', content });
const v = (path: string) => ({ type: 'variable', attrs: { path } });
const t = (text: string) => ({ type: 'text', text });
const header = (raw: string, name: string): string | undefined =>
    raw
        .split('\r\n\r\n')[0]!
        .replace(/\r\n[ \t]+/g, ' ')
        .split('\r\n')
        .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
        ?.slice(name.length + 1)
        .trim();

/**
 * Sending (P2-3, FR-CRMS-2/3/9) end to end against an in-memory Gmail and Google: a member sends
 * from their own connected personal mailbox — free-form or from a template — through a queued job;
 * the message is built as RFC 5322 MIME with our Message-ID, threaded when it is a reply, stored
 * once through sync's writer and announced once. A reply that comes back — by its In-Reply-To or in
 * the same Gmail thread — is announced once as `email.replied`, which moves the deal by its stage
 * rule. One workspace can never send from, reply to, or read the status of another's mail.
 */
describe('mail send and reply detection', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let send: MailSendService;
    let sync: MailSyncService;
    let queue: Queue;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;

    const adminEmail = `send-admin-${stamp}@example.com`;
    const memberEmail = `send-member-${stamp}@example.com`;
    const otherEmail = `send-other-${stamp}@example.com`;
    const poolEmail = `send-pool-${stamp}@example.com`;
    const dana = `dana-${stamp}@acme.example`;
    const loner = `loner-${stamp}@nowhere.example`;

    let adminMailbox: string;
    let memberMailbox: string;
    let poolMailbox: string;
    let otherMailbox: string;
    let danaId: string;
    let lonerId: string;
    let acmeId: string;
    let dealId: string;
    let stages: Stage[];
    let webhookEndpoint: string;

    const events: BusEvent[] = [];

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const noWait = { sleep: () => Promise.resolve() };
    const stage = (name: string) => stages.find((s) => s.name === name)!;
    const err = (res: Response) => res.body as ApiError;

    async function connect(who: Browser, ws: string, purpose: 'personal' | 'pool', email: string): Promise<string> {
        const start = await as(who).post(w('/mailboxes/connect', ws)).send({ purpose });
        expect(start.status).toBe(201);
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email,
            scopes: [...GMAIL_SCOPES],
        });
        const callback = await as(who).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        expect(new URL(String(callback.headers['location'])).searchParams.get('connect')).toBe('connected');
        const list = await as(who).get(w('/mailboxes', ws));
        return (list.body as { id: string; email: string }[]).find((m) => m.email === email)!.id;
    }

    async function status(id: string, who: Browser = admin, ws = workspace): Promise<Response> {
        return as(who).get(w(`/mail/messages/${id}`, ws));
    }

    /** Sends and delivers: the request is queued, then the job's work is done here, deterministically. */
    async function sendAndDeliver(payload: Record<string, unknown>, who: Browser = admin): Promise<Outbound> {
        const res = await as(who).post(w('/mail/send')).send(payload);
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        const { messageId } = res.body as { messageId: string; status: string };
        await send.deliver(workspace, messageId, noWait);
        return (await status(messageId, who)).body as Outbound;
    }

    const ofType = (type: string, recordId?: string) =>
        events.filter((e) => e.type === type && (recordId === undefined || e.recordId === recordId));

    async function deliveries(eventName: string): Promise<number> {
        return owner.webhookDelivery.count({ where: { endpointId: webhookEndpoint, eventName } });
    }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        send = app.get(MailSendService);
        sync = app.get(MailSyncService);
        queue = app.get<Queue>(getQueueToken(MAIL_SEND_QUEUE));
        app.get(EventEmitter2).onAny((type: string | string[], payload: unknown) => {
            if (typeof type === 'string' && type.startsWith('email.')) events.push(payload as BusEvent);
        });

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Send ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other send ${stamp}`));

        const roles = await as(admin).get(w('/roles'));
        const memberRoleId = (roles.body as { id: string; name: string }[]).find(
            (r) => r.name === SYSTEM_ROLES.member,
        )!.id;
        const invite = await as(admin).post(w('/invites')).send({ email: memberEmail, roleId: memberRoleId });
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password });
        expect(joined.status).toBe(201);
        member = browserFrom(joined);

        for (const [who, ws, tag] of [
            [admin, workspace, 'a'],
            [otherAdmin, otherWorkspace, 'b'],
        ] as const) {
            const clientId = `333-${tag}${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
            const secret = `GOCSPX-send-${tag}-${stamp}`;
            const view = await as(who).get(w('/mail/oauth-client', ws));
            google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
            const put = await http()
                .put(w('/mail/oauth-client', ws))
                .set('Cookie', who.cookie)
                .set(CSRF_HEADER, who.csrf)
                .send({ clientId, clientSecret: secret });
            expect(put.status).toBe(200);
        }
        adminMailbox = await connect(admin, workspace, 'personal', adminEmail);
        memberMailbox = await connect(member, workspace, 'personal', memberEmail);
        poolMailbox = await connect(admin, workspace, 'pool', poolEmail);
        otherMailbox = await connect(otherAdmin, otherWorkspace, 'personal', otherEmail);

        acmeId = (
            (
                await as(admin)
                    .post(w('/companies'))
                    .send({ name: `Acme ${stamp}` })
            ).body as { id: string }
        ).id;
        danaId = (
            (
                await as(admin)
                    .post(w('/people'))
                    .send({
                        nameFirst: 'Dana',
                        nameLast: 'Reyes',
                        emails: { primary: dana, additional: [] },
                        companyId: acmeId,
                    })
            ).body as { id: string }
        ).id;
        lonerId = (
            (
                await as(admin)
                    .post(w('/people'))
                    .send({ nameFirst: 'Lee', nameLast: 'Loner', emails: { primary: loner, additional: [] } })
            ).body as { id: string }
        ).id;
        const deal = await as(admin)
            .post(w('/opportunities'))
            .send({ name: `Series B ${stamp}`, companyId: acmeId, pointOfContactId: danaId });
        expect(deal.status).toBe(201);
        dealId = (deal.body as { id: string }).id;

        const pipeline = ((await as(admin).get(w('/pipelines'))).body as { id: string; stages: Stage[] }[])[0]!;
        stages = pipeline.stages;
        await as(admin)
            .post(w(`/pipelines/${pipeline.id}/rules`))
            .send({ event: 'email.replied', toStageId: stage('Replied').id })
            .expect(201);

        const endpoint = await as(admin)
            .post(w('/webhooks'))
            .send({ url: 'http://127.0.0.1:9/mail-send-hook', events: ['*'] });
        expect(endpoint.status).toBe(201);
        webhookEndpoint =
            (endpoint.body as { endpoint?: { id: string }; id?: string }).endpoint?.id ??
            (endpoint.body as { id: string }).id;
    });

    afterAll(async () => {
        if (webhookEndpoint) await as(admin).delete(w(`/webhooks/${webhookEndpoint}`));
        await app?.close();
    });

    describe('FR-CRMS-2 sending from the caller’s personal mailbox', () => {
        let sent: Outbound;
        let raw: string;

        beforeAll(async () => {
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({
                    mailboxId: adminMailbox,
                    personId: danaId,
                    subject: 'Distribution for {{company.name}}',
                    body: body(para(t('Hi '), v('person.firstName'), t(', the list is attached.'))),
                });
            expect(res.status, JSON.stringify(res.body)).toBe(202);
            const queued = res.body as { messageId: string; status: string };
            expect(queued.status).toBe('queued');
            const job = await queue.getJob(queued.messageId);
            expect(job?.data).toMatchObject({ workspaceId: workspace, messageId: queued.messageId });
            expect(((await status(queued.messageId)).body as Outbound).status).toBe('queued');
            await send.deliver(workspace, queued.messageId, noWait);
            sent = (await status(queued.messageId)).body as Outbound;
            raw = gmail.sent.at(-1)!.raw;
        });

        it('is queued, then sent through Gmail as RFC 5322 MIME with our Message-ID', () => {
            expect(sent).toMatchObject({ status: 'sent', mailboxId: adminMailbox, to: [dana], error: null });
            expect(sent.sentAt).not.toBeNull();
            expect(gmail.sent.at(-1)!.email).toBe(adminEmail);
            expect(header(raw, 'From')).toContain(`<${adminEmail}>`);
            expect(header(raw, 'To')).toContain(dana);
            expect(header(raw, 'Subject')).toBe(`Distribution for Acme ${stamp}`);
            expect(header(raw, 'Message-ID')).toMatch(/^<[0-9a-f-]{36}@bylinecrm>$/);
        });

        it('renders the body through the template serializer (variables filled, HTML and text)', () => {
            const html = Buffer.from(
                raw
                    .split(/--[^\r\n]+\r\nContent-Type: text\/html[^\r\n]*\r\n[^\r\n]*\r\n\r\n/)[1]!
                    .split('\r\n--')[0]!
                    .replace(/\r\n/g, ''),
                'base64',
            ).toString('utf8');
            expect(html).toContain('<p>Hi Dana, the list is attached.</p>');
        });

        it('is stored once through sync’s writer, on the person’s thread list, and announced once as email.sent', async () => {
            expect(sent.mailMessageId).not.toBeNull();
            expect(sent.threadId).not.toBeNull();
            const threads = await as(admin).get(w(`/mail/threads?target=person:${danaId}`));
            expect((threads.body as { items: { id: string }[] }).items.map((x) => x.id)).toContain(sent.threadId);
            expect(ofType('email.sent', sent.mailMessageId!)).toHaveLength(1);
            const timeline = await as(admin).get(w(`/timeline?target=person:${danaId}&kinds=linked-email`));
            const kinds = (timeline.body as { items: { kind: string; linked: { id: string } | null }[] }).items
                .filter((i) => i.linked?.id === sent.mailMessageId)
                .map((i) => i.kind);
            expect(kinds).toEqual(['linked-email.sent']);
        });

        it('is not stored or announced again when sync later sees the same Gmail message', async () => {
            const result = await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(result.imported).toBe(0);
            const rows = await owner.mailMessage.count({
                where: { mailboxId: adminMailbox, providerMessageId: gmail.sent.at(-1)!.id },
            });
            expect(rows).toBe(1);
            expect(ofType('email.sent', sent.mailMessageId!)).toHaveLength(1);
        });

        it('delivering the same job again sends nothing (one job, one message)', async () => {
            const before = gmail.callsOf('send', adminEmail);
            await send.deliver(workspace, sent.id, noWait);
            expect(gmail.callsOf('send', adminEmail)).toBe(before);
        });

        it('defaults the recipient to the person’s primary address', () => {
            expect(sent.to).toEqual([dana]);
        });
    });

    describe('FR-CRMS-3 templates', () => {
        let personal: string;
        let missingCompany: string;
        let outreach: string;

        beforeAll(async () => {
            const mk = async (name: string, kind: string, subject: string, doc: RichText) =>
                (
                    (await as(admin).post(w('/templates')).send({ name, kind, subject, body: doc }).expect(201))
                        .body as { id: string }
                ).id;
            personal = await mk('Intro', 'personal', 'Hello {{person.firstName}}', body(para(t('From Kate'))));
            missingCompany = await mk(
                'Needs company',
                'personal',
                'For {{company.name}}',
                body(para(t('About '), v('company.name'))),
            );
            outreach = await mk('Cold', 'outreach', 'Cold {{person.firstName}}', body(para(t('Hello'))));
        });

        it('renders a sendable template and sends it', async () => {
            const out = await sendAndDeliver({ mailboxId: adminMailbox, personId: danaId, templateId: personal });
            expect(out.status).toBe('sent');
            expect(header(gmail.sent.at(-1)!.raw, 'Subject')).toBe('Hello Dana');
        });

        it('refuses a render with empty variables, naming them — nothing is queued or sent', async () => {
            const before = gmail.sent.length;
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({ mailboxId: adminMailbox, personId: lonerId, templateId: missingCompany });
            expect(res.status).toBe(422);
            expect(err(res).code).toBe('unprocessable');
            expect(err(res).fieldErrors?.map((f) => f.path)).toEqual(['company.name']);
            expect(gmail.sent.length).toBe(before);
        });

        it('refuses an outreach template: sequences send those (Phase 3)', async () => {
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({ mailboxId: adminMailbox, personId: danaId, templateId: outreach });
            expect(res.status).toBe(422);
            expect(err(res).code).toBe('unprocessable');
        });

        it('refuses a free-form body outside the template subset, like a template would be', async () => {
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({
                    mailboxId: adminMailbox,
                    personId: danaId,
                    subject: 'x',
                    body: body({ type: 'image', attrs: { src: 'https://t.example/p.gif' } }),
                });
            expect(res.status).toBe(400);
            expect(err(res).code).toBe('validation.failed');
        });

        it('needs exactly one of a template or a subject and body', async () => {
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({ mailboxId: adminMailbox, personId: danaId, templateId: personal, subject: 'x' });
            expect(res.status).toBe(400);
        });
    });

    describe('FR-CRMS-2 which mailbox may send', () => {
        const free = (mailboxId: string) => ({ mailboxId, personId: danaId, subject: 's', body: body(para(t('b'))) });

        it('refuses a pool mailbox: pool mail goes out through sequences', async () => {
            const res = await as(admin).post(w('/mail/send')).send(free(poolMailbox));
            expect(res.status).toBe(403);
            expect(err(res).message).toMatch(/pool/);
        });

        it('refuses another member’s personal mailbox, even for an admin', async () => {
            const res = await as(admin).post(w('/mail/send')).send(free(memberMailbox));
            expect(res.status).toBe(403);
        });

        it('lets the member send from their own', async () => {
            const res = await as(member).post(w('/mail/send')).send(free(memberMailbox));
            expect(res.status).toBe(202);
        });

        it('refuses a mailbox that is not connected', async () => {
            await owner.mailbox.update({ where: { id: memberMailbox }, data: { status: 'reconnect_needed' } });
            try {
                const res = await as(member).post(w('/mail/send')).send(free(memberMailbox));
                expect(res.status).toBe(409);
                expect(err(res).code).toBe('conflict');
            } finally {
                await owner.mailbox.update({ where: { id: memberMailbox }, data: { status: 'connected' } });
            }
        });
    });

    describe('FR-CRMS-2 delivery: retries, exhaustion, a lost answer, a dead mailbox', () => {
        const free = () => ({ mailboxId: adminMailbox, personId: danaId, subject: 'r', body: body(para(t('b'))) });

        it('retries a throttled send with backoff and sends once', async () => {
            gmail.failNext(adminEmail, 'send', 429, 2);
            const before = gmail.sent.length;
            const out = await sendAndDeliver(free());
            expect(out.status).toBe('sent');
            expect(gmail.sent.length).toBe(before + 1);
        });

        it('leaves the message sending and throws on a persistent server error, so the queue retries it', async () => {
            const res = await as(admin).post(w('/mail/send')).send(free());
            const id = (res.body as { messageId: string }).messageId;
            gmail.failNext(adminEmail, 'send', 503, 5);
            await expect(send.deliver(workspace, id, noWait)).rejects.toBeDefined();
            const mid = (await status(id)).body as Outbound;
            expect(mid.status).toBe('sending');
            expect(mid.error?.code).toBe('gmail.backendError');
            gmail.clearFailures();
            await send.deliver(workspace, id, noWait);
            expect(((await status(id)).body as Outbound).status).toBe('sent');
        });

        it('marks it failed when the queue’s attempts are spent', async () => {
            const res = await as(admin).post(w('/mail/send')).send(free());
            const id = (res.body as { messageId: string }).messageId;
            await send.markExhausted(workspace, id, 'gmail.backendError');
            expect(((await status(id)).body as Outbound).status).toBe('failed');
            const before = gmail.sent.length;
            await send.deliver(workspace, id, noWait);
            expect(gmail.sent.length).toBe(before);
        });

        it('does not send twice when Gmail accepted the message but its answer was lost', async () => {
            const res = await as(admin).post(w('/mail/send')).send(free());
            const id = (res.body as { messageId: string }).messageId;
            gmail.acceptNextSendThenFail(adminEmail);
            const before = gmail.sent.length;
            await send.deliver(workspace, id, noWait);
            expect(gmail.sent.length).toBe(before + 1);
            const out = (await status(id)).body as Outbound;
            expect(out.status).toBe('sent');
            expect(out.mailMessageId).not.toBeNull();
        });

        it('fails fast, without calling Gmail, when the mailbox needs reconnecting', async () => {
            const res = await as(admin).post(w('/mail/send')).send(free());
            const id = (res.body as { messageId: string }).messageId;
            await owner.mailbox.update({ where: { id: adminMailbox }, data: { status: 'reconnect_needed' } });
            try {
                const before = gmail.callsOf('send', adminEmail);
                await send.deliver(workspace, id, noWait);
                expect(gmail.callsOf('send', adminEmail)).toBe(before);
                const out = (await status(id)).body as Outbound;
                expect(out).toMatchObject({ status: 'failed', error: { code: 'reconnect_needed' } });
            } finally {
                await owner.mailbox.update({ where: { id: adminMailbox }, data: { status: 'connected' } });
            }
        });
    });

    describe('FR-CRMS-2 replies thread, and FR-CRMS-9 a reply moves the deal', () => {
        let ours: Outbound;
        let ourMessageId: string;

        beforeAll(async () => {
            // Dana writes first; Kate replies from the CRM.
            gmail.deliver(adminEmail, {
                from: `"Dana Reyes" <${dana}>`,
                to: [adminEmail],
                subject: 'Can you send pricing?',
                text: 'Please send pricing.',
                messageIdHeader: `ask-${stamp}@acme.example`,
            });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            const parent = await owner.mailMessage.findFirstOrThrow({
                where: { mailboxId: adminMailbox, rfc822MessageId: `ask-${stamp}@acme.example` },
            });
            ours = await sendAndDeliver({
                mailboxId: adminMailbox,
                personId: danaId,
                dealId,
                replyToMessageId: parent.id,
                body: body(para(t('Pricing attached.'))),
            });
            ourMessageId = header(gmail.sent.at(-1)!.raw, 'Message-ID')!.slice(1, -1);
        });

        it('sends the reply in the parent’s Gmail thread with In-Reply-To and References', async () => {
            const last = gmail.sent.at(-1)!;
            const parent = await owner.mailMessage.findFirstOrThrow({
                where: { mailboxId: adminMailbox, rfc822MessageId: `ask-${stamp}@acme.example` },
                include: { thread: true },
            });
            expect(last.threadId).toBe(parent.thread.providerThreadId);
            expect(header(last.raw, 'In-Reply-To')).toBe(`<ask-${stamp}@acme.example>`);
            expect(header(last.raw, 'References')).toBe(`<ask-${stamp}@acme.example>`);
            expect(header(last.raw, 'Subject')).toBe('Re: Can you send pricing?');
            expect(ours.threadId).toBe(parent.threadId);
        });

        it('announces a reply that names our Message-ID exactly once, and the rule moves the deal', async () => {
            gmail.deliver(adminEmail, {
                from: dana,
                to: [adminEmail],
                subject: 'Re: Can you send pricing?',
                text: 'Thanks — let us talk.',
                inReplyTo: ourMessageId,
            });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            const replied = ofType('email.replied');
            expect(replied).toHaveLength(1);
            expect(replied[0]).toMatchObject({
                workspaceId: workspace,
                reply: {
                    inReplyToOutboundId: ours.id,
                    inReplyToMessageId: ours.mailMessageId,
                    personIds: [danaId],
                    dealIds: [dealId],
                },
            });
            expect(replied[0]!.related).toEqual(
                expect.arrayContaining([
                    { type: 'person', id: danaId },
                    { type: 'company', id: acmeId },
                ]),
            );
            const deal = await eventually(
                async () => ((await as(admin).get(w(`/opportunities/${dealId}`))).body as { stageId: string }).stageId,
                (id) => id === stage('Replied').id,
            );
            expect(deal).toBe(stage('Replied').id);
            const history = (await as(admin).get(w(`/opportunities/${dealId}/history`))).body as {
                reason: string;
                actor: { kind: string };
            }[];
            expect(history[0]).toMatchObject({ reason: 'rule', actor: { kind: 'rule' } });
            expect(
                await eventually(
                    () => deliveries('email.replied'),
                    (n) => n === 1,
                ),
            ).toBe(1);
        });

        it('never announces the same reply twice', async () => {
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(ofType('email.replied')).toHaveLength(1);
        });

        it('recognises a reply in the same Gmail thread without In-Reply-To', async () => {
            const { providerThreadId } = await owner.mailOutbound.findUniqueOrThrow({ where: { id: ours.id } });
            expect(providerThreadId).not.toBeNull();
            gmail.deliver(adminEmail, {
                from: dana,
                to: [adminEmail],
                subject: 'one more thing',
                text: 'Also, the deck.',
                threadId: providerThreadId!,
            });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(ofType('email.replied')).toHaveLength(2);
        });

        it('does not take unrelated inbound mail for a reply', async () => {
            gmail.deliver(adminEmail, { from: dana, to: [adminEmail], subject: 'Unrelated', text: 'Hello again' });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(ofType('email.replied')).toHaveLength(2);
        });

        it('refuses a reply to a message that is not in the sending mailbox', async () => {
            gmail.deliver(memberEmail, { from: dana, to: [memberEmail], subject: 'To the member', text: 'hi' });
            await sync.syncMailbox(workspace, memberMailbox, noWait);
            const foreign = await owner.mailMessage.findFirstOrThrow({ where: { mailboxId: memberMailbox } });
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({
                    mailboxId: adminMailbox,
                    personId: danaId,
                    replyToMessageId: foreign.id,
                    body: body(para(t('x'))),
                });
            expect(res.status).toBe(400);
            expect(err(res).fieldErrors?.map((f) => f.path)).toEqual(['replyToMessageId']);
        });
    });

    describe('FR-CRMS-2 Gmail rewrites our Message-ID (real-Gmail finding, #87)', () => {
        // Against real Gmail (2026-10-11) a message sent with Message-ID <uuid@bylinecrm> was stored
        // and delivered as <…@mail.gmail.com>. Our own X-BylineCRM-Id header survives; the send is
        // found by it after a lost answer, and replies are matched by Gmail's Message-ID too.
        const rae = `rae-${stamp}@acme.example`;
        let raeId: string;

        const freeToRae = (subject = 'Rewrite check') => ({
            mailboxId: adminMailbox,
            personId: raeId,
            subject,
            body: body(para(t('Hello from the CRM.'))),
        });
        const sentBy = (email: string) => gmail.sent.filter((s) => s.email === email).length;
        const repliesTo = (outboundId: string) =>
            events.filter((e) => e.type === 'email.replied' && e.reply?.inReplyToOutboundId === outboundId);

        beforeAll(async () => {
            gmail.rewriteSentMessageIds = true;
            const created = await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Rae', nameLast: 'Okafor', emails: { primary: rae, additional: [] } });
            expect(created.status).toBe(201);
            raeId = (created.body as { id: string }).id;
        });

        afterAll(() => {
            gmail.rewriteSentMessageIds = false;
        });

        it('stamps X-BylineCRM-Id on every send and records Gmail’s own Message-ID on the send', async () => {
            const out = await sendAndDeliver(freeToRae());
            expect(out.status).toBe('sent');
            const raw = gmail.sent.at(-1)!.raw;
            expect(header(raw, 'X-BylineCRM-Id')).toBe(out.id);
            const row = await owner.mailOutbound.findUniqueOrThrow({ where: { id: out.id } });
            const copy = await owner.mailMessage.findFirstOrThrow({
                where: { mailboxId: adminMailbox, providerMessageId: row.providerMessageId! },
            });
            expect(copy.rfc822MessageId).toMatch(/@mail\.gmail\.com$/);
            expect(copy.rfc822MessageId).not.toBe(row.rfc822MessageId);
            expect((row as unknown as { providerRfc822MessageId: string | null }).providerRfc822MessageId).toBe(
                copy.rfc822MessageId,
            );
        });

        it('does not store the sent copy twice when sync sees it under Gmail’s Message-ID', async () => {
            const out = await sendAndDeliver(freeToRae('Rewrite, then sync'));
            const row = await owner.mailOutbound.findUniqueOrThrow({ where: { id: out.id } });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(
                await owner.mailMessage.count({
                    where: { mailboxId: adminMailbox, providerMessageId: row.providerMessageId! },
                }),
            ).toBe(1);
            expect(out.mailMessageId).not.toBeNull();
        });

        it('finds a send Gmail accepted but never answered by our header, and never sends it twice', async () => {
            const res = await as(admin).post(w('/mail/send')).send(freeToRae('Lost answer under rewrite'));
            const id = (res.body as { messageId: string }).messageId;
            gmail.acceptNextSendThenFail(adminEmail);
            const before = sentBy(adminEmail);
            const outcome = await send.deliver(workspace, id, noWait);
            expect(sentBy(adminEmail)).toBe(before + 1);
            expect(outcome).toBe('already_sent');
            const out = (await status(id)).body as Outbound;
            expect(out.status).toBe('sent');
            expect(out.mailMessageId).not.toBeNull();
        });

        it('sends once when the lost attempt never reached Gmail (no sent message carries our header)', async () => {
            const res = await as(admin).post(w('/mail/send')).send(freeToRae('Never reached Gmail'));
            const id = (res.body as { messageId: string }).messageId;
            gmail.failNext(adminEmail, 'send', 500, 1);
            const before = sentBy(adminEmail);
            const outcome = await send.deliver(workspace, id, noWait);
            expect(outcome).toBe('sent');
            expect(sentBy(adminEmail)).toBe(before + 1);
            expect(((await status(id)).body as Outbound).status).toBe('sent');
        });

        it('detects a reply naming Gmail’s rewritten Message-ID exactly once', async () => {
            const out = await sendAndDeliver(freeToRae('Reply by rewritten id'));
            const row = await owner.mailOutbound.findUniqueOrThrow({ where: { id: out.id } });
            const copy = await owner.mailMessage.findFirstOrThrow({
                where: { mailboxId: adminMailbox, providerMessageId: row.providerMessageId! },
            });
            gmail.deliver(adminEmail, {
                from: rae,
                to: [adminEmail],
                subject: 'Re: Reply by rewritten id',
                text: 'Got it.',
                inReplyTo: copy.rfc822MessageId!,
            });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(repliesTo(out.id)).toHaveLength(1);
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(repliesTo(out.id)).toHaveLength(1);
        });

        it('detects a reply in the same Gmail thread with no In-Reply-To exactly once', async () => {
            const out = await sendAndDeliver(freeToRae('Reply in the thread'));
            const row = await owner.mailOutbound.findUniqueOrThrow({ where: { id: out.id } });
            gmail.deliver(adminEmail, {
                from: rae,
                to: [adminEmail],
                subject: 'about that',
                text: 'One more thing.',
                threadId: row.providerThreadId!,
            });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(repliesTo(out.id)).toHaveLength(1);
        });
    });

    describe('status visibility and isolation', () => {
        let adminOutbound: string;

        beforeAll(async () => {
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({ mailboxId: adminMailbox, personId: danaId, subject: 's', body: body(para(t('b'))) });
            adminOutbound = (res.body as { messageId: string }).messageId;
        });

        it('shows a message’s status to its sender and to an admin, not to another member', async () => {
            expect((await status(adminOutbound)).status).toBe(200);
            expect((await status(adminOutbound, member)).status).toBe(404);
        });

        it('B cannot send from A’s mailbox, reply to A’s message, or read A’s status', async () => {
            const fromA = await as(otherAdmin)
                .post(w('/mail/send', otherWorkspace))
                .send({ mailboxId: adminMailbox, personId: danaId, subject: 's', body: body(para(t('b'))) });
            expect(fromA.status).toBe(404);

            const otherPerson = (
                (
                    await as(otherAdmin)
                        .post(w('/people', otherWorkspace))
                        .send({
                            nameFirst: 'B',
                            nameLast: 'Person',
                            emails: { primary: `b-${stamp}@b.example`, additional: [] },
                        })
                ).body as { id: string }
            ).id;
            const aMessage = await owner.mailMessage.findFirstOrThrow({ where: { mailboxId: adminMailbox } });
            const replyToA = await as(otherAdmin)
                .post(w('/mail/send', otherWorkspace))
                .send({
                    mailboxId: otherMailbox,
                    personId: otherPerson,
                    replyToMessageId: aMessage.id,
                    body: body(para(t('x'))),
                });
            expect(replyToA.status).toBe(404);

            const aPerson = await as(otherAdmin)
                .post(w('/mail/send', otherWorkspace))
                .send({ mailboxId: otherMailbox, personId: danaId, subject: 's', body: body(para(t('b'))) });
            expect(aPerson.status).toBe(404);

            expect((await status(adminOutbound, otherAdmin, otherWorkspace)).status).toBe(404);
        });
    });
});

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (done(value) || Date.now() > deadline) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
