import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_SCOPES,
    SESSION_COOKIE,
    SYSTEM_ROLES,
    type GuardrailEventView,
    type NotificationsView,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { MessageHeaders } from '../../src/relay/headers';
import { CRM_SEND_HEADER, RelayJudge } from '../../src/relay/relay-judge';
import { RelayModule } from '../../src/relay/relay.module';
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

/**
 * GUARD-4 (#355): what the relay's judge decides for a rep's Gmail message, over a real workspace — the sender's
 * mailbox names the workspace; their own lead passes; a colleague's lead and a stranger bounce, as `blocked`
 * events on path `relay` that tell the owner and the reviewers; an answer to someone who wrote first passes;
 * nobody's mailbox is nobody's message.
 */
describe('GUARD-4 outbound relay judge', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let judge: RelayJudge;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const emails = {
        admin: `relay-admin-${stamp}@example.com`,
        ana: `relay-ana-${stamp}@example.com`,
        ben: `relay-ben-${stamp}@example.com`,
        mia: `relay-mia-${stamp}@example.com`,
    };
    let admin: Browser;
    let ana: Browser;
    let ben: Browser;
    let mia: Browser;
    let workspace: string;
    let benId: string;
    let anaLead: string;
    let benLead: string;
    const stranger = `new-${stamp}@stranger.test`;

    const w = (path: string) => `/api/w/${workspace}${path}`;
    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const lead = async (who: Browser, local: string) => {
        const address = `${local}@${local}-${stamp}.test`;
        await as(who)
            .post(w('/people'))
            .send({ nameFirst: local, emails: { primary: address, additional: [] } })
            .expect(201);
        return address;
    };
    const headers = (extra: Record<string, string> = {}) =>
        MessageHeaders.parse(
            Buffer.from(
                `From: ${emails.ana}\r\nSubject: Quick one\r\nMessage-ID: <${randomUUID()}@example.com>\r\n${Object.entries(
                    extra,
                )
                    .map(([k, v]) => `${k}: ${v}\r\n`)
                    .join('')}\r\nbody\r\n`,
            ),
        );
    const decide = (from: string, to: string[], extra?: Record<string, string>) =>
        judge.judge({ from, recipients: to, headers: headers(extra) });
    const events = async () =>
        ((await as(mia).get(w('/guardrails/events')).expect(200)).body as { items: GuardrailEventView[] }).items;

    async function connect(who: Browser, email: string): Promise<void> {
        const start = await as(who).post(w('/mailboxes/connect')).send({ purpose: 'personal' });
        expect(start.status).toBe(201);
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email,
            scopes: [...GMAIL_SCOPES],
        });
        await as(who).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
    }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule, RelayModule] })
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        judge = app.get(RelayJudge);

        const signUp = await http()
            .post('/api/auth/signup')
            .send({ email: emails.admin, password, workspaceName: `Relay ${stamp}` });
        expect(signUp.status).toBe(201);
        await verifyAddress(app, http, emails.admin);
        admin = browserFrom(signUp);
        workspace = (signUp.body as { workspace: { id: string } }).workspace.id;

        const roles = (await as(admin).get(w('/roles')).expect(200)).body as { id: string; name: string }[];
        const join = async (email: string, role: string) => {
            const invite = await as(admin)
                .post(w('/invites'))
                .send({ email, roleId: roles.find((r) => r.name === role)!.id })
                .expect(201);
            const joined = await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201);
            await verifyAddress(app, http, email);
            return browserFrom(joined);
        };
        ana = await join(emails.ana, SYSTEM_ROLES.member);
        ben = await join(emails.ben, SYSTEM_ROLES.member);
        mia = await join(emails.mia, SYSTEM_ROLES.manager);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        benId = members.find((m) => m.email === emails.ben)!.id;

        const clientId = `444-${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const secret = `GOCSPX-relay-${stamp}`;
        const view = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
        await as(admin).put(w('/mail/oauth-client')).send({ clientId, clientSecret: secret }).expect(200);
        await connect(ana, emails.ana);

        anaLead = await lead(ana, 'lee');
        benLead = await lead(ben, 'bo');
    });

    afterAll(async () => {
        await app?.close();
    });

    it("relays a rep's mail to their own lead and to a colleague, unjudged mail from the CRM, and nothing from a stranger's address", async () => {
        expect(await decide(emails.ana, [anaLead, emails.ben])).toMatchObject({
            kind: 'relay',
            workspaceId: workspace,
        });
        expect(await decide(emails.ana, [stranger], { [CRM_SEND_HEADER]: 'abc' })).toMatchObject({ kind: 'relay' });
        expect(await decide(`nobody-${stamp}@example.com`, [anaLead])).toEqual({ kind: 'unknown_sender' });
        expect(await events()).toEqual([]);
    });

    it("bounces a colleague's lead by name, records the block on path relay and tells the owner", async () => {
        const verdict = await decide(emails.ana, [benLead, anaLead]);
        expect(verdict.kind).toBe('refuse');
        if (verdict.kind !== 'refuse') return;
        expect(verdict.text).toContain(`${benLead}: relay-ben-${stamp}'s lead — ask them, or send from Byline CRM.`);
        expect(verdict.text).not.toContain(anaLead);
        await settle(app);
        const [event] = await events();
        expect(event).toMatchObject({ kind: 'poach_suspected', outcome: 'blocked', path: 'relay', address: benLead });
        const inbox = (await as(ben).get(w('/notifications')).expect(200)).body as NotificationsView;
        expect(inbox.items.map((n) => n.kind)).toContain('guardrail_poach_suspected');
        expect(benId).toBeTruthy();
    });

    it('bounces a stranger as cold mail — unless they wrote first in the thread the message answers', async () => {
        const cold = await decide(emails.ana, [stranger]);
        expect(cold).toMatchObject({
            kind: 'refuse',
            text: expect.stringContaining(`${stranger}: not one of your contacts`),
        });
        await settle(app);
        expect((await events()).map((e) => [e.kind, e.outcome, e.address])).toContainEqual([
            'off_crm_cold',
            'blocked',
            stranger,
        ]);

        // The stranger wrote in: sync stored their message. Ana's answer names it.
        const theirs = `<${randomUUID()}@stranger.test>`;
        const thread = (await owner.mailThread.create({ data: { workspaceId: workspace, lastMessageAt: new Date() } }))
            .id;
        await owner.mailMessage.create({
            data: {
                workspaceId: workspace,
                threadId: thread,
                identityKey: theirs,
                rfc822MessageId: theirs,
                direction: 'inbound',
                fromAddress: stranger,
                sentAt: new Date(Date.now() - 60_000),
                subject: 'Hello?',
                participants: {
                    create: { workspaceId: workspace, role: 'from', address: stranger, displayName: 'New' },
                },
            },
        });
        expect(await decide(emails.ana, [stranger], { 'In-Reply-To': theirs })).toMatchObject({ kind: 'relay' });
    });

    it('does not see another workspace: its mailbox at the same address is not this one', async () => {
        const other = await http()
            .post('/api/auth/signup')
            .send({ email: `relay-other-${stamp}@example.com`, password, workspaceName: `Relay other ${stamp}` });
        expect(other.status).toBe(201);
        const otherWorkspace = (other.body as { workspace: { id: string } }).workspace.id;
        expect(await owner.guardrailEvent.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
    });
});
