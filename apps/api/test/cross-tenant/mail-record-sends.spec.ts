import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, GMAIL_SCOPES, SESSION_COOKIE, SYSTEM_ROLES, type RichText } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { ValidationFailed } from '../../src/infra/errors/api-errors';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MailSendService } from '../../src/mail-send/mail-send.service';
import { SendPolicy } from '../../src/mail-send/send-policy';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { PrismaService } from '../../src/infra/prisma.service';
import { RecipientSuppressed } from '../../src/suppression/suppression.service';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
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
    status: string;
    subject: string;
    personId: string | null;
    dealId: string | null;
    senderMemberId: string;
    canChange: boolean;
    canRetry: boolean;
    createdAt: string;
    error: { code: string; message: string; fields?: string[] } | null;
}
interface SendsPage {
    items: Outbound[];
    nextCursor: string | null;
}

const body = (...content: object[]): RichText => ({ type: 'doc', content }) as RichText;
const para = (...content: object[]) => ({ type: 'paragraph', content });
const t = (text: string) => ({ type: 'text', text });
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 60 * 60 * 1000;

/**
 * A record's sends (#104): `GET /mail/messages?target=&status=` lists the sends about one record —
 * failed ones with their reason, scheduled ones — newest first, a page at a time, so a record page
 * shows them after a reload. Who sees a send (#133): anyone who can read its record — so colleagues
 * see that a person is already being written to — and its sender always; who changes one: its
 * sender or an admin, a reader who may not change it is refused (403), never told it is missing.
 * A record outside the caller's scope, or another workspace's, is not found.
 */
describe('#104 a record’s sends', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let send: MailSendService;
    let policy: SendPolicy;
    let owner: PrismaService;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let member: Browser;
    let rep: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;

    const adminEmail = `rs-admin-${stamp}@example.com`;
    const memberEmail = `rs-member-${stamp}@example.com`;
    const repEmail = `rs-rep-${stamp}@example.com`;
    const otherEmail = `rs-other-${stamp}@example.com`;

    let adminMailbox: string;
    let repMailbox: string;
    let danaId: string;
    let wrenId: string;
    let acmeId: string;
    let dealId: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const noWait = { sleep: () => Promise.resolve() };

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

    /** Schedules a send `ms` from now; returns its id. */
    async function schedule(
        subject: string,
        personId: string,
        options: { ms?: number; who?: Browser; dealId?: string } = {},
    ): Promise<string> {
        const who = options.who ?? admin;
        const res = await as(who)
            .post(w('/mail/send'))
            .send({
                mailboxId: who === rep ? repMailbox : adminMailbox,
                personId,
                subject,
                body: body(para(t('Hello.'))),
                sendAt: inMs(options.ms ?? HOUR),
                ...(options.dealId ? { dealId: options.dealId } : {}),
            });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        return (res.body as { messageId: string }).messageId;
    }

    /** A scheduled send whose time came and whose recipient the send policy then refused. */
    async function failed(subject: string, personId: string): Promise<string> {
        const id = await schedule(subject, personId);
        const view = (await as(admin).get(w(`/mail/messages/${id}`))).body as { sendAt: string };
        vi.spyOn(policy, 'assertSendable').mockRejectedValueOnce(
            new ValidationFailed('this address unsubscribed', [{ path: 'to', message: 'unsubscribed' }]),
        );
        expect(await send.deliver(workspace, id, noWait, new Date(view.sendAt).getTime() + 1_000)).toBe('failed');
        return id;
    }

    async function list(who: Browser, query: string, ws = workspace): Promise<Response> {
        return as(who).get(w(`/mail/messages?${query}`, ws));
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
        send = app.get(MailSendService);
        policy = app.get(SendPolicy);
        owner = app.get(PrismaService);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Record sends ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other sends ${stamp}`));

        const join = async (email: string, roleId: string) => {
            const invite = await as(admin).post(w('/invites')).send({ email, roleId });
            const joined = await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password });
            expect(joined.status).toBe(201);
            await verifyAddress(app, http, email);
            return browserFrom(joined);
        };
        const roles = (await as(admin).get(w('/roles'))).body as { id: string; name: string }[];
        member = await join(memberEmail, roles.find((r) => r.name === SYSTEM_ROLES.member)!.id);
        // A rep sends mail, and sees only the records they own.
        const repRole = await as(admin)
            .post(w('/roles'))
            .send({
                name: `rep ${stamp}`,
                capabilities: ['record:read', 'record:write', 'email:send', 'mailbox:read', 'mailbox:manage'],
                recordScope: 'own',
            })
            .expect(201);
        rep = await join(repEmail, (repRole.body as { id: string }).id);

        for (const [who, ws, tag] of [
            [admin, workspace, 'a'],
            [otherAdmin, otherWorkspace, 'b'],
        ] as const) {
            const clientId = `555-${tag}${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
            const secret = `GOCSPX-rs-${tag}-${stamp}`;
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
        repMailbox = await connect(rep, workspace, repEmail);

        acmeId = ((await as(admin).post(w('/companies')).send({ name: 'Acme' }).expect(201)).body as { id: string }).id;
        danaId = (
            (
                await as(admin)
                    .post(w('/people'))
                    .send({
                        nameFirst: 'Dana',
                        companyId: acmeId,
                        emails: { primary: `dana-${stamp}@acme.example`, additional: [] },
                    })
                    .expect(201)
            ).body as { id: string }
        ).id;
        wrenId = (
            (
                await as(rep)
                    .post(w('/people'))
                    .send({ nameFirst: 'Wren', emails: { primary: `wren-${stamp}@wren.example`, additional: [] } })
                    .expect(201)
            ).body as { id: string }
        ).id;
        dealId = (
            (
                await as(admin)
                    .post(w('/opportunities'))
                    .send({ name: `Deal ${stamp}` })
                    .expect(201)
            ).body as {
                id: string;
            }
        ).id;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await app?.close();
    });

    it('#104 lists a person’s failed and scheduled sends, newest first, a failure with its reason', async () => {
        const first = await schedule('First, still scheduled', danaId);
        const second = await failed('Second, failed', danaId);
        const third = await schedule('Third, still scheduled', danaId, { ms: 2 * HOUR });

        const res = await list(admin, `target=person:${danaId}&status=failed,scheduled`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const page = res.body as SendsPage;
        expect(page.items.map((s) => s.id)).toEqual([third, second, first]);
        const failure = page.items.find((s) => s.id === second)!;
        expect(failure.status).toBe('failed');
        expect(failure.error).toMatchObject({ code: 'validation.failed', fields: ['to'] });
        expect(page.nextCursor).toBeNull();
    });

    it('#104 lists only the statuses asked for', async () => {
        const res = await list(admin, `target=person:${danaId}&status=failed`);
        expect(res.status).toBe(200);
        const items = (res.body as SendsPage).items;
        expect(items.length).toBeGreaterThan(0);
        expect(items.every((s) => s.status === 'failed')).toBe(true);
    });

    it('#104 pages with a cursor, newest first, to the end', async () => {
        const all = ((await list(admin, `target=person:${danaId}&status=failed,scheduled`)).body as SendsPage).items;
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
            const res: Response = await list(
                admin,
                `target=person:${danaId}&status=failed,scheduled&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
            );
            expect(res.status).toBe(200);
            const page = res.body as SendsPage;
            expect(page.items.length).toBeLessThanOrEqual(1);
            seen.push(...page.items.map((s) => s.id));
            cursor = page.nextCursor;
        } while (cursor);
        expect(seen).toEqual(all.map((s) => s.id));
    });

    it('#104 a company lists its people’s sends; a deal the sends written from it', async () => {
        const fromDeal = await schedule('About the deal', danaId, { dealId });
        const company = ((await list(admin, `target=company:${acmeId}&status=scheduled`)).body as SendsPage).items;
        expect(company.some((s) => s.id === fromDeal)).toBe(true);
        expect(company.every((s) => s.personId === danaId)).toBe(true);
        const deal = ((await list(admin, `target=opportunity:${dealId}&status=scheduled`)).body as SendsPage).items;
        expect(deal.map((s) => s.id)).toEqual([fromDeal]);
    });

    it('#104 another record’s sends are not listed', async () => {
        const forWren = await schedule('For Wren', wrenId, { who: rep });
        const dana = ((await list(admin, `target=person:${danaId}&status=scheduled`)).body as SendsPage).items;
        expect(dana.some((s) => s.id === forWren)).toBe(false);
    });

    it('#133 a member who can read the record sees a colleague’s sends on it, and whose they are', async () => {
        const id = await schedule('Seen by colleagues', danaId);
        const listed = await list(member, `target=person:${danaId}&status=failed,scheduled`);
        expect(listed.status).toBe(200);
        const items = (listed.body as SendsPage).items;
        expect(items.some((s) => s.id === id)).toBe(true);
        const members = (await as(admin).get(w('/members'))).body as { id: string; email: string }[];
        const adminMember = members.find((m) => m.email === adminEmail)!.id;
        expect(items.find((s) => s.id === id)!.senderMemberId).toBe(adminMember);
        const detail = await as(member).get(w(`/mail/messages/${id}`));
        expect(detail.status, JSON.stringify(detail.body)).toBe(200);
        expect((detail.body as Outbound).senderMemberId).toBe(adminMember);
        // The page offers Reschedule and Cancel only where the API will take them.
        expect((detail.body as Outbound).canChange).toBe(false);
        expect(items.find((s) => s.id === id)!.canChange).toBe(false);
        expect(((await as(admin).get(w(`/mail/messages/${id}`))).body as Outbound).canChange).toBe(true);
    });

    it('#133 the scheduled list shows every scheduled send on records the caller can read', async () => {
        const id = await schedule('On the shared schedule', danaId);
        const forWren = await schedule('Rep’s own', wrenId, { who: rep });
        const asMember = ((await as(member).get(w('/mail/scheduled?limit=100'))).body as SendsPage).items;
        expect(asMember.some((s) => s.id === id)).toBe(true);
        const asRep = ((await as(rep).get(w('/mail/scheduled?limit=100'))).body as SendsPage).items;
        expect(asRep.some((s) => s.id === forWren)).toBe(true);
        expect(asRep.some((s) => s.id === id)).toBe(false);
    });

    it('#133 a reader who is not the sender may not reschedule or cancel: 403, and the send stands', async () => {
        const id = await schedule('Not the member’s to move', danaId);
        const move = await as(member)
            .patch(w(`/mail/messages/${id}`))
            .send({ sendAt: inMs(3 * HOUR) });
        expect(move.status, JSON.stringify(move.body)).toBe(403);
        expect((move.body as { code: string }).code).toBe('forbidden');
        const cancel = await as(member)
            .post(w(`/mail/messages/${id}/cancel`))
            .send({});
        expect(cancel.status, JSON.stringify(cancel.body)).toBe(403);
        const after = (await as(admin).get(w(`/mail/messages/${id}`))).body as Outbound;
        expect(after.status).toBe('scheduled');
    });

    it('#133 an admin may reschedule and cancel a colleague’s send', async () => {
        const id = await schedule('The rep’s, moved by an admin', wrenId, { who: rep });
        const move = await as(admin)
            .patch(w(`/mail/messages/${id}`))
            .send({ sendAt: inMs(4 * HOUR) });
        expect(move.status, JSON.stringify(move.body)).toBe(200);
        const cancel = await as(admin)
            .post(w(`/mail/messages/${id}/cancel`))
            .send({});
        expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
        expect((cancel.body as Outbound).status).toBe('cancelled');
    });

    it('#133 a send on a record outside the caller’s scope is not found, by list or by id', async () => {
        const id = await schedule('Outside the rep’s records', danaId);
        expect((await list(rep, `target=person:${danaId}&status=scheduled`)).status).toBe(404);
        expect((await as(rep).get(w(`/mail/messages/${id}`))).status).toBe(404);
        expect(
            (
                await as(rep)
                    .post(w(`/mail/messages/${id}/cancel`))
                    .send({})
            ).status,
        ).toBe(404);
    });

    it('#133 once its record is gone a send is its sender’s (and an admin’s) alone', async () => {
        const kim = (
            (
                await as(rep)
                    .post(w('/people'))
                    .send({ nameFirst: 'Kim', emails: { primary: `kim-${stamp}@kim.example`, additional: [] } })
                    .expect(201)
            ).body as { id: string }
        ).id;
        const id = await schedule('About someone since deleted', kim, { who: rep });
        expect((await as(member).get(w(`/mail/messages/${id}`))).status).toBe(200);
        await as(admin)
            .delete(w(`/people/${kim}`))
            .expect((r) => expect([200, 204]).toContain(r.status));
        expect((await as(member).get(w(`/mail/messages/${id}`))).status).toBe(404);
        expect((await as(rep).get(w(`/mail/messages/${id}`))).status).toBe(200);
        expect((await as(admin).get(w(`/mail/messages/${id}`))).status).toBe(200);
    });

    it('#133 another workspace cannot read or change a send by id', async () => {
        const id = await schedule('Not across workspaces', danaId);
        expect([403, 404]).toContain((await as(otherAdmin).get(w(`/mail/messages/${id}`))).status);
        expect([403, 404]).toContain((await as(otherAdmin).get(w(`/mail/messages/${id}`, otherWorkspace))).status);
        const cancel = await as(otherAdmin)
            .post(w(`/mail/messages/${id}/cancel`, otherWorkspace))
            .send({});
        expect(cancel.status).toBe(404);
    });

    it('#104 a record outside the caller’s scope is not found; their own record lists their sends', async () => {
        const outside = await list(rep, `target=person:${danaId}&status=failed,scheduled`);
        expect(outside.status).toBe(404);
        const own = await list(rep, `target=person:${wrenId}&status=scheduled`);
        expect(own.status).toBe(200);
        expect((own.body as SendsPage).items.length).toBeGreaterThan(0);
    });

    it('#104 another workspace cannot list them', async () => {
        const res = await list(otherAdmin, `target=person:${danaId}&status=failed,scheduled`, otherWorkspace);
        expect(res.status).toBe(404);
        const foreign = await list(otherAdmin, `target=person:${danaId}&status=scheduled`);
        expect([403, 404]).toContain(foreign.status);
    });

    it('#104 refuses a missing target, an unknown status and a missing status, naming the field', async () => {
        for (const [query, field] of [
            ['status=failed', 'target'],
            [`target=person:${danaId}&status=lost`, 'status'],
            [`target=person:${danaId}`, 'status'],
        ] as const) {
            const res = await list(admin, query);
            expect(res.status, query).toBe(400);
            expect(JSON.stringify(res.body), query).toContain(field);
        }
    });
    // ── #134 Retry a failed send from the server ──────────────────────────────────────────────

    /** A send made now whose every Gmail attempt is refused for good (a 400): failed, with its content kept. */
    async function failedNow(subject: string, personId: string): Promise<string> {
        gmail.failNext(adminEmail, 'send', 400);
        const res = await as(admin)
            .post(w('/mail/send'))
            .send({ mailboxId: adminMailbox, personId, subject, body: body(para(t('Hello again.'))) });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        const id = (res.body as { messageId: string }).messageId;
        expect(await send.deliver(workspace, id, noWait)).toBe('failed');
        return id;
    }

    async function read(who: Browser, id: string): Promise<Outbound> {
        const res = await as(who).get(w(`/mail/messages/${id}`));
        expect(res.status).toBe(200);
        return res.body as Outbound;
    }

    it('#134 a failed send made now is retried from the server: built and checked again, then sent once', async () => {
        const id = await failedNow('Retry me now', danaId);
        expect((await read(admin, id)).canRetry).toBe(true);
        const sentBefore = gmail.sent.length;

        const retried = await as(admin).post(w(`/mail/messages/${id}/retry`));
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        expect((retried.body as Outbound).status).not.toBe('failed');
        expect((retried.body as Outbound).error).toBeNull();

        expect(await send.deliver(workspace, id, noWait)).toBe('sent');
        expect(gmail.sent.length).toBe(sentBefore + 1);
        expect((await read(admin, id)).status).toBe('sent');
    });

    it('#134 a scheduled send that failed at its time is retried, re-checked against the state now', async () => {
        const id = await failed('Retry scheduled', danaId);
        expect((await read(admin, id)).canRetry).toBe(true);
        expect((await as(admin).post(w(`/mail/messages/${id}/retry`))).status).toBe(200);
        // The policy still refuses: the retry fails again, with the reason as it stands now.
        vi.spyOn(policy, 'assertSendable').mockRejectedValueOnce(
            new ValidationFailed('still refused', [{ path: 'to', message: 'still refused' }]),
        );
        expect(await send.deliver(workspace, id, noWait)).toBe('failed');
        const after = await read(admin, id);
        expect(after.status).toBe('failed');
        expect(after.error?.message).toContain('still refused');
    });

    it('#134 retry is idempotent: a second retry while the first is under way sends nothing more', async () => {
        const id = await failedNow('Retry twice', danaId);
        const sentBefore = gmail.sent.length;
        const [one, two] = await Promise.all([
            as(admin).post(w(`/mail/messages/${id}/retry`)),
            as(admin).post(w(`/mail/messages/${id}/retry`)),
        ]);
        expect([one.status, two.status]).toEqual([200, 200]);
        expect(await send.deliver(workspace, id, noWait)).toBe('sent');
        expect(await send.deliver(workspace, id, noWait)).toBe('skipped');
        expect(gmail.sent.length).toBe(sentBefore + 1);
    });

    it('#134 a send refused because a recipient is suppressed is not retryable', async () => {
        const id = await schedule('Suppressed', danaId);
        const view = (await as(admin).get(w(`/mail/messages/${id}`))).body as { sendAt: string };
        const at = new Date(view.sendAt).getTime() + 1_000;
        vi.spyOn(policy, 'assertSendable').mockRejectedValueOnce(
            new RecipientSuppressed([{ path: 'to', message: 'unsubscribed' }]),
        );
        expect(await send.deliver(workspace, id, noWait, at)).toBe('failed');
        expect((await read(admin, id)).canRetry).toBe(false);
        const res = await as(admin).post(w(`/mail/messages/${id}/retry`));
        expect(res.status).toBe(409);
        expect((res.body as { code: string }).code).toBe('send.not_retryable');
    });

    it('#134 only the sender or an admin may retry; a reader gets 403, another workspace 404', async () => {
        const id = await failedNow('Retry permissions', danaId);
        expect((await read(member, id)).canRetry).toBe(false);
        expect((await as(member).post(w(`/mail/messages/${id}/retry`))).status).toBe(403);
        expect((await read(admin, id)).status).toBe('failed');
        expect((await as(otherAdmin).post(w(`/mail/messages/${id}/retry`, otherWorkspace))).status).toBe(404);
    });

    it('#134 a send that is not failed is not retried: 409', async () => {
        const id = await schedule('Not failed', danaId);
        const res = await as(admin).post(w(`/mail/messages/${id}/retry`));
        expect(res.status).toBe(409);
    });

    it('#134 what was written is kept while a send can still go, and wiped once it is sent or cancelled', async () => {
        const kept = await failedNow('Kept until sent', danaId);
        const stored = async (id: string) =>
            (await owner.mailOutbound.findUniqueOrThrow({ where: { id }, select: { request: true } })).request;
        expect(await stored(kept)).not.toBeNull();
        await as(admin)
            .post(w(`/mail/messages/${kept}/retry`))
            .expect(200);
        expect(await send.deliver(workspace, kept, noWait)).toBe('sent');
        expect(await stored(kept)).toBeNull();

        const cancelled = await schedule('Kept until cancelled', danaId);
        expect(await stored(cancelled)).not.toBeNull();
        await as(admin)
            .post(w(`/mail/messages/${cancelled}/cancel`))
            .expect(200);
        expect(await stored(cancelled)).toBeNull();
    });

    it('#147 a member who sent mail is removed: their sends keep their name, their access ends at once, another workspace cannot remove them', async () => {
        const members = (await as(admin).get(w('/members'))).body as { id: string; email: string }[];
        const repId = members.find((m) => m.email === repEmail)!.id;
        const owned = await as(admin)
            .post(w('/people'))
            .send({
                nameFirst: 'Owned',
                nameLast: 'By rep',
                ownerId: repId,
                source: 'test list',
                emails: { primary: `owned-by-rep-${stamp}@example.com`, additional: [] },
            });
        expect(owned.status, JSON.stringify(owned.body)).toBe(201);
        const id = await schedule('By the rep', (owned.body as { id: string }).id, { who: rep });

        expect((await as(otherAdmin).delete(w(`/members/${repId}`, otherWorkspace))).status).toBe(404);
        await as(admin)
            .delete(w(`/members/${repId}`))
            .expect(204);

        const listed = (await as(admin).get(w('/members'))).body as { id: string }[];
        expect(listed.some((m) => m.id === repId)).toBe(false);
        const summary = (await as(admin).get(w('/members/summary'))).body as {
            memberId: string;
            leftAt: string | null;
        }[];
        expect(summary.find((m) => m.memberId === repId)).toMatchObject({ leftAt: expect.any(String) });
        // The send stands, and is still theirs.
        const detail = await as(admin).get(w(`/mail/messages/${id}`));
        expect(detail.status).toBe(200);
        expect((detail.body as Outbound).senderMemberId).toBe(repId);
        // Their session is dead, and the workspace refuses them from the next request.
        expect((await http().get('/api/me').set('Cookie', rep.cookie)).status).toBe(401);
        expect([401, 403]).toContain((await as(rep).get(w('/people'))).status);
        // Removing them again, or changing their role, finds nobody.
        expect((await as(admin).delete(w(`/members/${repId}`))).status).toBe(404);
    });
});
