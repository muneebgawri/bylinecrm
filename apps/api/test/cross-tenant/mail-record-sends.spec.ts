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
 * shows them after a reload. Who sees a send is unchanged (its sender, or an admin), and only on a
 * record the caller can read: a record outside their scope, or another workspace's, is not found.
 */
describe('#104 a record’s sends', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let send: MailSendService;
    let policy: SendPolicy;
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

    it('#104 a send is its sender’s or an admin’s to see: a member sees none of the admin’s sends', async () => {
        const res = await list(member, `target=person:${danaId}&status=failed,scheduled`);
        expect(res.status).toBe(200);
        expect((res.body as SendsPage).items).toEqual([]);
        const repSends = ((await list(admin, `target=person:${wrenId}&status=scheduled`)).body as SendsPage).items;
        expect(repSends.length).toBeGreaterThan(0);
        // An admin sees a colleague's send, and whose it is.
        const members = (await as(admin).get(w('/members'))).body as { id: string; email: string }[];
        const repMember = members.find((m) => m.email === repEmail)!.id;
        expect(repSends.every((s) => s.senderMemberId === repMember)).toBe(true);
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
});
