import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_READONLY_SCOPE,
    GMAIL_SCOPES,
    SESSION_COOKIE,
    SYSTEM_ROLES,
    type RichText,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MailboxTokens } from '../../src/mail-accounts/mailbox-tokens.service';
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

interface ServiceMessage {
    id: string;
    from: string;
    subject: string;
    text: string;
    sentAt: string;
    storedAt: string;
}
interface LinkedEvent {
    type: string;
    recordId: string;
    link?: { personId: string };
}

const DAY = 24 * 60 * 60 * 1000;
const body = (text: string): RichText =>
    ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }) as RichText;

/**
 * Service inboxes (SVC-1, owner 2026-10-24): a shared address — media@, pr@ — synced so NewswireOS can read what
 * partners send it, and nothing else. Only an admin connects one, with Gmail's read scope alone. Its mail is matched to
 * no person and filed on no record — until a member's mailbox holds the same message — and it never sends. An
 * integration key reads what service inboxes hold (bodies included, never a personal mailbox's mail), and how much
 * each sender sent on a day: mail already sent, so a scheduled send is left out until its time.
 */
describe('service inboxes', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let sync: MailSyncService;
    let log: EventLog;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const adminEmail = `svc-admin-${stamp}@example.com`;
    const memberEmail = `svc-member-${stamp}@example.com`;
    const otherEmail = `svc-other-${stamp}@example.com`;
    const mediaEmail = `media-${stamp}@example.com`;
    const partner = `support-${stamp}@korewire.example`;
    const dana = `dana-${stamp}@acme.example`;

    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let adminMailbox: string;
    let serviceMailbox: string;
    let danaId: string;
    let serviceKey: string;
    let countsKey: string;
    let bareKey: string;
    let otherKey: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const withKey = (key: string, path: string, ws = workspace) =>
        http().get(w(path, ws)).set('Authorization', `Bearer ${key}`);
    const noWait = { sleep: () => Promise.resolve() };
    const linked = async () => {
        await settle(app);
        return (await log.read()) as unknown as LinkedEvent[];
    };

    async function startConnect(who: Browser, ws: string, purpose: string): Promise<Response> {
        return as(who).post(w('/mailboxes/connect', ws)).send({ purpose });
    }

    async function connect(
        who: Browser,
        ws: string,
        purpose: 'personal' | 'service',
        email: string,
        scopes: readonly string[],
    ): Promise<string> {
        const start = await startConnect(who, ws, purpose);
        expect(start.status).toBe(201);
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email,
            scopes: [...scopes],
        });
        const callback = await as(who).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        expect(new URL(String(callback.headers['location'])).searchParams.get('connect')).toBe('connected');
        const list = await as(who).get(w('/mailboxes', ws));
        return (list.body as { id: string; email: string }[]).find((m) => m.email === email)!.id;
    }

    async function keyWith(who: Browser, ws: string, name: string, capabilities: string[]): Promise<string> {
        const role = await as(who)
            .post(w('/roles', ws))
            .send({ name: `${name} ${stamp}`, recordScope: 'all', capabilities });
        expect(role.status, JSON.stringify(role.body)).toBe(201);
        const key = await as(who)
            .post(w('/api-keys', ws))
            .send({ name: `${name}-${stamp}`, roleId: (role.body as { id: string }).id });
        expect(key.status).toBe(201);
        return (key.body as { secret: string }).secret;
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
        sync = app.get(MailSyncService);
        log = await eventLog(app, 'email.linked');

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Service ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other service ${stamp}`));

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
            const clientId = `333-${tag}${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
            const secret = `GOCSPX-${tag}-${stamp}`;
            const view = await as(who).get(w('/mail/oauth-client', ws));
            google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
            const put = await http()
                .put(w('/mail/oauth-client', ws))
                .set('Cookie', who.cookie)
                .set(CSRF_HEADER, who.csrf)
                .send({ clientId, clientSecret: secret });
            expect(put.status).toBe(200);
        }
        adminMailbox = await connect(admin, workspace, 'personal', adminEmail, GMAIL_SCOPES);
        serviceMailbox = await connect(admin, workspace, 'service', mediaEmail, [GMAIL_READONLY_SCOPE]);

        const person = await as(admin)
            .post(w('/people'))
            .send({ nameFirst: 'Dana', nameLast: 'Reyes', emails: { primary: dana, additional: [] } });
        expect(person.status).toBe(201);
        danaId = (person.body as { id: string }).id;

        serviceKey = await keyWith(admin, workspace, 'newswireos', ['mail:service_read']);
        countsKey = await keyWith(admin, workspace, 'kpis', ['mail:sent_counts']);
        bareKey = await keyWith(admin, workspace, 'nothing', ['record:read']);
        otherKey = await keyWith(otherAdmin, otherWorkspace, 'other', ['mail:service_read', 'mail:sent_counts']);
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('connecting one', () => {
        it('SVC-1: only an admin starts a service-inbox connect, and Google is asked to let it read mail, nothing more', async () => {
            expect((await startConnect(member, workspace, 'service')).status).toBe(403);
            const start = await startConnect(admin, workspace, 'service');
            expect(start.status).toBe(201);
            const scopes = new URL((start.body as { authorizeUrl: string }).authorizeUrl).searchParams.get('scope');
            expect(scopes?.split(' ')).toEqual([GMAIL_READONLY_SCOPE]);
        });

        it('SVC-1: a service inbox stays connected through a token refresh and a check — reading is all it was granted, and all it needs (PNW-960)', async () => {
            // Production, 2026-10-25: both service inboxes went to reconnect_needed on their first refresh, because the
            // refresh held every mailbox to a personal mailbox's send scope, and partner mail stopped reaching NewswireOS.
            await app.get(PrismaService)
                .$executeRaw`UPDATE mailboxes SET access_expires_at = now() - interval '1 minute' WHERE id = ${serviceMailbox}::uuid`;
            await expect(app.get(MailboxTokens).getAccessToken(workspace, serviceMailbox)).resolves.toEqual(
                expect.any(String),
            );
            const check = await as(admin).post(w(`/mailboxes/${serviceMailbox}/check`));
            expect(check.body).toMatchObject({ ok: true, problem: null, mailbox: { status: 'connected' } });
        });

        it('SVC-1: a service inbox whose read scope is withdrawn does need reconnecting (PNW-960)', async () => {
            const email = `pr-${stamp}@example.com`;
            const id = await connect(admin, workspace, 'service', email, [GMAIL_READONLY_SCOPE]);
            google.narrowGrantFor(email, []);
            const check = await as(admin).post(w(`/mailboxes/${id}/check`));
            expect(check.body).toMatchObject({
                ok: false,
                problem: 'scope_missing',
                mailbox: { status: 'reconnect_needed' },
            });
        });

        it('SVC-1: a service inbox never sends', async () => {
            const res = await as(admin)
                .post(w('/mail/send'))
                .send({ mailboxId: serviceMailbox, personId: danaId, subject: 's', body: body('b') });
            expect(res.status).toBe(403);
            expect((res.body as { message: string }).message).toMatch(/service inbox/);
        });
    });

    describe('its mail is on no record', () => {
        it('SVC-1: what only a service inbox holds is matched to no person, even one the CRM knows', async () => {
            gmail.deliver(mediaEmail, {
                from: dana,
                to: [mediaEmail],
                subject: 'Only media@ has this',
                text: 'For the desk.',
                date: new Date(Date.now() - DAY),
                messageIdHeader: `only-media-${stamp}@acme.example`,
            });
            await sync.syncMailbox(workspace, serviceMailbox, noWait);
            const threads = await as(admin).get(w(`/mail/threads?target=person:${danaId}`));
            expect(threads.status).toBe(200);
            expect((threads.body as { items: unknown[] }).items).toEqual([]);
            expect((await linked()).filter((e) => e.link?.personId === danaId)).toEqual([]);
        });

        it('SVC-1: a person created later is not matched to it either', async () => {
            const later = `later-${stamp}@acme.example`;
            gmail.deliver(mediaEmail, {
                from: later,
                to: [mediaEmail],
                subject: 'From someone not yet in the CRM',
                text: 'x',
                date: new Date(Date.now() - DAY),
            });
            await sync.syncMailbox(workspace, serviceMailbox, noWait);
            const created = await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Lee', nameLast: 'Later', emails: { primary: later, additional: [] } });
            expect(created.status).toBe(201);
            const id = (created.body as { id: string }).id;
            await settle(app);
            const threads = await as(admin).get(w(`/mail/threads?target=person:${id}`));
            expect((threads.body as { items: unknown[] }).items).toEqual([]);
        });

        it('SVC-1: once a member’s mailbox holds the same message, it is on the person’s record', async () => {
            gmail.deliver(mediaEmail, {
                from: dana,
                to: [mediaEmail, adminEmail],
                subject: 'Copied to the admin',
                text: 'Both of you.',
                date: new Date(Date.now() - DAY),
                messageIdHeader: `both-${stamp}@acme.example`,
            });
            await sync.syncMailbox(workspace, serviceMailbox, noWait);
            let threads = await as(admin).get(w(`/mail/threads?target=person:${danaId}`));
            expect((threads.body as { items: unknown[] }).items).toEqual([]);

            gmail.deliver(adminEmail, {
                from: dana,
                to: [mediaEmail, adminEmail],
                subject: 'Copied to the admin',
                text: 'Both of you.',
                date: new Date(Date.now() - DAY),
                messageIdHeader: `both-${stamp}@acme.example`,
            });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            threads = await as(admin).get(w(`/mail/threads?target=person:${danaId}`));
            const items = (threads.body as { items: { subject: string }[] }).items;
            expect(items.map((t) => t.subject)).toEqual(['Copied to the admin']);
            expect((await linked()).filter((e) => e.link?.personId === danaId)).toHaveLength(1);
        });
    });

    describe('what an integration reads', () => {
        let sinceStart: Date;

        beforeAll(async () => {
            sinceStart = new Date(Date.now() - 60_000);
            gmail.deliver(mediaEmail, {
                from: partner,
                to: [mediaEmail],
                subject: 'Your release is live',
                text: 'https://partner.example/release/1',
                date: new Date(Date.now() - 2 * DAY),
            });
            gmail.deliver(adminEmail, {
                from: partner,
                to: [adminEmail],
                subject: 'Sent to the admin alone',
                text: 'personal',
                date: new Date(Date.now() - 2 * DAY),
            });
            await sync.syncMailbox(workspace, serviceMailbox, noWait);
            await sync.syncMailbox(workspace, adminMailbox, noWait);
        });

        it('SVC-1: a key with mail:service_read reads what service inboxes hold, bodies included — never a personal mailbox’s mail', async () => {
            const res = await withKey(
                serviceKey,
                `/integrations/mail/service-messages?from=${encodeURIComponent(partner)}&since=${sinceStart.toISOString()}`,
            );
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const items = (res.body as { items: ServiceMessage[] }).items;
            expect(items.map((m) => [m.from, m.subject, m.text])).toEqual([
                [partner, 'Your release is live', 'https://partner.example/release/1'],
            ]);
        });

        it('SVC-1: the page is in the order the CRM stored mail, and continues from its cursor', async () => {
            const first = await withKey(
                serviceKey,
                `/integrations/mail/service-messages?since=${new Date(0).toISOString()}&limit=1`,
            );
            const page = first.body as { items: ServiceMessage[]; nextCursor: string | null };
            expect(page.items).toHaveLength(1);
            expect(page.nextCursor).not.toBeNull();
            const next = await withKey(
                serviceKey,
                `/integrations/mail/service-messages?since=${new Date(0).toISOString()}&limit=1&cursor=${page.nextCursor}`,
            );
            const second = (next.body as { items: ServiceMessage[] }).items;
            expect(second[0]!.storedAt >= page.items[0]!.storedAt).toBe(true);
            expect(second[0]!.id).not.toBe(page.items[0]!.id);
        });

        it('SVC-1: a key without the capability is refused; another workspace’s key sees none of it', async () => {
            const path = `/integrations/mail/service-messages?since=${new Date(0).toISOString()}`;
            expect((await withKey(bareKey, path)).status).toBe(403);
            expect((await withKey(countsKey, path)).status).toBe(403);
            const other = await withKey(otherKey, path, otherWorkspace);
            expect(other.status).toBe(200);
            expect((other.body as { items: unknown[] }).items).toEqual([]);
            expect((await withKey(otherKey, path, workspace)).status).toBeGreaterThanOrEqual(401);
        });
    });

    describe('sent mail per day', () => {
        const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

        beforeAll(async () => {
            const yesterday = new Date(`${day(-1)}T10:00:00.000Z`);
            for (const [i, at] of [yesterday, new Date(yesterday.getTime() + 3600_000)].entries()) {
                gmail.deliver(adminEmail, {
                    from: adminEmail,
                    to: [dana],
                    subject: `Sent ${i}`,
                    text: 'x',
                    date: at,
                    labels: ['SENT'],
                });
            }
            // Scheduled in Gmail for tomorrow: stored now, stamped with the time it will go.
            gmail.deliver(adminEmail, {
                from: adminEmail,
                to: [dana],
                subject: 'Scheduled',
                text: 'x',
                date: new Date(`${day(1)}T09:00:00.000Z`),
                labels: ['SENT'],
            });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
        });

        it('SVC-1: counts what each sender sent on a day — counts only, the day closed', async () => {
            const res = await withKey(countsKey, `/integrations/mail/sent-counts?from=${adminEmail}&day=${day(-1)}`);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toMatchObject({
                day: day(-1),
                complete: true,
                senders: [{ address: adminEmail, count: 2 }],
            });
            // Counts only — the audiences are counts too (PNW-926), never an address or a body.
            expect(Object.keys((res.body as { senders: object[] }).senders[0]!).sort()).toEqual([
                'address',
                'count',
                'customers',
                'lastSentAt',
                'prospects',
            ]);
        });

        it('SVC-1: a scheduled send is not counted before its time', async () => {
            const res = await withKey(countsKey, `/integrations/mail/sent-counts?from=${adminEmail}&day=${day(1)}`);
            expect(res.body).toMatchObject({ day: day(1), complete: false, senders: [] });
        });

        it('SVC-1: counting needs mail:sent_counts', async () => {
            const path = `/integrations/mail/sent-counts?from=${adminEmail}&day=${day(-1)}`;
            expect((await withKey(serviceKey, path)).status).toBe(403);
            expect((await withKey(bareKey, path)).status).toBe(403);
        });
    });
    /**
     * PNW-926 (owner 2026-10-25): an account manager's mail to customers and to leads/prospects are different KPIs —
     * how many customers they talk to, and how many prospects they are trying to convert. Each sent message is counted
     * by its recipients: a customer is a live outreach exclusion (a NewswireOS client, a won deal — by address or by
     * domain) or a person whose contact status is Customer; a prospect is any other person in the CRM; colleagues and
     * addresses the CRM does not know are neither. Per audience, the messages and the distinct people they reached.
     */
    describe('sent mail by audience', () => {
        const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
        const kim = `kim-${stamp}@buyer.example`;
        const lee = `lee-${stamp}@prospect.example`;
        const custDomain = `client-${stamp.replace(/[^a-z0-9]/g, '')}.example`;
        const buyer = `buyer@${custDomain}`;
        const stranger = `stranger-${stamp}@nowhere.example`;

        beforeAll(async () => {
            const person = async (first: string, email: string) => {
                const res = await as(admin)
                    .post(w('/people'))
                    .send({ nameFirst: first, nameLast: 'Test', emails: { primary: email, additional: [] } });
                expect(res.status, JSON.stringify(res.body)).toBe(201);
                return (res.body as { id: string }).id;
            };
            const kimId = await person('Kim', kim);
            await person('Lee', lee);
            const status = await http()
                .put(w(`/people/${kimId}/contact-status`))
                .set('Cookie', admin.cookie)
                .set(CSRF_HEADER, admin.csrf)
                .send({ status: 'customer' });
            expect(status.status, JSON.stringify(status.body)).toBe(200);
            const exclusion = await as(admin)
                .post(w('/outreach/exclusions'))
                .send({ domain: custDomain, reason: 'account_managed' });
            expect(exclusion.status, JSON.stringify(exclusion.body)).toBe(201);

            const base = new Date(`${day(-2)}T08:00:00.000Z`).getTime();
            const sends: string[][] = [[kim], [buyer], [dana], [dana], [lee], [memberEmail], [stranger], [dana, kim]];
            for (const [i, to] of sends.entries()) {
                gmail.deliver(adminEmail, {
                    from: adminEmail,
                    to,
                    subject: `Audience ${i}`,
                    text: 'x',
                    date: new Date(base + i * 60_000),
                    labels: ['SENT'],
                });
            }
            await sync.syncMailbox(workspace, adminMailbox, noWait);
        });

        it('PNW-926: counts a day’s mail to customers and to prospects apart — messages and distinct people', async () => {
            const res = await withKey(countsKey, `/integrations/mail/sent-counts?from=${adminEmail}&day=${day(-2)}`);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toMatchObject({
                day: day(-2),
                through: day(-2),
                complete: true,
                senders: [
                    {
                        address: adminEmail,
                        count: 8,
                        // Kim by contact status, the buyer by the domain exclusion; one message reached both audiences.
                        customers: { messages: 3, people: 2 },
                        // Dana and Lee. The colleague and the stranger are neither.
                        prospects: { messages: 4, people: 2 },
                    },
                ],
            });
        });

        it('PNW-926: a range counts distinct people over the whole range, not per day added up', async () => {
            const res = await withKey(
                countsKey,
                `/integrations/mail/sent-counts?from=${adminEmail}&day=${day(-2)}&through=${day(-1)}`,
            );
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            // Yesterday's two messages went to Dana again: two more messages, no new person.
            expect(res.body).toMatchObject({
                day: day(-2),
                through: day(-1),
                complete: true,
                senders: [{ count: 10, customers: { messages: 3, people: 2 }, prospects: { messages: 6, people: 2 } }],
            });
        });

        it('PNW-926: a range ends on or after its first day, and spans at most 62 days', async () => {
            const back = await withKey(
                countsKey,
                `/integrations/mail/sent-counts?from=${adminEmail}&day=${day(-1)}&through=${day(-2)}`,
            );
            expect(back.status).toBe(400);
            const long = await withKey(
                countsKey,
                `/integrations/mail/sent-counts?from=${adminEmail}&day=${day(-70)}&through=${day(-1)}`,
            );
            expect(long.status).toBe(400);
        });
    });
});
