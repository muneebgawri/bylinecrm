import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_SCOPES,
    REPUTATION_DEFAULTS,
    SESSION_COOKIE,
    SYSTEM_ROLES,
    type GuardrailEventView,
    type NotificationsView,
    type ReputationSettings,
    type RichText,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { WorkspaceContext } from '../../src/infra/workspace-context';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { ReputationGate } from '../../src/reputation/reputation-gate';
import { ReputationMonitor } from '../../src/reputation/reputation-monitor';
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

const doc = (text: string): RichText => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const BODY_A =
    'I noticed your team is growing fast and wanted to share how we helped similar companies cut their onboarding time in half with a short pilot. Would you be open to a quick call next week?';
const BODY_B = 'Following up on the warehouse lease renewal: the signed contract and the floor plan are attached.';
const BODY_C = 'Our quarterly community dinner is on the river terrace this year; bring a friend if you like.';
const BODY_D = 'The analytics export you asked about is ready; the columns now include region and channel.';

/**
 * REP-1 (#204, FR-CRMS-23): per-mailbox budgets and repetition detection. A personal mailbox's new mail is refused
 * over its new-recipient budget, after near-identical bodies to too many people (bulk pattern), or after one
 * subject to too many new people; each refusal is a guardrail event. Mail that left through Gmail is judged after
 * sync and flagged (volume, bulk pattern, negative replies), once a day. Thresholds are the workspace's own.
 */
describe('REP-1 sender reputation (FR-CRMS-23)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const emails = {
        admin: `rep-admin-${stamp}@example.com`,
        ana: `rep-ana-${stamp}@example.com`,
        mia: `rep-mia-${stamp}@example.com`,
        other: `rep-other-${stamp}@example.com`,
    };
    let admin: Browser;
    let ana: Browser;
    let mia: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let anaId: string;
    let anaMailbox: string;
    const people: string[] = [];

    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const mail = (i: number, subject: string, text: string) =>
        as(ana)
            .post(w('/mail/send'))
            .send({ mailboxId: anaMailbox, personId: people[i], subject, body: doc(text) });
    const events = async (who: Browser, id = workspace) =>
        ((await as(who).get(w('/guardrails/events?limit=100', id)).expect(200)).body as { items: GuardrailEventView[] })
            .items;
    const alerts = async (who: Browser) =>
        ((await as(who).get(w('/notifications')).expect(200)).body as NotificationsView).items.filter(
            (n) => n.kind === 'guardrail_alert',
        );

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

    /** A message Gmail sync stored for Ana's mailbox (as sync would), sent `minutesAgo`. */
    async function synced(input: {
        direction: 'outbound' | 'inbound';
        from: string;
        to: string;
        subject: string;
        text: string;
        inReplyTo?: string;
        threadId?: string;
        minutesAgo?: number;
    }): Promise<{ threadId: string }> {
        const sentAt = new Date(Date.now() - (input.minutesAgo ?? 5) * 60_000);
        const key = `${stamp}-${Math.random().toString(36).slice(2)}`;
        const threadId =
            input.threadId ??
            (
                await owner.mailThread.create({
                    data: { workspaceId: workspace, subject: input.subject, lastMessageAt: sentAt },
                })
            ).id;
        const mailboxThread =
            (await owner.mailboxThread.findFirst({ where: { mailboxId: anaMailbox, threadId } })) ??
            (await owner.mailboxThread.create({
                data: { workspaceId: workspace, mailboxId: anaMailbox, providerThreadId: `t-${key}`, threadId },
            }));
        const message = await owner.mailMessage.create({
            data: {
                workspaceId: workspace,
                threadId,
                identityKey: `id-${key}`,
                rfc822MessageId: `${key}@mail.test`,
                inReplyTo: input.inReplyTo ?? null,
                direction: input.direction,
                fromAddress: input.from,
                sentAt,
                subject: input.subject,
                bodyText: input.text,
            },
        });
        await owner.mailMessageCopy.create({
            data: {
                workspaceId: workspace,
                messageId: message.id,
                mailboxId: anaMailbox,
                mailboxThreadId: mailboxThread.id,
                providerMessageId: `g-${key}`,
                direction: input.direction,
            },
        });
        await owner.mailParticipant.createMany({
            data: [
                { workspaceId: workspace, messageId: message.id, role: 'from', address: input.from.toLowerCase() },
                { workspaceId: workspace, messageId: message.id, role: 'to', address: input.to.toLowerCase() },
            ],
        });
        return { threadId };
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

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, id: workspace } = await signUp(emails.admin, `Rep ${stamp}`));
        ({ browser: otherAdmin, id: otherWorkspace } = await signUp(emails.other, `Rep other ${stamp}`));

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
        mia = await join(emails.mia, SYSTEM_ROLES.manager);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        anaId = members.find((m) => m.email === emails.ana)!.id;

        const clientId = `555-${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const secret = `GOCSPX-rep-${stamp}`;
        const view = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
        await as(admin).put(w('/mail/oauth-client')).send({ clientId, clientSecret: secret }).expect(200);
        anaMailbox = await connect(ana, emails.ana);

        for (let i = 0; i < 6; i++) {
            const res = await as(ana)
                .post(w('/people'))
                .send({ nameFirst: `P${i}`, emails: { primary: `p${i}@rep-${i}-${stamp}.test`, additional: [] } })
                .expect(201);
            people.push((res.body as { id: string }).id);
        }
    });

    afterAll(async () => {
        await app?.close();
    });

    it('thresholds are the workspace’s own: defaults until an admin sets them, reviewers read, members cannot', async () => {
        // No override: the primary domain is the one the members sign in with.
        const derived = { effectivePrimaryDomain: 'example.com' };
        expect((await as(admin).get(w('/reputation/settings')).expect(200)).body).toEqual({
            ...REPUTATION_DEFAULTS,
            ...derived,
        });
        expect((await as(ana).get(w('/reputation/settings'))).status).toBe(403);
        const tight: ReputationSettings = {
            ...REPUTATION_DEFAULTS,
            dailyNewRecipients: 4,
            hourlyNewRecipients: 4,
            nearDuplicateThreshold: 2,
            subjectRepeatThreshold: 2,
        };
        expect((await as(mia).put(w('/reputation/settings')).send(tight)).status).toBe(403);
        const bad = await as(admin)
            .put(w('/reputation/settings'))
            .send({ ...tight, hourlyNewRecipients: 9 });
        expect(bad.status).toBe(400);
        expect((await as(admin).put(w('/reputation/settings')).send(tight).expect(200)).body).toEqual({
            ...tight,
            ...derived,
        });
        expect((await as(mia).get(w('/reputation/settings')).expect(200)).body).toEqual({ ...tight, ...derived });
        // Another workspace still has the defaults, and cannot read or write this one's.
        expect((await as(otherAdmin).get(w('/reputation/settings', otherWorkspace)).expect(200)).body).toEqual({
            ...REPUTATION_DEFAULTS,
            ...derived,
        });
        expect([403, 404]).toContain((await as(otherAdmin).get(w('/reputation/settings'))).status);
        expect([403, 404]).toContain((await as(otherAdmin).put(w('/reputation/settings')).send(tight)).status);
    });

    it('refuses the bulk pattern and the over-budget send, warns of the repeated subject, and records each', async () => {
        expect((await mail(0, 'Intro', `Hi P0,\n${BODY_A}`)).status).toBe(202);
        expect((await mail(1, 'Intro', `Hi P1,\n${BODY_B}`)).status).toBe(202);
        expect((await mail(2, 'Pilot', `Hello P2,\n${BODY_A}`)).status).toBe(202);

        const bulk = await mail(3, 'Another', `Hi P3,\n${BODY_A}`);
        expect(bulk.status).toBe(422);
        expect((bulk.body as { code: string }).code).toBe('message.bulk_pattern');
        // A repeated subject warns: the send goes.
        expect((await mail(3, 'Re: intro', BODY_C)).status).toBe(202);
        const budget = await mail(4, 'Export', BODY_D);
        expect(budget.status).toBe(422);
        expect(budget.body as { code: string; details: Record<string, string> }).toMatchObject({
            code: 'mailbox.budget_reached',
            details: { window: 'day', used: '4', limit: '4' },
        });

        const mine = (await events(mia)).filter((e) => e.actor?.memberId === anaId);
        expect(mine.map((e) => [e.kind, e.outcome, e.path]).sort()).toEqual(
            [
                ['bulk_pattern', 'blocked', 'send'],
                ['send_budget', 'blocked', 'send'],
                ['subject_repeat', 'warned', 'send'],
            ].sort(),
        );
        // The first bulk pattern of the day tells the reviewers; the subject warning tells Ana.
        expect((await alerts(mia)).length).toBeGreaterThanOrEqual(1);
        expect((await alerts(ana)).map((n) => n.guardrail?.kind)).toEqual(['subject_repeat']);
        // Nothing of it reaches another workspace.
        expect(await events(otherAdmin, otherWorkspace)).toHaveLength(0);
    });

    it('judges what left through Gmail after sync: volume, bulk pattern and negative replies, once a day', async () => {
        const monitor = app.get(ReputationMonitor);
        const sent: { threadId: string; to: string }[] = [];
        for (let i = 0; i < 3; i++) {
            const to = `gmail-${i}@direct-${stamp}.test`;
            sent.push({
                to,
                ...(await synced({
                    direction: 'outbound',
                    from: emails.ana,
                    to,
                    subject: `Pilot ${i}`,
                    text: `Hi G${i},\n${BODY_A}`,
                })),
            });
        }
        await synced({
            direction: 'inbound',
            from: sent[0]!.to,
            to: emails.ana,
            subject: 'Re: Pilot 0',
            text: 'Please remove me from your list.\n\nOn Mon, Ana wrote:\n> earlier',
            inReplyTo: 'x@mail.test',
            threadId: sent[0]!.threadId,
        });
        await monitor.judge(workspace, anaMailbox);
        await monitor.judge(workspace, anaMailbox);

        const fromSync = (await events(mia)).filter((e) => e.path === 'sync');
        expect(fromSync.map((e) => e.kind).sort()).toEqual([
            'bulk_pattern',
            'negative_reply',
            'subject_repeat',
            'volume_anomaly',
        ]);
        expect(fromSync.every((e) => e.outcome === 'warned')).toBe(true);
        expect(fromSync.find((e) => e.kind === 'negative_reply')!.address).toBe(sent[0]!.to);
        // Ana is told in the bell; the next send counts what left through Gmail.
        expect((await alerts(ana)).length).toBe(5);
        expect(((await mail(5, 'Unrelated', BODY_D)).body as { code: string }).code).toBe('mailbox.budget_reached');
        expect(await events(otherAdmin, otherWorkspace)).toHaveLength(0);
    });

    it('protects the primary domain, derived from the members or set by an admin: no enrolment while the pool has no lookalike mailbox', async () => {
        const gate = app.get(ReputationGate);
        const context = app.get(WorkspaceContext);
        const enrol = () =>
            context.run({ workspaceId: workspace, memberId: anaId, capabilities: new Set() }, () =>
                gate.assertLookalikePool('sequence_enrol'),
            );
        // An empty pool refuses nothing (steps wait for a mailbox).
        await expect(enrol()).resolves.toBeUndefined();
        // A pool only on the primary domain — derived (example.com, the members' sign-in domain), on by default.
        const adminId = (
            await owner.workspaceMember.findFirstOrThrow({
                where: { workspaceId: workspace, user: { email: emails.admin } },
            })
        ).id;
        await owner.mailbox.create({
            data: {
                workspaceId: workspace,
                ownerMemberId: adminId,
                email: `pool-${stamp}@example.com`,
                purpose: 'pool',
                status: 'connected',
                // Never opened: the gate reads only the address.
                refreshTokenCiphertext: 'unused',
            },
        });
        await expect(enrol()).rejects.toMatchObject({ code: 'mailbox.primary_domain' });
        // An admin's override.
        const set = await as(admin)
            .put(w('/reputation/settings'))
            .send({ ...REPUTATION_DEFAULTS, primaryDomain: 'Brand.Example' })
            .expect(200);
        expect(set.body).toMatchObject({ primaryDomain: 'brand.example', effectivePrimaryDomain: 'brand.example' });
        // The pool's example.com mailbox is now a lookalike: enrolment goes.
        await expect(enrol()).resolves.toBeUndefined();
        const mine = (await events(mia)).filter((e) => e.kind === 'primary_domain');
        expect(mine).toHaveLength(1);
        // Recorded only in this workspace.
        expect((await events(otherAdmin, otherWorkspace)).some((e) => e.kind === 'primary_domain')).toBe(false);
        await as(admin).put(w('/reputation/settings')).send(REPUTATION_DEFAULTS).expect(200);
    });
});
