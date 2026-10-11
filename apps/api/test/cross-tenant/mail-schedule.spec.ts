import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CAPABILITIES,
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_SCOPES,
    MAIL_SEND_HORIZON_DAYS,
    MAIL_SEND_MIN_LEAD_SECONDS,
    SESSION_COOKIE,
    SYSTEM_ROLES,
    type RichText,
} from '@bylinecrm/shared';
import type { Queue } from 'bullmq';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { ValidationFailed } from '../../src/infra/errors/api-errors';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MAIL_SEND_QUEUE, MAIL_SEND_STALE_MS } from '../../src/mail-send/mail-send.constants';
import { MailSendService, SendNotDue } from '../../src/mail-send/mail-send.service';
import { SendPolicy } from '../../src/mail-send/send-policy';
import { MailSendSweep } from '../../src/mail-send/sweep';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
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
    status: 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
    subject: string;
    sendAt: string | null;
    senderTimeZone: string | null;
    recipientTimeZone: null;
    cancelledAt: string | null;
    sentAt: string | null;
    error: { code: string; message: string; fields?: string[] } | null;
}
interface Accepted {
    messageId: string;
    status: 'queued' | 'scheduled';
    sendAt: string | null;
    senderTimeZone: string | null;
    recipientTimeZone: null;
}
interface ApiError {
    code: string;
    message: string;
    fieldErrors?: { path: string; message: string }[];
}
interface BusEvent {
    type: string;
    workspaceId: string;
    recordId: string;
}

const body = (...content: object[]): RichText => ({ type: 'doc', content }) as RichText;
const para = (...content: object[]) => ({ type: 'paragraph', content });
const v = (path: string) => ({ type: 'variable', attrs: { path } });
const t = (text: string) => ({ type: 'text', text });
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 60 * 60 * 1000;

/**
 * Scheduled sends (P2-5, FR-CRMS-4) end to end against an in-memory Gmail and Google. A send is
 * accepted for later with the same checks a send now runs, stored as asked (not as built), and at
 * its time built and checked again as the sender, the mailbox and the person stand then: a variable
 * that has since become empty, a mailbox that stopped working, a sender who lost the right to send,
 * or the send policy refuse it then — never a partial send. A scheduled send can be listed,
 * cancelled and moved; a sweep gives a send whose job was lost a job again, exactly once, and a send
 * whose time passed long ago fails as `stale`. Another workspace can do none of this to it.
 */
describe('FR-CRMS-4 scheduled send', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let send: MailSendService;
    let sweep: MailSendSweep;
    let policy: SendPolicy;
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
    let memberId: string;

    const adminEmail = `sched-admin-${stamp}@example.com`;
    const memberEmail = `sched-member-${stamp}@example.com`;
    const otherEmail = `sched-other-${stamp}@example.com`;
    const dana = `dana-${stamp}@acme.example`;

    let adminMailbox: string;
    let memberMailbox: string;
    let danaId: string;
    const events: BusEvent[] = [];

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const noWait = { sleep: () => Promise.resolve() };
    const err = (res: Response) => res.body as ApiError;
    const ofType = (type: string, recordId: string) => events.filter((e) => e.type === type && e.recordId === recordId);

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

    /** Schedules a free-form send from the admin to Dana, `ms` from now. */
    async function schedule(ms: number, extra: Record<string, unknown> = {}, who: Browser = admin): Promise<Accepted> {
        const res = await as(who)
            .post(w('/mail/send'))
            .send({
                mailboxId: who === member ? memberMailbox : adminMailbox,
                personId: danaId,
                subject: 'Following up',
                body: body(para(t('Hi '), v('person.firstName'), t('.'))),
                sendAt: inMs(ms),
                ...extra,
            });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        return res.body as Accepted;
    }

    /** The time a scheduled send's job would run: just after its `sendAt`. */
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
        sweep = app.get(MailSendSweep);
        policy = app.get(SendPolicy);
        queue = app.get<Queue>(getQueueToken(MAIL_SEND_QUEUE));
        app.get(EventEmitter2).onAny((type: string | string[], payload: unknown) => {
            if (typeof type === 'string' && type.startsWith('email.')) events.push(payload as BusEvent);
        });

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Schedule ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other schedule ${stamp}`));

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
        memberId = ((await as(admin).get(w('/members'))).body as { id: string; email: string }[]).find(
            (m) => m.email === memberEmail,
        )!.id;

        for (const [who, ws, tag] of [
            [admin, workspace, 'a'],
            [otherAdmin, otherWorkspace, 'b'],
        ] as const) {
            const clientId = `444-${tag}${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
            const secret = `GOCSPX-sched-${tag}-${stamp}`;
            const view = await as(who).get(w('/mail/oauth-client', ws));
            google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
            const put = await http()
                .put(w('/mail/oauth-client', ws))
                .set('Cookie', who.cookie)
                .set(CSRF_HEADER, who.csrf)
                .send({ clientId, clientSecret: secret });
            expect(put.status).toBe(200);
        }
        adminMailbox = await connect(admin, workspace, adminEmail);
        memberMailbox = await connect(member, workspace, memberEmail);

        danaId = (
            (
                await as(admin)
                    .post(w('/people'))
                    .send({
                        nameFirst: 'Dana',
                        nameLast: 'Reyes',
                        jobTitle: 'Head of Comms',
                        emails: { primary: dana, additional: [] },
                    })
            ).body as { id: string }
        ).id;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('FR-CRMS-4 when a send may be scheduled for', () => {
        it('refuses a time sooner than the minimum lead, naming sendAt', async () => {
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({
                    mailboxId: adminMailbox,
                    personId: danaId,
                    subject: 'Soon',
                    body: body(para(t('x'))),
                    sendAt: inMs((MAIL_SEND_MIN_LEAD_SECONDS - 30) * 1000),
                });
            expect(res.status).toBe(400);
            expect(err(res).code).toBe('validation.failed');
            expect(err(res).fieldErrors?.map((f) => f.path)).toContain('sendAt');
        });

        it('refuses a time past the horizon, naming sendAt', async () => {
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({
                    mailboxId: adminMailbox,
                    personId: danaId,
                    subject: 'Far',
                    body: body(para(t('x'))),
                    sendAt: inMs((MAIL_SEND_HORIZON_DAYS + 1) * 24 * HOUR),
                });
            expect(res.status).toBe(400);
            expect(err(res).fieldErrors?.map((f) => f.path)).toContain('sendAt');
        });

        it('refuses a time zone the server does not know, naming timeZone', async () => {
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({
                    mailboxId: adminMailbox,
                    personId: danaId,
                    subject: 'Zone',
                    body: body(para(t('x'))),
                    sendAt: inMs(HOUR),
                    timeZone: 'Mars/Olympus_Mons',
                });
            expect(res.status).toBe(400);
            expect(err(res).fieldErrors?.map((f) => f.path)).toContain('timeZone');
        });

        it('runs the send-now checks at the request too: an empty variable is refused at once', async () => {
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({
                    mailboxId: adminMailbox,
                    personId: danaId,
                    subject: 'Hello',
                    body: body(para(v('person.city'))),
                    sendAt: inMs(HOUR),
                });
            expect(res.status).toBe(422);
            expect(err(res).fieldErrors?.map((f) => f.path)).toEqual(['person.city']);
        });
    });

    describe('FR-CRMS-4 a scheduled send', () => {
        it('is accepted as scheduled with its time in UTC, the sender’s zone echoed and the recipient’s unknown', async () => {
            const sentBefore = gmail.sent.length;
            const accepted = await schedule(HOUR, { timeZone: 'Europe/London' });
            expect(accepted).toMatchObject({
                status: 'scheduled',
                senderTimeZone: 'Europe/London',
                recipientTimeZone: null,
            });
            expect(accepted.sendAt).toMatch(/Z$/);
            const view = await status(accepted.messageId);
            expect(view).toMatchObject({
                status: 'scheduled',
                senderTimeZone: 'Europe/London',
                recipientTimeZone: null,
            });
            const job = await queue.getJob(accepted.messageId);
            expect(await job?.getState()).toBe('delayed');
            expect(ofType('email.scheduled', accepted.messageId)).toHaveLength(1);
            expect(gmail.sent.length).toBe(sentBefore);
        });

        it('is built at its time, as the person is then', async () => {
            const accepted = await schedule(HOUR);
            await as(admin)
                .patch(w(`/people/${danaId}`))
                .send({ nameFirst: 'Danielle' })
                .expect(200);
            try {
                const outcome = await send.deliver(
                    workspace,
                    accepted.messageId,
                    noWait,
                    await dueAt(accepted.messageId),
                );
                expect(outcome).toBe('sent');
                const raw = gmail.sent.at(-1)!.raw;
                const html = Buffer.from(
                    raw
                        .split(/--[^\r\n]+\r\nContent-Type: text\/html[^\r\n]*\r\n[^\r\n]*\r\n\r\n/)[1]!
                        .split('\r\n--')[0]!
                        .replace(/\r\n/g, ''),
                    'base64',
                ).toString('utf8');
                expect(html).toContain('Hi Danielle.');
                const view = await status(accepted.messageId);
                expect(view.status).toBe('sent');
            } finally {
                await as(admin)
                    .patch(w(`/people/${danaId}`))
                    .send({ nameFirst: 'Dana' })
                    .expect(200);
            }
        });

        it('waits again when its job fires before its time, sending nothing', async () => {
            const accepted = await schedule(HOUR);
            const sentBefore = gmail.sent.length;
            const early = new Date(accepted.sendAt!).getTime() - 10 * 60 * 1000;
            await expect(send.deliver(workspace, accepted.messageId, noWait, early)).rejects.toBeInstanceOf(SendNotDue);
            expect(gmail.sent.length).toBe(sentBefore);
            expect((await status(accepted.messageId)).status).toBe('scheduled');
        });
    });

    describe('FR-CRMS-4 checks run again at send time', () => {
        it('fails as unsendable, naming the variable, when a value became empty after scheduling', async () => {
            const accepted = await schedule(HOUR, { body: body(para(t('As '), v('person.jobTitle'), t(' at Acme'))) });
            await as(admin)
                .patch(w(`/people/${danaId}`))
                .send({ jobTitle: null })
                .expect(200);
            try {
                const sentBefore = gmail.sent.length;
                const outcome = await send.deliver(
                    workspace,
                    accepted.messageId,
                    noWait,
                    await dueAt(accepted.messageId),
                );
                expect(outcome).toBe('failed');
                expect(gmail.sent.length).toBe(sentBefore);
                const view = await status(accepted.messageId);
                expect(view.status).toBe('failed');
                expect(view.error).toMatchObject({ code: 'unsendable', fields: ['person.jobTitle'] });
            } finally {
                await as(admin)
                    .patch(w(`/people/${danaId}`))
                    .send({ jobTitle: 'Head of Comms' })
                    .expect(200);
            }
        });

        it('fails when the mailbox stopped working meanwhile', async () => {
            const accepted = await schedule(HOUR);
            await owner.mailbox.update({ where: { id: adminMailbox }, data: { status: 'reconnect_needed' } });
            try {
                const sentBefore = gmail.sent.length;
                const outcome = await send.deliver(
                    workspace,
                    accepted.messageId,
                    noWait,
                    await dueAt(accepted.messageId),
                );
                expect(outcome).toBe('failed');
                expect(gmail.sent.length).toBe(sentBefore);
                expect((await status(accepted.messageId)).error?.code).toBe('reconnect_needed');
            } finally {
                await owner.mailbox.update({ where: { id: adminMailbox }, data: { status: 'connected' } });
            }
        });

        it('fails when the send policy refuses the recipients at send time', async () => {
            const accepted = await schedule(HOUR);
            vi.spyOn(policy, 'assertSendable').mockRejectedValueOnce(
                new ValidationFailed('this address unsubscribed', [{ path: 'to', message: 'unsubscribed' }]),
            );
            const sentBefore = gmail.sent.length;
            const outcome = await send.deliver(workspace, accepted.messageId, noWait, await dueAt(accepted.messageId));
            expect(outcome).toBe('failed');
            expect(gmail.sent.length).toBe(sentBefore);
            expect((await status(accepted.messageId)).error).toMatchObject({
                code: 'validation.failed',
                fields: ['to'],
            });
        });

        it('fails when the sender may no longer send mail', async () => {
            const accepted = await schedule(HOUR, {}, member);
            const noSend = await as(admin)
                .post(w('/roles'))
                .send({ name: `No send ${stamp}`, capabilities: CAPABILITIES.filter((c) => c !== 'email:send') });
            expect(noSend.status).toBe(201);
            const roles = (await as(admin).get(w('/roles'))).body as { id: string; name: string }[];
            const memberRole = roles.find((r) => r.name === SYSTEM_ROLES.member)!.id;
            await as(admin)
                .patch(w(`/members/${memberId}/role`))
                .send({ roleId: (noSend.body as { id: string }).id })
                .expect(204);
            try {
                const outcome = await send.deliver(
                    workspace,
                    accepted.messageId,
                    noWait,
                    await dueAt(accepted.messageId),
                );
                expect(outcome).toBe('failed');
                expect((await status(accepted.messageId)).error?.code).toBe('forbidden');
            } finally {
                await as(admin)
                    .patch(w(`/members/${memberId}/role`))
                    .send({ roleId: memberRole })
                    .expect(204);
            }
        });
    });

    describe('FR-CRMS-4 cancelling and moving', () => {
        it('cancels a scheduled send, removes its job, announces it once, and is idempotent', async () => {
            const accepted = await schedule(HOUR);
            const res = await as(admin).post(w(`/mail/messages/${accepted.messageId}/cancel`));
            expect(res.status).toBe(200);
            expect((res.body as Outbound).status).toBe('cancelled');
            expect((res.body as Outbound).cancelledAt).not.toBeNull();
            expect(await queue.getJob(accepted.messageId)).toBeUndefined();
            const again = await as(admin).post(w(`/mail/messages/${accepted.messageId}/cancel`));
            expect(again.status).toBe(200);
            expect((again.body as Outbound).status).toBe('cancelled');
            expect(ofType('email.cancelled', accepted.messageId)).toHaveLength(1);
            const sentBefore = gmail.sent.length;
            expect(await send.deliver(workspace, accepted.messageId, noWait, Date.now() + 2 * HOUR)).toBe('cancelled');
            expect(gmail.sent.length).toBe(sentBefore);
        });

        it('refuses to cancel or move a send that has gone', async () => {
            const accepted = await schedule(HOUR);
            await send.deliver(workspace, accepted.messageId, noWait, await dueAt(accepted.messageId));
            expect((await status(accepted.messageId)).status).toBe('sent');
            const cancel = await as(admin).post(w(`/mail/messages/${accepted.messageId}/cancel`));
            expect(cancel.status).toBe(409);
            const move = await as(admin)
                .patch(w(`/mail/messages/${accepted.messageId}`))
                .send({ sendAt: inMs(2 * HOUR) });
            expect(move.status).toBe(409);
        });

        it('moves a scheduled send: the job waits for the new time, and only the new time sends it', async () => {
            const accepted = await schedule(HOUR);
            const oldDue = await dueAt(accepted.messageId);
            const res = await as(admin)
                .patch(w(`/mail/messages/${accepted.messageId}`))
                .send({ sendAt: inMs(3 * HOUR), timeZone: 'America/New_York' });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const moved = res.body as Outbound;
            expect(moved.status).toBe('scheduled');
            expect(moved.senderTimeZone).toBe('America/New_York');
            expect(new Date(moved.sendAt!).getTime()).toBeGreaterThan(oldDue + HOUR);
            const job = await queue.getJob(accepted.messageId);
            expect(await job?.getState()).toBe('delayed');
            expect(job!.delay).toBeGreaterThan(2.5 * HOUR);

            const sentBefore = gmail.sent.length;
            await expect(send.deliver(workspace, accepted.messageId, noWait, oldDue)).rejects.toBeInstanceOf(
                SendNotDue,
            );
            expect(gmail.sent.length).toBe(sentBefore);
            expect(await send.deliver(workspace, accepted.messageId, noWait, await dueAt(accepted.messageId))).toBe(
                'sent',
            );
            expect(gmail.sent.length).toBe(sentBefore + 1);
        });

        it('refuses to move a send to a time outside the window', async () => {
            const accepted = await schedule(HOUR);
            const res = await as(admin)
                .patch(w(`/mail/messages/${accepted.messageId}`))
                .send({ sendAt: inMs(1_000) });
            expect(res.status).toBe(400);
            expect(err(res).fieldErrors?.map((f) => f.path)).toContain('sendAt');
        });
    });

    describe('FR-CRMS-4 the scheduled list', () => {
        it('shows a member their own scheduled sends, soonest first, and an admin everyone’s', async () => {
            const later = await schedule(5 * HOUR, {}, member);
            const sooner = await schedule(4 * HOUR, {}, member);
            const mine = await schedule(4.5 * HOUR);
            const memberList = (await as(member).get(w('/mail/scheduled?limit=100'))).body as { items: Outbound[] };
            const memberIds = memberList.items.map((i) => i.id);
            expect(memberIds).toContain(later.messageId);
            expect(memberIds).toContain(sooner.messageId);
            expect(memberIds).not.toContain(mine.messageId);
            expect(memberIds.indexOf(sooner.messageId)).toBeLessThan(memberIds.indexOf(later.messageId));
            const adminList = (await as(admin).get(w('/mail/scheduled?limit=100'))).body as { items: Outbound[] };
            const adminIds = adminList.items.map((i) => i.id);
            expect(adminIds).toEqual(expect.arrayContaining([later.messageId, sooner.messageId, mine.messageId]));
            expect(adminList.items.every((i) => i.status === 'scheduled')).toBe(true);
        });
    });

    describe('FR-CRMS-4 durability', () => {
        it('gives a send whose job was lost a job again, exactly once', async () => {
            const accepted = await schedule(HOUR);
            await (await queue.getJob(accepted.messageId))!.remove();
            const at = new Date(accepted.sendAt!).getTime() - 30_000;
            const first = await sweep.run(at);
            expect(first.requeued).toBeGreaterThanOrEqual(1);
            expect(await queue.getJob(accepted.messageId)).toBeDefined();
            const second = await sweep.run(at);
            const job = await queue.getJob(accepted.messageId);
            expect(await job?.getState()).toBe('delayed');
            // Every send the first pass found now has a job, and its id is the send's: nothing twice.
            expect(second.requeued).toBe(0);
            const jobs = await queue.getJobs(['delayed', 'waiting']);
            expect(jobs.filter((j) => j.id === accepted.messageId)).toHaveLength(1);
        });

        it('fails a send whose time passed long ago as stale instead of sending it late', async () => {
            const accepted = await schedule(HOUR);
            await (await queue.getJob(accepted.messageId))!.remove();
            const overdue = new Date(accepted.sendAt!).getTime() + MAIL_SEND_STALE_MS + HOUR;
            await sweep.run(overdue);
            expect(await queue.getJob(accepted.messageId)).toBeDefined();
            const sentBefore = gmail.sent.length;
            expect(await send.deliver(workspace, accepted.messageId, noWait, overdue)).toBe('failed');
            expect(gmail.sent.length).toBe(sentBefore);
            expect((await status(accepted.messageId)).error?.code).toBe('stale');
        });

        it('sends once when two deliveries of the same send race at its time', async () => {
            const accepted = await schedule(HOUR);
            const due = await dueAt(accepted.messageId);
            const sentBefore = gmail.sent.length;
            const outcomes = await Promise.all([
                send.deliver(workspace, accepted.messageId, noWait, due),
                send.deliver(workspace, accepted.messageId, noWait, due),
            ]);
            expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
            expect(gmail.sent.length).toBe(sentBefore + 1);
            expect((await status(accepted.messageId)).status).toBe('sent');
        });
    });

    describe('FR-CRMS-4 across workspaces', () => {
        it('another workspace cannot list, read, cancel or move a scheduled send', async () => {
            const accepted = await schedule(HOUR);
            const list = (await as(otherAdmin).get(w('/mail/scheduled?limit=100', otherWorkspace))).body as {
                items: Outbound[];
            };
            expect(list.items.map((i) => i.id)).not.toContain(accepted.messageId);
            expect((await as(otherAdmin).get(w(`/mail/messages/${accepted.messageId}`, otherWorkspace))).status).toBe(
                404,
            );
            expect(
                (await as(otherAdmin).post(w(`/mail/messages/${accepted.messageId}/cancel`, otherWorkspace))).status,
            ).toBe(404);
            expect(
                (
                    await as(otherAdmin)
                        .patch(w(`/mail/messages/${accepted.messageId}`, otherWorkspace))
                        .send({ sendAt: inMs(2 * HOUR) })
                ).status,
            ).toBe(404);
            expect((await status(accepted.messageId)).status).toBe('scheduled');
        });

        it('a member cannot cancel or move another member’s scheduled send', async () => {
            const accepted = await schedule(HOUR);
            expect((await as(member).post(w(`/mail/messages/${accepted.messageId}/cancel`))).status).toBe(404);
            expect(
                (
                    await as(member)
                        .patch(w(`/mail/messages/${accepted.messageId}`))
                        .send({ sendAt: inMs(2 * HOUR) })
                ).status,
            ).toBe(404);
        });
    });
});
