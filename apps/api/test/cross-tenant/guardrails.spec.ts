import 'reflect-metadata';
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
    type RichText,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MailSendService } from '../../src/mail-send/mail-send.service';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { verifyAddress } from '../support/mail';
import { eventLog, settle, type EventLog } from '../support/outbox';
import { WebhookReceiver } from '../support/webhook-receiver';

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

interface ApiError {
    code: string;
    message: string;
    fieldErrors?: { path: string; message: string }[];
    details?: Record<string, string>;
}

const body: RichText = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] };

/**
 * The recipient guard (GUARD-1, #202): every send path asks it. An account manager cannot mail another
 * member's lead, a prospect another member is negotiating with, or a customer they do not own — at the request
 * and again at a scheduled send's time. A manager is let through and the attempt kept. Three blocks in a day tell
 * the reviewers; reviewers read the events and mark one legitimate. Exports hold the caller's own records unless
 * their role may export all.
 */
describe('GUARD-1 recipient guard (FR-CRMS-21)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let send: MailSendService;
    let announced: EventLog;
    let hooks: WebhookReceiver;
    let endpoint: string;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const emails = {
        admin: `guard-admin-${stamp}@example.com`,
        ana: `guard-ana-${stamp}@example.com`,
        ben: `guard-ben-${stamp}@example.com`,
        mia: `guard-mia-${stamp}@example.com`,
        other: `guard-other-${stamp}@example.com`,
    };
    let admin: Browser;
    let ana: Browser;
    let ben: Browser;
    let mia: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let anaId: string;
    let benId: string;
    let anaMailbox: string;
    let miaMailbox: string;
    let anaLead: string;
    let benLead: string;
    let benCompanyDomain: string;
    let customerLead: string;

    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const err = (res: Response) => res.body as ApiError;
    const lead = async (who: Browser, local: string, domain = `${local}-${stamp}.test`) =>
        (
            (
                await as(who)
                    .post(w('/people'))
                    .send({ nameFirst: local, emails: { primary: `${local}@${domain}`, additional: [] } })
                    .expect(201)
            ).body as { id: string }
        ).id;
    const mail = (who: Browser, mailboxId: string, personId: string, extra: Record<string, unknown> = {}) =>
        as(who)
            .post(w('/mail/send'))
            .send({ mailboxId, personId, subject: 'Hello', body, ...extra });
    const events = async (query = '') =>
        (
            (
                await as(mia)
                    .get(w(`/guardrails/events${query}`))
                    .expect(200)
            ).body as { items: GuardrailEventView[] }
        ).items;

    async function connect(who: Browser, email: string): Promise<string> {
        const start = await as(who).post(w('/mailboxes/connect')).send({ purpose: 'personal' });
        expect(start.status).toBe(201);
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email,
            scopes: [...GMAIL_SCOPES],
        });
        await as(who).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        const list = await as(who).get(w('/mailboxes'));
        return (list.body as { id: string; email: string }[]).find((m) => m.email === email)!.id;
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
        announced = await eventLog(app, 'guardrail.*');
        hooks = await new WebhookReceiver().start();

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, id: workspace } = await signUp(emails.admin, `Guard ${stamp}`));
        ({ browser: otherAdmin, id: otherWorkspace } = await signUp(emails.other, `Guard other ${stamp}`));

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
        anaId = members.find((m) => m.email === emails.ana)!.id;
        benId = members.find((m) => m.email === emails.ben)!.id;

        const clientId = `444-${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const secret = `GOCSPX-guard-${stamp}`;
        const view = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
        await as(admin).put(w('/mail/oauth-client')).send({ clientId, clientSecret: secret }).expect(200);
        anaMailbox = await connect(ana, emails.ana);
        miaMailbox = await connect(mia, emails.mia);

        anaLead = await lead(ana, 'lee');
        benLead = await lead(ben, 'bo');
        // Ben's company, with an open deal: in negotiation.
        benCompanyDomain = `benco-${stamp}.test`;
        const company = (
            (
                await as(ben)
                    .post(w('/companies'))
                    .send({ name: `Ben Co ${stamp}`, domain: benCompanyDomain })
                    .expect(201)
            ).body as { id: string }
        ).id;
        await as(ben)
            .post(w('/opportunities'))
            .send({ name: `Ben deal ${stamp}`, companyId: company })
            .expect(201);
        // A customer nobody in the CRM owns.
        customerLead = await lead(admin, 'cy', `cust-${stamp}.test`);
        await as(admin)
            .patch(w(`/people/${customerLead}`))
            .send({ ownerId: null })
            .expect(200);
        await as(admin)
            .post(w('/outreach/exclusions'))
            .send({ domain: `cust-${stamp}.test`, reason: 'customer', source: 'newswireos' })
            .expect(201);
    });

    afterAll(async () => {
        await app?.close();
        await hooks?.close();
    });

    it('lets a member mail their own lead', async () => {
        const res = await mail(ana, anaMailbox, anaLead);
        expect(res.status, JSON.stringify(res.body)).toBe(202);
    });

    it('refuses another member’s lead by name, sends nothing, and keeps the attempt', async () => {
        const before = await owner.mailOutbound.count({ where: { workspaceId: workspace } });
        const res = await mail(ana, anaMailbox, benLead);
        expect(res.status).toBe(422);
        expect(err(res).code).toBe('recipient.guarded');
        expect(err(res).details).toMatchObject({ reason: 'owned_by_other', ownerMemberId: benId });
        expect(err(res).message).toMatch(/introduce/);
        expect(await owner.mailOutbound.count({ where: { workspaceId: workspace } })).toBe(before);
        const [event] = await events(`?actorMemberId=${anaId}&kind=owned_by_other`);
        expect(event).toMatchObject({
            outcome: 'blocked',
            path: 'send',
            personId: benLead,
            owner: { memberId: benId },
        });
    });

    it('refuses a prospect another member is negotiating with, even as a cc', async () => {
        const res = await mail(ana, anaMailbox, anaLead, { cc: [{ address: `ceo@${benCompanyDomain}` }] });
        expect(res.status).toBe(422);
        expect(err(res).details?.reason).toBe('in_negotiation');
        expect(err(res).fieldErrors?.[0]?.path).toBe('cc');
    });

    it('refuses a customer on the exclusions to a member who does not own them (FR-CRMS-10 for 1:1 mail)', async () => {
        const res = await mail(ana, anaMailbox, customerLead);
        expect(res.status).toBe(422);
        expect(err(res).details?.reason).toBe('excluded_customer');
    });

    it('after three blocks in a day, tells the reviewers (a manager and the admin) once — not the member', async () => {
        const notified = async (who: Browser) =>
            ((await as(who).get(w('/notifications')).expect(200)).body as NotificationsView).items.filter(
                (n) => n.kind === 'guardrail_repeat_blocks',
            );
        // Two owned blocks so far (owned_by_other, in_negotiation); the third tips it, a fourth adds nothing.
        expect((await mail(ana, anaMailbox, benLead)).status).toBe(422);
        expect((await mail(ana, anaMailbox, benLead)).status).toBe(422);
        const theirs = await notified(mia);
        expect(theirs).toHaveLength(1);
        expect(theirs[0]!.guardrail).toMatchObject({ kind: 'repeat_blocks', actor: { memberId: anaId } });
        expect(theirs[0]!.guardrail!.count).toBeGreaterThanOrEqual(3);
        expect(await notified(admin)).toHaveLength(1);
        expect(await notified(ana)).toHaveLength(0);
        const [tally] = await events('?kind=repeat_blocks');
        expect(tally).toMatchObject({ severity: 'high', actor: { memberId: anaId } });
    });

    it('lets a manager through and keeps the attempt as allowed', async () => {
        const res = await mail(mia, miaMailbox, benLead);
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        const [event] = await events('?outcome=allowed');
        expect(event).toMatchObject({ kind: 'owned_by_other', personId: benLead });
    });

    it('checks a scheduled send again at its time: a lead that changed hands meanwhile is not sent', async () => {
        const later = await lead(ana, 'sam');
        const res = await mail(ana, anaMailbox, later, { sendAt: new Date(Date.now() + 3_600_000).toISOString() });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        const id = (res.body as { messageId: string }).messageId;
        await as(mia)
            .patch(w(`/people/${later}`))
            .send({ ownerId: benId })
            .expect(200);
        await owner.mailOutbound.update({ where: { id }, data: { sendAt: new Date() } });
        await send.deliver(workspace, id, { sleep: () => Promise.resolve() });
        const row = await owner.mailOutbound.findUniqueOrThrow({ where: { id } });
        expect(row.status).toBe('failed');
        expect((row.lastError as { code: string }).code).toBe('recipient.guarded');
        const [event] = await events(`?actorMemberId=${anaId}`);
        expect(event).toMatchObject({ path: 'scheduled_send', personId: later });
    });

    it('is for reviewers only: a member is refused, a manager marks an event legitimate once', async () => {
        expect((await as(ana).get(w('/guardrails/events'))).status).toBe(403);
        const [event] = await events(`?actorMemberId=${anaId}&reviewed=false`);
        const marked = await as(mia)
            .post(w(`/guardrails/events/${event!.id}/legitimate`))
            .send({ reason: 'Ben asked Ana to follow up while away' })
            .expect(201);
        expect((marked.body as GuardrailEventView).legitimate).toMatchObject({
            reason: 'Ben asked Ana to follow up while away',
        });
        expect(
            (
                await as(mia)
                    .post(w(`/guardrails/events/${event!.id}/legitimate`))
                    .send({ reason: 'again' })
            ).status,
        ).toBe(409);
        expect((await events('?reviewed=true')).map((e) => e.id)).toContain(event!.id);
    });

    it('never shows one workspace’s events to another', async () => {
        const res = await as(otherAdmin).get(w('/guardrails/events', otherWorkspace)).expect(200);
        expect((res.body as { items: GuardrailEventView[] }).items).toHaveLength(0);
        expect([403, 404]).toContain((await as(otherAdmin).get(w('/guardrails/events'))).status);
    });

    it('exports a member’s own records only; a manager exports all', async () => {
        const anaCsv = (await as(ana).get(w('/people/export.csv')).expect(200)).text;
        expect(anaCsv).toContain(`lee@lee-${stamp}.test`);
        expect(anaCsv).not.toContain(`bo@bo-${stamp}.test`);
        const miaCsv = (await as(mia).get(w('/people/export.csv')).expect(200)).text;
        expect(miaCsv).toContain(`bo@bo-${stamp}.test`);
        expect(miaCsv).toContain(`lee@lee-${stamp}.test`);
    });

    it('GUARD-1b: audits every export — who, which object, how many rows, own or all — for reviewers', async () => {
        await as(ana).get(w('/people/export.csv')).expect(200);
        const [audit] = await events(`?kind=record_export&actorMemberId=${anaId}`);
        expect(audit).toMatchObject({ outcome: 'allowed', path: 'export', actor: { memberId: anaId } });
        expect(audit!.message).toMatch(/^Exported \d+ people \(their own records\)$/);
        await as(mia).get(w('/companies/export.csv')).expect(200);
        const [all] = await events('?kind=record_export');
        expect(all!.message).toMatch(/companies \(all records\)$/);
    });

    it('GUARD-1b: announces each guardrail event as guardrail.recorded, by ids, to webhooks', async () => {
        const created = await as(admin)
            .post(w('/webhooks'))
            .send({ url: hooks.url('/guard-hook'), events: ['guardrail.recorded'] })
            .expect(201);
        endpoint =
            (created.body as { endpoint?: { id: string }; id?: string }).endpoint?.id ??
            (created.body as { id: string }).id;
        await announced.reset();
        expect((await mail(ana, anaMailbox, benLead)).status).toBe(422);
        const [event] = await events(`?actorMemberId=${anaId}&kind=owned_by_other`);
        const recorded = (await announced.read()).filter((e) => e.recordId === event!.id);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
            type: 'guardrail.recorded',
            object: 'guardrail',
            workspaceId: workspace,
            actor: { kind: 'member', id: anaId },
            guardrail: {
                kind: 'owned_by_other',
                outcome: 'blocked',
                path: 'send',
                actorMemberId: anaId,
                ownerMemberId: benId,
                personId: benLead,
            },
        });
        // Ids, addresses and the guard's words — never the message the member wrote.
        expect(JSON.stringify(recorded[0])).not.toContain('Hi');
        await settle(app);
        const deliveries = await owner.webhookDelivery.count({
            where: { endpointId: endpoint, eventName: 'guardrail.recorded' },
        });
        expect(deliveries).toBeGreaterThanOrEqual(1);
    });
});
