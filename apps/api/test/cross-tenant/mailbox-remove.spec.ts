import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, GMAIL_SCOPES, SESSION_COOKIE, SYSTEM_ROLES } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { MailSyncService } from '../../src/mail-sync/mail-sync.service';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { eventLog, type EventLog } from '../support/outbox';
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

/**
 * Removing a mailbox (#385): it is disconnected if it still is, then deleted with the mail only it held — the copies,
 * the message, its participants and timeline entries, its outbound records — while mail another mailbox also holds
 * stays on its records. Only its owner or an admin may; announced as `mailbox.removed`.
 */
describe('mailbox removal: the mailbox goes with the mail only it held', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let sync: MailSyncService;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let member: Browser;
    let workspace: string;
    const adminEmail = `rm-admin-${stamp}@example.com`;
    const memberEmail = `rm-member-${stamp}@example.com`;
    const dana = `dana-${stamp}@acme.example`;
    let adminMailbox: string;
    let memberMailbox: string;
    let danaId: string;
    let log: EventLog;
    const noWait = { sleep: () => Promise.resolve() };

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;

    async function connect(who: Browser, email: string): Promise<string> {
        const start = await as(who).post(w('/mailboxes/connect')).send({ purpose: 'personal' });
        expect(start.status).toBe(201);
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email,
            scopes: [...GMAIL_SCOPES],
        });
        await as(who).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        const list = await as(admin).get(w('/mailboxes'));
        return (list.body as { id: string; email: string }[]).find((m) => m.email === email)!.id;
    }
    const subjectsOn = async (personId: string) =>
        (
            await owner.timelineActivity.findMany({
                where: { targetType: 'person', targetId: personId, kind: { startsWith: 'linked-email.' } },
                select: { properties: true },
            })
        )
            .map((t) => (t.properties as { email?: { subject?: string } }).email?.subject ?? '')
            .sort();

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
        sync = app.get(MailSyncService);

        const signUp = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Remove ${stamp}` });
        expect(signUp.status).toBe(201);
        await verifyAddress(app, http, adminEmail);
        admin = browserFrom(signUp);
        workspace = (signUp.body as { workspace: { id: string } }).workspace.id;
        log = await eventLog(app, 'mailbox.*');

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

        const clientId = `333-${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const secret = `GOCSPX-rm-${stamp}`;
        const view = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
        const put = await http()
            .put(w('/mail/oauth-client'))
            .set('Cookie', admin.cookie)
            .set(CSRF_HEADER, admin.csrf)
            .send({ clientId, clientSecret: secret });
        expect(put.status).toBe(200);
        adminMailbox = await connect(admin, adminEmail);
        memberMailbox = await connect(member, memberEmail);

        const person = await as(admin)
            .post(w('/people'))
            .send({ nameFirst: 'Dana', nameLast: 'Reyes', emails: { primary: dana, additional: [] } });
        expect(person.status).toBe(201);
        danaId = (person.body as { id: string }).id;

        // Dana wrote to the admin alone (`Only here`), and to both (`Both hold`: one message, two copies).
        gmail.deliver(adminEmail, { from: dana, to: [adminEmail], subject: `Only here ${stamp}`, text: 'o' });
        const both = {
            from: dana,
            to: [adminEmail, memberEmail],
            subject: `Both hold ${stamp}`,
            text: 'b',
            messageIdHeader: `<both-${stamp}@acme.example>`,
        };
        gmail.deliver(adminEmail, both);
        gmail.deliver(memberEmail, both);
        await sync.syncMailbox(workspace, adminMailbox, noWait);
        await sync.syncMailbox(workspace, memberMailbox, noWait);
    });

    afterAll(async () => {
        await app.close();
    });

    it('starts with both messages on Dana, two copies of the shared one', async () => {
        expect(await subjectsOn(danaId)).toEqual([`Both hold ${stamp}`, `Only here ${stamp}`]);
        expect(await owner.mailMessageCopy.count({ where: { mailboxId: adminMailbox } })).toBe(2);
        expect(await owner.mailMessageCopy.count({ where: { mailboxId: memberMailbox } })).toBe(1);
    });

    it("a member cannot remove another's mailbox: not theirs to see", async () => {
        const res = await as(member).post(w(`/mailboxes/${adminMailbox}/remove`));
        expect(res.status).toBe(404);
        expect(await owner.mailbox.count({ where: { id: adminMailbox } })).toBe(1);
    });

    it('removes the mailbox and the mail only it held; the shared message stays on its records', async () => {
        await log.reset();
        const revokes = google.revokeCalls;
        const res = await as(admin).post(w(`/mailboxes/${adminMailbox}/remove`));
        expect(res.status).toBe(204);
        // Still connected, so the grant was given up first.
        expect(google.revokeCalls - revokes).toBe(1);
        expect(await owner.mailbox.count({ where: { id: adminMailbox } })).toBe(0);
        expect(await owner.mailMessageCopy.count({ where: { mailboxId: adminMailbox } })).toBe(0);
        expect(await owner.mailMessage.count({ where: { workspaceId: workspace } })).toBe(1);
        expect(await subjectsOn(danaId)).toEqual([`Both hold ${stamp}`]);
        const list = await as(admin).get(w('/mailboxes'));
        expect((list.body as { id: string }[]).map((m) => m.id)).toEqual([memberMailbox]);
        const types = (await log.read()).map((e) => e.type);
        expect(types).toContain('mailbox.disconnected');
        expect(types).toContain('mailbox.removed');
    });

    it('a removed mailbox is gone: removing it again is not found', async () => {
        expect((await as(admin).post(w(`/mailboxes/${adminMailbox}/remove`))).status).toBe(404);
    });
});
