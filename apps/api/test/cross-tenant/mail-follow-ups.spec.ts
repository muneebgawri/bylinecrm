import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_SCOPES,
    MAIL_FOLLOW_UPS_MAX,
    REPUTATION_DEFAULTS,
    SESSION_COOKIE,
    SYSTEM_ROLES,
    type RichText,
} from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MailSendService, SendNotDue } from '../../src/mail-send/mail-send.service';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { MailSyncService } from '../../src/mail-sync/mail-sync.service';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { eventLog, settle, type EventLog } from '../support/outbox';
import { verifyAddress } from '../support/mail';

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
    status: 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
    subject: string;
    sendAt: string | null;
    followsOutboundId: string | null;
    mailMessageId: string | null;
    threadId: string | null;
    error: { code: string; message: string; fields?: string[] } | null;
}
interface Accepted {
    messageId: string;
    status: 'queued' | 'scheduled';
    sendAt: string | null;
    followUps: { messageId: string; sendAt: string }[];
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
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 60 * 60 * 1000;
const header = (raw: string, name: string): string | undefined =>
    raw
        .split('\r\n\r\n')[0]!
        .replace(/\r\n[ \t]+/g, ' ')
        .split('\r\n')
        .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
        ?.slice(name.length + 1)
        .trim();

/**
 * Queued follow-ups end to end against an in-memory Gmail: one request queues an email and follow-ups behind it,
 * stored together; each goes at its time as a reply in the first email's Gmail thread (`In-Reply-To` /
 * `References` naming the one before), and waits while the one before has not gone. The person answering calls
 * the rest off (through the reply event, and at a follow-up's time as the backstop); so does an earlier email
 * failing or being cancelled. Every follow-up passes the recipient guard and the reputation gate at its request
 * and again at its time — and scheduled sends in general are now judged by the gate at their request, for the
 * time they go. Another workspace can see and change none of it.
 */
describe('mail follow-ups', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let send: MailSendService;
    let sync: MailSyncService;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;

    const adminEmail = `fu-admin-${stamp}@example.com`;
    const memberEmail = `fu-member-${stamp}@example.com`;
    const otherEmail = `fu-other-${stamp}@example.com`;
    const dana = `dana-${stamp}@acme.example`;

    let adminMailbox: string;
    let memberMailbox: string;
    let danaId: string;
    let events: EventLog;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const noWait = { sleep: () => Promise.resolve() };
    const err = (res: Response) => res.body as ApiError;

    async function connect(who: Browser, ws: string, email: string): Promise<string> {
        const start = await as(who).post(w('/mailboxes/connect', ws)).send({ purpose: 'personal' });
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

    async function status(id: string, who: Browser = admin, ws = workspace): Promise<Outbound> {
        const res = await as(who).get(w(`/mail/messages/${id}`, ws));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as Outbound;
    }

    async function person(first: string, address: string): Promise<string> {
        const res = await as(admin)
            .post(w('/people'))
            .send({ nameFirst: first, nameLast: 'Test', emails: { primary: address, additional: [] }, ownerId: null });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return (res.body as { id: string }).id;
    }

    /** A first email to `personId` (now, or at `sendAt`) with follow-ups at the given hours from now. */
    function queue(
        followUpHours: number[],
        extra: Record<string, unknown> = {},
        who: Browser = admin,
        to = danaId,
    ): request.Test {
        return as(who)
            .post(w('/mail/send'))
            .send({
                mailboxId: who === member ? memberMailbox : adminMailbox,
                personId: to,
                subject: `Hello ${stamp}`,
                body: body(para(t('Hi '), v('person.firstName'), t('.'))),
                followUps: followUpHours.map((h) => ({
                    sendAt: inMs(h * HOUR),
                    body: body(para(t(`Just checking in (${h}h).`))),
                })),
                ...extra,
            });
    }
    async function accepted(req: request.Test): Promise<Accepted> {
        const res = await req;
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        return res.body as Accepted;
    }
    /** The time a follow-up's job would run: just after its `sendAt`. */
    const dueAt = async (id: string) => new Date((await status(id)).sendAt!).getTime() + 1_000;

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
        events = await eventLog(app, 'email.*');

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Follow-ups ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other follow-ups ${stamp}`));

        const roles = await as(admin).get(w('/roles'));
        const memberRoleId = (roles.body as { id: string; name: string }[]).find(
            (r) => r.name === SYSTEM_ROLES.member,
        )!.id;
        const invite = await as(admin).post(w('/invites')).send({ email: memberEmail, roleId: memberRoleId });
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password });
        expect(joined.status).toBe(201);
        await verifyAddress(app, http, memberEmail);
        member = browserFrom(joined);

        for (const [who, ws, tag] of [
            [admin, workspace, 'a'],
            [otherAdmin, otherWorkspace, 'b'],
        ] as const) {
            const clientId = `555-${tag}${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
            const secret = `GOCSPX-fu-${tag}-${stamp}`;
            const view = await as(who).get(w('/mail/oauth-client', ws));
            google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
            await http()
                .put(w('/mail/oauth-client', ws))
                .set('Cookie', who.cookie)
                .set(CSRF_HEADER, who.csrf)
                .send({ clientId, clientSecret: secret })
                .expect(200);
        }
        adminMailbox = await connect(admin, workspace, adminEmail);
        memberMailbox = await connect(member, workspace, memberEmail);
        danaId = await person('Dana', dana);
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('queueing', () => {
        it('stores the email and its follow-ups together, each following the one before, subject Re: the first', async () => {
            const a = await accepted(queue([24, 48], { sendAt: inMs(HOUR), timeZone: 'Europe/London' }));
            expect(a.status).toBe('scheduled');
            expect(a.followUps).toHaveLength(2);
            const [one, two] = await Promise.all(a.followUps.map((f) => status(f.messageId)));
            expect(one).toMatchObject({
                status: 'scheduled',
                followsOutboundId: a.messageId,
                subject: `Re: Hello ${stamp}`,
            });
            expect(two).toMatchObject({ status: 'scheduled', followsOutboundId: one!.id });
            const scheduled = (await events.read()).filter(
                (e) => e.type === 'email.scheduled' && a.followUps.some((f) => f.messageId === e.recordId),
            );
            expect(scheduled).toHaveLength(2);
        });

        it('keeps a follow-up’s own subject when it has one', async () => {
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({
                    mailboxId: adminMailbox,
                    personId: danaId,
                    subject: `Own ${stamp}`,
                    body: body(para(t('First.'))),
                    followUps: [{ sendAt: inMs(24 * HOUR), subject: 'A quick nudge', body: body(para(t('Nudge.'))) }],
                });
            expect(res.status).toBe(202);
            expect((await status((res.body as Accepted).followUps[0]!.messageId)).subject).toBe('A quick nudge');
        });

        it('refuses follow-ups out of order or too many, naming the follow-up — and stores nothing', async () => {
            const before = await owner.mailOutbound.count({ where: { workspaceId: workspace } });
            const order = await queue([48, 24]);
            expect(order.status).toBe(400);
            expect(err(order).fieldErrors?.map((f) => f.path)).toEqual(['followUps.1.sendAt']);
            const many = await queue(Array.from({ length: MAIL_FOLLOW_UPS_MAX + 1 }, (_, i) => 24 * (i + 1)));
            expect(many.status).toBe(400);
            expect(await owner.mailOutbound.count({ where: { workspaceId: workspace } })).toBe(before);
        });

        it('runs every check on each follow-up at the request: an empty variable refuses it, naming it', async () => {
            const before = await owner.mailOutbound.count({ where: { workspaceId: workspace } });
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({
                    mailboxId: adminMailbox,
                    personId: danaId,
                    subject: 'Hello',
                    body: body(para(t('Hi.'))),
                    followUps: [{ sendAt: inMs(24 * HOUR), body: body(para(v('person.city'))) }],
                });
            expect(res.status).toBe(422);
            expect(err(res).fieldErrors?.map((f) => f.path)).toEqual(['followUps.0.person.city']);
            expect(await owner.mailOutbound.count({ where: { workspaceId: workspace } })).toBe(before);
        });
    });

    describe('sending in the thread', () => {
        it('waits while the email before has not gone, then goes as a reply in its Gmail thread', async () => {
            const a = await accepted(queue([24, 48]));
            const [oneId, twoId] = a.followUps.map((f) => f.messageId) as [string, string];

            // Due, but the first is not sent: it waits, sending nothing.
            const sentBefore = gmail.sent.length;
            await expect(send.deliver(workspace, oneId, noWait, await dueAt(oneId))).rejects.toBeInstanceOf(SendNotDue);
            expect(gmail.sent.length).toBe(sentBefore);
            expect((await status(oneId)).status).toBe('scheduled');

            expect(await send.deliver(workspace, a.messageId, noWait)).toBe('sent');
            const first = gmail.sent.at(-1)!;
            const firstView = await status(a.messageId);
            expect(firstView.mailMessageId).not.toBeNull();

            expect(await send.deliver(workspace, oneId, noWait, await dueAt(oneId))).toBe('sent');
            const second = gmail.sent.at(-1)!;
            // Gmail's own Message-ID for the first (#87), and its thread.
            expect(second.threadId).toBe(await gmailThreadOf(a.messageId));
            expect(header(second.raw, 'In-Reply-To')).toBe(`<${first.messageId}>`);
            expect(header(second.raw, 'References')).toBe(`<${first.messageId}>`);
            expect(header(second.raw, 'Subject')).toBe(`Re: Hello ${stamp}`);
            expect((await status(oneId)).threadId).toBe(firstView.threadId);

            expect(await send.deliver(workspace, twoId, noWait, await dueAt(twoId))).toBe('sent');
            const third = gmail.sent.at(-1)!;
            expect(third.threadId).toBe(second.threadId);
            expect(header(third.raw, 'In-Reply-To')).toBe(`<${second.messageId}>`);
            expect(header(third.raw, 'References')).toBe(`<${first.messageId}> <${second.messageId}>`);
            expect(header(third.raw, 'Subject')).toBe(`Re: Hello ${stamp}`);
        });
    });

    async function gmailThreadOf(outboundId: string): Promise<string | null> {
        return (await owner.mailOutbound.findUniqueOrThrow({ where: { id: outboundId } })).providerThreadId;
    }

    describe('stop rules', () => {
        it('the person answering calls off every follow-up still queued, with the reason', async () => {
            const a = await accepted(queue([24, 48]));
            expect(await send.deliver(workspace, a.messageId, noWait)).toBe('sent');
            gmail.deliver(adminEmail, {
                from: dana,
                to: [adminEmail],
                subject: `Re: Hello ${stamp}`,
                text: 'Thanks, not now.',
                inReplyTo: gmail.sent.at(-1)!.messageId,
            });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            await settle(app);
            for (const f of a.followUps) {
                expect(await status(f.messageId)).toMatchObject({
                    status: 'cancelled',
                    error: { code: 'follow_up.replied' },
                });
            }
        });

        it('a follow-up due after an answer its event has not delivered yet is called off at its time (backstop)', async () => {
            const a = await accepted(queue([24, 48]));
            expect(await send.deliver(workspace, a.messageId, noWait)).toBe('sent');
            gmail.deliver(adminEmail, {
                from: dana,
                to: [adminEmail],
                subject: `Re: Hello ${stamp}`,
                text: 'Got it.',
                threadId: (await gmailThreadOf(a.messageId))!,
            });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            const [oneId, twoId] = a.followUps.map((f) => f.messageId) as [string, string];
            const sentBefore = gmail.sent.length;
            expect(await send.deliver(workspace, oneId, noWait, await dueAt(oneId))).toBe('cancelled');
            expect(gmail.sent.length).toBe(sentBefore);
            expect((await status(oneId)).error?.code).toBe('follow_up.replied');
            expect((await status(twoId)).status).toBe('cancelled');
            await settle(app);
        });

        it('cancelling an email by hand calls off the follow-ups after it, and only those', async () => {
            const a = await accepted(queue([24, 48, 72], { sendAt: inMs(HOUR) }));
            const [oneId, twoId, threeId] = a.followUps.map((f) => f.messageId) as [string, string, string];
            await as(admin)
                .post(w(`/mail/messages/${twoId}/cancel`))
                .expect(200);
            expect((await status(oneId)).status).toBe('scheduled');
            expect((await status(threeId)).error?.code).toBe('follow_up.previous_cancelled');
            await as(admin)
                .post(w(`/mail/messages/${a.messageId}/cancel`))
                .expect(200);
            expect(await status(oneId)).toMatchObject({
                status: 'cancelled',
                error: { code: 'follow_up.previous_cancelled' },
            });
            const cancelled = (await events.read()).filter((e) => e.type === 'email.cancelled');
            for (const id of [oneId, twoId, threeId]) {
                expect(cancelled.filter((e) => e.recordId === id)).toHaveLength(1);
            }
        });

        it('an email failing at its time calls off its follow-ups', async () => {
            const eli = await person('Eli', `eli-${stamp}@acme.example`);
            await owner.person.update({ where: { id: eli }, data: { jobTitle: 'Editor' } });
            const a = await accepted(
                queue(
                    [24],
                    { sendAt: inMs(HOUR), body: body(para(t('As '), v('person.jobTitle'), t('.'))) },
                    admin,
                    eli,
                ),
            );
            await owner.person.update({ where: { id: eli }, data: { jobTitle: null } });
            // The job title is gone by its time: the first email is unsendable then.
            expect(await send.deliver(workspace, a.messageId, noWait, await dueAt(a.messageId))).toBe('failed');
            expect((await status(a.followUps[0]!.messageId)).error?.code).toBe('follow_up.previous_failed');
        });

        it('a follow-up stays after the email it follows and before the next when moved', async () => {
            const a = await accepted(queue([24, 48], { sendAt: inMs(2 * HOUR) }));
            const [oneId] = a.followUps.map((f) => f.messageId) as [string, string];
            const early = await as(admin)
                .patch(w(`/mail/messages/${oneId}`))
                .send({ sendAt: inMs(HOUR) });
            expect(early.status).toBe(422);
            const late = await as(admin)
                .patch(w(`/mail/messages/${oneId}`))
                .send({ sendAt: inMs(60 * HOUR) });
            expect(late.status).toBe(422);
            const fine = await as(admin)
                .patch(w(`/mail/messages/${oneId}`))
                .send({ sendAt: inMs(30 * HOUR) });
            expect(fine.status).toBe(200);
        });
    });

    describe('guardrails at the request and at its time', () => {
        it('the recipient guard refuses a follow-up at its time when the person was suppressed meanwhile', async () => {
            const fay = `fay-${stamp}@acme.example`;
            const fayId = await person('Fay', fay);
            const a = await accepted(queue([24], {}, admin, fayId));
            expect(await send.deliver(workspace, a.messageId, noWait)).toBe('sent');
            await as(admin).post(w('/suppressions')).send({ address: fay }).expect(201);
            const oneId = a.followUps[0]!.messageId;
            expect(await send.deliver(workspace, oneId, noWait, await dueAt(oneId))).toBe('failed');
            expect((await status(oneId)).error?.code).toBe('recipient.suppressed');
        });

        it('the reputation gate judges a follow-up at its time: a paused mailbox does not send it', async () => {
            const a = await accepted(queue([24]));
            expect(await send.deliver(workspace, a.messageId, noWait)).toBe('sent');
            await owner.mailbox.update({
                where: { id: adminMailbox },
                data: { pausedAt: new Date(), pauseReason: { code: 'reply_rate', message: 'test' } },
            });
            try {
                const oneId = a.followUps[0]!.messageId;
                expect(await send.deliver(workspace, oneId, noWait, await dueAt(oneId))).toBe('failed');
                expect((await status(oneId)).error?.code).toBe('mailbox.paused');
            } finally {
                await owner.mailbox.update({
                    where: { id: adminMailbox },
                    data: { pausedAt: null, pauseReason: Prisma.DbNull },
                });
            }
        });

        it('the budget counts what is set to go in the window at a scheduled send’s request — a chain’s person once', async () => {
            await as(admin)
                .put(w('/reputation/settings'))
                .send({ ...REPUTATION_DEFAULTS, dailyNewRecipients: 2, hourlyNewRecipients: 2 })
                .expect(200);
            try {
                const [p1, p2, p3] = await Promise.all(
                    ['Gus', 'Hal', 'Ida'].map((n) => person(n, `${n.toLowerCase()}-${stamp}@budget.example`)),
                );
                await accepted(queue([3, 4], { sendAt: inMs(2 * HOUR) }, member, p1));
                const at = inMs(5 * HOUR);
                const ok = await as(member)
                    .post(w('/mail/send'))
                    .send({
                        mailboxId: memberMailbox,
                        personId: p2,
                        subject: 'Hi',
                        body: body(para(t('Hello.'))),
                        sendAt: at,
                    });
                expect(ok.status, JSON.stringify(ok.body)).toBe(202);
                const refused = await as(member)
                    .post(w('/mail/send'))
                    .send({
                        mailboxId: memberMailbox,
                        personId: p3,
                        subject: 'Hi',
                        body: body(para(t('Hello.'))),
                        sendAt: at,
                    });
                expect(refused.status).toBe(422);
                expect(err(refused).code).toBe('mailbox.budget_reached');
            } finally {
                await as(admin).put(w('/reputation/settings')).send(REPUTATION_DEFAULTS).expect(200);
            }
        });

        it('a near-identical scheduled send to too many people is refused at its request, not only at its time', async () => {
            await as(admin)
                .put(w('/reputation/settings'))
                .send({ ...REPUTATION_DEFAULTS, nearDuplicateThreshold: 2 })
                .expect(200);
            try {
                const people = await Promise.all(
                    ['Jo', 'Kit', 'Lu'].map((n) => person(n, `${n.toLowerCase()}-${stamp}@bulk.example`)),
                );
                const text =
                    'We have a brand new offer on our premium widgets this quarter, with free shipping and a long warranty for every order.';
                const schedule = (personId: string) =>
                    as(member)
                        .post(w('/mail/send'))
                        .send({
                            mailboxId: memberMailbox,
                            personId,
                            subject: `Offer ${stamp}`,
                            body: body(para(t(text))),
                            sendAt: inMs(30 * HOUR),
                        });
                expect((await schedule(people[0]!)).status).toBe(202);
                expect((await schedule(people[1]!)).status).toBe(202);
                const refused = await schedule(people[2]!);
                expect(refused.status).toBe(422);
                expect(err(refused).code).toBe('message.bulk_pattern');
            } finally {
                await as(admin).put(w('/reputation/settings')).send(REPUTATION_DEFAULTS).expect(200);
            }
        });
    });

    describe('cross-tenant', () => {
        it('another workspace can neither read nor cancel a follow-up', async () => {
            const a = await accepted(queue([24]));
            const oneId = a.followUps[0]!.messageId;
            expect((await as(otherAdmin).get(w(`/mail/messages/${oneId}`, otherWorkspace))).status).toBe(404);
            expect((await as(otherAdmin).post(w(`/mail/messages/${oneId}/cancel`, otherWorkspace))).status).toBe(404);
            expect((await status(oneId)).status).toBe('scheduled');
        });
    });
});
