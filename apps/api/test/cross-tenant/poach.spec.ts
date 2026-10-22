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
    type GuardrailSettingsView,
    type MailboxCoverageView,
    type NotificationsView,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PoachDetector } from '../../src/guardrails/poach-detector';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { TaskNotificationsService } from '../../src/notifications/task-notifications.service';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { deliverMail, mailTo, verifyAddress } from '../support/mail';

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

const BODY = 'Secret pricing: we will beat your current vendor by forty percent.';

/**
 * GUARD-2 (#203, FR-CRMS-22): mail that left a member's mailbox (synced from Gmail, or sent from the CRM — both
 * stored by sync's one writer) to another member's lead or a customer is a `poach_suspected` event; the owner and
 * the reviewers are told — who, whom, when, subject, never the body — with a daily digest and, at high severity,
 * an email at once. History is not judged; repeats within the window tell once. One workspace never sees another's.
 */
describe('GUARD-2 poaching detection (FR-CRMS-22)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let detector: PoachDetector;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const emails = {
        admin: `poach-admin-${stamp}@example.com`,
        ana: `poach-ana-${stamp}@example.com`,
        ben: `poach-ben-${stamp}@example.com`,
        mia: `poach-mia-${stamp}@example.com`,
        outreach: `poach-outreach-${stamp}@example.com`,
        other: `poach-other-${stamp}@example.com`,
    };
    let admin: Browser;
    let ana: Browser;
    let ben: Browser;
    let mia: Browser;
    let outreach: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let anaId: string;
    let benId: string;
    let outreachId: string;
    const benCompanyDomain = `benco-${stamp}.test`;
    const benLeadAddress = `bo@bo-${stamp}.test`;
    let benLead: string;

    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const lead = async (who: Browser, address: string) =>
        (
            (
                await as(who)
                    .post(w('/people'))
                    .send({ nameFirst: address.split('@')[0], emails: { primary: address, additional: [] } })
                    .expect(201)
            ).body as { id: string }
        ).id;
    const poachEvents = async () =>
        (
            (await as(mia).get(w('/guardrails/events?kind=poach_suspected')).expect(200)).body as {
                items: GuardrailEventView[];
            }
        ).items;
    const bell = async (who: Browser) =>
        ((await as(who).get(w('/notifications')).expect(200)).body as NotificationsView).items.filter(
            (n) => n.kind === 'guardrail_poach_suspected',
        );

    /** A message as sync stores it: from a member, to `to`, in `threadId` (a new thread when not given). */
    async function synced(input: {
        to: string[];
        subject?: string;
        sentAt?: Date;
        threadId?: string;
        cc?: { address: string; memberId: string }[];
        workspaceId?: string;
        fromAddress?: string;
        fromMemberId?: string;
    }): Promise<{ id: string; threadId: string }> {
        const workspaceId = input.workspaceId ?? workspace;
        const sentAt = input.sentAt ?? new Date();
        const threadId =
            input.threadId ??
            (
                await owner.mailThread.create({
                    data: { workspaceId, subject: input.subject ?? '', lastMessageAt: sentAt },
                })
            ).id;
        const fromAddress = input.fromAddress ?? emails.ana;
        const row = await owner.mailMessage.create({
            data: {
                workspaceId,
                threadId,
                identityKey: `poach-${stamp}-${Math.random().toString(36).slice(2)}`,
                direction: 'outbound',
                fromAddress,
                sentAt,
                subject: input.subject ?? 'Quick intro',
                bodyText: BODY,
                participants: {
                    create: [
                        { workspaceId, role: 'from', address: fromAddress, memberId: input.fromMemberId ?? anaId },
                        ...input.to.map((address) => ({ workspaceId, role: 'to' as const, address })),
                        ...(input.cc ?? []).map((c) => ({ workspaceId, role: 'cc' as const, ...c })),
                    ],
                },
            },
        });
        return { id: row.id, threadId };
    }

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
        detector = app.get(PoachDetector);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, id: workspace } = await signUp(emails.admin, `Poach ${stamp}`));
        ({ browser: otherAdmin, id: otherWorkspace } = await signUp(emails.other, `Poach other ${stamp}`));

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
        outreach = await join(emails.outreach, SYSTEM_ROLES.member);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        anaId = members.find((m) => m.email === emails.ana)!.id;
        benId = members.find((m) => m.email === emails.ben)!.id;
        outreachId = members.find((m) => m.email === emails.outreach)!.id;

        const clientId = `445-${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const secret = `GOCSPX-poach-${stamp}`;
        const view = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
        await as(admin).put(w('/mail/oauth-client')).send({ clientId, clientSecret: secret }).expect(200);
        await connect(ana, emails.ana);

        benLead = await lead(ben, benLeadAddress);
        await as(ben)
            .post(w('/companies'))
            .send({ name: `Ben Co ${stamp}`, domain: benCompanyDomain })
            .expect(201);
        // A customer nobody owns, excluded because their deal was won (#242).
        await owner.outreachExclusion.create({
            data: { workspaceId: workspace, address: `cy@cust-${stamp}.test`, reason: 'customer', source: 'won_deal' },
        });
    });

    afterAll(async () => {
        await app?.close();
    });

    it('flags Gmail mail to another member’s lead, medium, and tells the owner and the reviewers — never the sender, never the body', async () => {
        const message = await synced({ to: [benLeadAddress], subject: 'Quick intro' });
        expect(await detector.judge(workspace, message.id)).toBe(1);
        const [event] = await poachEvents();
        expect(event).toMatchObject({
            kind: 'poach_suspected',
            outcome: 'warned',
            severity: 'medium',
            path: 'sync',
            actor: { memberId: anaId },
            owner: { memberId: benId },
            personId: benLead,
            address: benLeadAddress,
        });
        expect(event!.message).toContain('Quick intro');
        for (const who of [ben, mia, admin]) {
            const [n] = await bell(who);
            expect(n).toMatchObject({
                target: { type: 'guardrail', id: event!.id },
                guardrail: { subject: 'Quick intro', address: benLeadAddress, owner: { memberId: benId } },
            });
            expect(JSON.stringify(n)).not.toContain('Secret pricing');
        }
        expect(await bell(ana)).toHaveLength(0);
        // Delivered again, or a follow-up to the same lead within the window: nothing more.
        expect(await detector.judge(workspace, message.id)).toBe(0);
        expect(await detector.judge(workspace, (await synced({ to: [benLeadAddress] })).id)).toBe(0);
        expect(await poachEvents()).toHaveLength(1);
    });

    it('lets a reply through in a thread the owner is on', async () => {
        const other = await lead(ben, `pat@pat-${stamp}.test`);
        expect(other).toBeTruthy();
        const first = await synced({
            to: [`pat@pat-${stamp}.test`],
            fromAddress: emails.ben,
            fromMemberId: benId,
            cc: [{ address: emails.ana, memberId: anaId }],
        });
        const reply = await synced({ to: [`pat@pat-${stamp}.test`], threadId: first.threadId });
        expect(await detector.judge(workspace, reply.id)).toBe(0);
    });

    it('matches a company domain another member owns; never free mail, never the workspace’s own domain', async () => {
        expect(await detector.judge(workspace, (await synced({ to: [`ceo@${benCompanyDomain}`] })).id)).toBe(1);
        expect(await detector.judge(workspace, (await synced({ to: [`someone-${stamp}@gmail.com`] })).id)).toBe(0);
        expect(await detector.judge(workspace, (await synced({ to: [`colleague-${stamp}@example.com`] })).id)).toBe(0);
    });

    it('flags a won-deal customer on the exclusions; the third lead in 7 days is high, and no one is emailed', async () => {
        const before = mailTo(emails.mia, 'guardrail_alert').length;
        expect(
            await detector.judge(workspace, (await synced({ to: [`cy@cust-${stamp}.test`], subject: 'Renewal' })).id),
        ).toBe(1);
        const [event] = await poachEvents();
        expect(event).toMatchObject({ address: `cy@cust-${stamp}.test`, owner: null, severity: 'high' });
        expect(event!.message).toContain('won_deal');
        await deliverMail(app);
        expect(mailTo(emails.mia, 'guardrail_alert')).toHaveLength(before);
        expect(mailTo(emails.ana, 'guardrail_alert')).toHaveLength(0);
    });

    it('emails a high alert at once only when an admin turned it on (Settings → Guardrails)', async () => {
        const settings = async (who: Browser) =>
            (await as(who).get(w('/guardrails/settings')).expect(200)).body as GuardrailSettingsView;
        expect(await settings(mia)).toEqual({ poachEmailAtOnce: false, sharedMailboxMemberIds: [] });
        expect(
            (await as(mia).put(w('/guardrails/settings')).send({ poachEmailAtOnce: true, sharedMailboxMemberIds: [] }))
                .status,
        ).toBe(403);
        await as(admin)
            .put(w('/guardrails/settings'))
            .send({ poachEmailAtOnce: true, sharedMailboxMemberIds: [] })
            .expect(200);
        expect((await settings(mia)).poachEmailAtOnce).toBe(true);

        const before = mailTo(emails.mia, 'guardrail_alert').length;
        await owner.outreachExclusion.create({
            data: { workspaceId: workspace, address: `cz@cust-${stamp}.test`, reason: 'customer', source: 'won_deal' },
        });
        expect(
            await detector.judge(workspace, (await synced({ to: [`cz@cust-${stamp}.test`], subject: 'Upsell' })).id),
        ).toBe(1);
        await deliverMail(app);
        const alerts = mailTo(emails.mia, 'guardrail_alert');
        expect(alerts).toHaveLength(before + 1);
        expect(alerts.at(-1)!.text).toContain('Upsell');
        expect(alerts.at(-1)!.text).not.toContain('Secret pricing');
        expect(mailTo(emails.ana, 'guardrail_alert')).toHaveLength(0);
        await as(admin)
            .put(w('/guardrails/settings'))
            .send({ poachEmailAtOnce: false, sharedMailboxMemberIds: [] })
            .expect(200);
    });

    it('treats a lead a shared mailbox owns as nobody’s: no alert; its ownership stands', async () => {
        const pooled = await lead(outreach, `pooled@pooled-${stamp}.test`);
        // Shared mailboxes must be members of this workspace.
        expect(
            (
                await as(admin)
                    .put(w('/guardrails/settings'))
                    .send({ poachEmailAtOnce: false, sharedMailboxMemberIds: [otherWorkspace] })
            ).status,
        ).toBe(422);
        await as(admin)
            .put(w('/guardrails/settings'))
            .send({ poachEmailAtOnce: false, sharedMailboxMemberIds: [outreachId] })
            .expect(200);
        expect(await detector.judge(workspace, (await synced({ to: [`pooled@pooled-${stamp}.test`] })).id)).toBe(0);
        expect((await owner.person.findUniqueOrThrow({ where: { id: pooled } })).ownerId).toBe(outreachId);
        await as(admin)
            .put(w('/guardrails/settings'))
            .send({ poachEmailAtOnce: false, sharedMailboxMemberIds: [] })
            .expect(200);
        expect(await detector.judge(workspace, (await synced({ to: [`pooled@pooled-${stamp}.test`] })).id)).toBe(1);
    });

    it('does not judge calendar invitations or answers to another member’s lead', async () => {
        await lead(ben, `cal@cal-${stamp}.test`);
        for (const subject of [
            'Invitation: Intro @ Thu Oct 22, 2026 3pm',
            'Updated invitation with note: Intro',
            'accepted: Intro',
            'Cancelled event: Intro',
        ])
            expect(await detector.judge(workspace, (await synced({ to: [`cal@cal-${stamp}.test`], subject })).id)).toBe(
                0,
            );
        expect(await detector.judge(workspace, (await synced({ to: [`cal@cal-${stamp}.test`] })).id)).toBe(1);
    });

    it('does not judge history: mail older than the lookback (a first sync) raises nothing', async () => {
        const old = await synced({
            to: [`old@old-${stamp}.test`, benLeadAddress],
            sentAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        });
        expect(await detector.judge(workspace, old.id)).toBe(0);
    });

    it('puts the day’s alerts in the owner’s digest, subject and all, never the body', async () => {
        await app.get(TaskNotificationsService).sendDigests(new Date(Date.now() + 60_000));
        await deliverMail(app);
        const digest = mailTo(emails.ben, 'task_digest').at(-1);
        expect(digest?.text).toContain('Quick intro');
        expect(digest?.text).not.toContain('Secret pricing');
    });

    it('lists members whose mail sync does not see, for reviewers only', async () => {
        const res = await as(mia).get(w('/guardrails/mailbox-coverage')).expect(200);
        const rows = res.body as MailboxCoverageView[];
        expect(rows.find((r) => r.memberId === anaId)?.syncedVia).toBe('mailbox');
        expect(rows.find((r) => r.memberId === benId)).toMatchObject({ syncedVia: null, mailboxes: [] });
        expect(rows[0]!.syncedVia).toBeNull();
        expect((await as(ana).get(w('/guardrails/mailbox-coverage'))).status).toBe(403);
    });

    it('never crosses workspaces: another workspace cannot judge, read or list this one’s', async () => {
        const message = await synced({ to: [benLeadAddress, `ceo@${benCompanyDomain}`] });
        expect(await detector.judge(otherWorkspace, message.id)).toBe(0);
        const res = await as(otherAdmin).get(w('/guardrails/events?kind=poach_suspected', otherWorkspace)).expect(200);
        expect((res.body as { items: unknown[] }).items).toHaveLength(0);
        const coverage = (await as(otherAdmin).get(w('/guardrails/mailbox-coverage', otherWorkspace)).expect(200))
            .body as MailboxCoverageView[];
        expect(coverage.map((r) => r.email)).toEqual([emails.other]);
        expect([403, 404]).toContain((await as(otherAdmin).get(w('/guardrails/mailbox-coverage'))).status);
        expect(
            await owner.notification.count({
                where: { workspaceId: otherWorkspace, kind: 'guardrail_poach_suspected' },
            }),
        ).toBe(0);
    });
});
