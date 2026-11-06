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
import { MailSyncService, type BackfillStepResult } from '../../src/mail-sync/mail-sync.service';
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

interface BackfillView {
    floor: string;
    usedBytes: number;
    maxBytes: number;
    mailboxes: { mailboxId: string; email: string; status: string | null; imported: number; unmatched: number }[];
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * The mail history backfill: the sync reaching back from where a mailbox's first import began to a floor, a month at
 * a time, newest first. Only mail with a person of the workspace in it is read whole and stored (headers first; the
 * rest is never read whole); what the mailbox already holds is skipped unread; the estimate stores nothing; a step cut
 * short repeats its window and stores nothing twice; the byte budget stops it; the CLI and the worker never walk one
 * mailbox at once; an admin starts it from the Mailboxes page.
 */
describe('mail history backfill', () => {
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
    const adminEmail = `bf-admin-${stamp}@example.com`;
    const memberEmail = `bf-member-${stamp}@example.com`;
    const dana = `dana-${stamp}@acme.example`;
    const stranger = `stranger-${stamp}@elsewhere.example`;
    let mailbox: string;
    let danaId: string;
    let log: EventLog;
    /** Five months back: the walk's floor. */
    const floor = new Date(Date.now() - 150 * DAY);
    const noWait = { sleep: () => Promise.resolve() };

    /** Gmail ids of the fixtures, by role. */
    const ids: Record<string, string> = {};

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;

    const stored = async () => {
        const [messages, copies] = await Promise.all([
            owner.mailMessage.count({ where: { workspaceId: workspace } }),
            owner.mailMessageCopy.count({ where: { workspaceId: workspace } }),
        ]);
        return { messages, copies };
    };
    const fullReads = (id: string) => gmail.calls.filter((c) => c.method === 'getMessage' && c.id === id).length;
    const headerReads = (id: string) =>
        gmail.calls.filter((c) => c.method === 'getMessageHeaders' && c.id === id).length;
    const state = () => owner.mailboxSyncState.findUniqueOrThrow({ where: { mailboxId: mailbox } });

    /** Steps until the walk stops; the outcomes, in order. */
    async function walk(): Promise<BackfillStepResult[]> {
        const steps: BackfillStepResult[] = [];
        for (let i = 0; i < 20; i += 1) {
            const step = await sync.backfillStep(workspace, mailbox, noWait);
            steps.push(step);
            if (step.outcome !== 'walked') return steps;
        }
        throw new Error('the walk did not stop');
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
        sync = app.get(MailSyncService);

        const signUp = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Backfill ${stamp}` });
        expect(signUp.status).toBe(201);
        await verifyAddress(app, http, adminEmail);
        admin = browserFrom(signUp);
        workspace = (signUp.body as { workspace: { id: string } }).workspace.id;

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
        const secret = `GOCSPX-bf-${stamp}`;
        const view = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
        const put = await http()
            .put(w('/mail/oauth-client'))
            .set('Cookie', admin.cookie)
            .set(CSRF_HEADER, admin.csrf)
            .send({ clientId, clientSecret: secret });
        expect(put.status).toBe(200);
        const start = await as(admin).post(w('/mailboxes/connect')).send({ purpose: 'personal' });
        const { code, state: oauthState } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email: adminEmail,
            scopes: [...GMAIL_SCOPES],
        });
        await as(admin).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${oauthState}&code=${code}`);
        const list = await as(admin).get(w('/mailboxes'));
        mailbox = (list.body as { id: string; email: string }[]).find((m) => m.email === adminEmail)!.id;

        const person = await as(admin)
            .post(w('/people'))
            .send({ nameFirst: 'Dana', nameLast: 'Reyes', emails: { primary: dana, additional: [] } });
        expect(person.status).toBe(201);
        danaId = (person.body as { id: string }).id;

        // Inside the first import's window: imported by it. One just inside its edge, which the backfill's first
        // window lists again (the margin) and must skip unread.
        ids.recent = gmail.deliver(adminEmail, {
            from: dana,
            to: [adminEmail],
            subject: 'Recent',
            text: 'r',
            date: new Date(Date.now() - 5 * DAY),
        }).id;
        ids.edge = gmail.deliver(adminEmail, {
            from: dana,
            to: [adminEmail],
            subject: 'Edge',
            text: 'e',
            date: new Date(Date.now() - 29.8 * DAY),
        }).id;
        // Older: what the backfill is for.
        ids.danaIn = gmail.deliver(adminEmail, {
            from: `"Dana Reyes" <${dana}>`,
            to: [adminEmail],
            subject: 'Old question',
            text: 'Can you send pricing?',
            date: new Date(Date.now() - 60 * DAY),
        }).id;
        ids.danaOut = gmail.deliver(adminEmail, {
            from: adminEmail,
            to: [dana],
            subject: 'Old pricing',
            text: 'Here it is.',
            date: new Date(Date.now() - 100 * DAY),
            labels: ['SENT'],
        }).id;
        ids.stranger = gmail.deliver(adminEmail, {
            from: stranger,
            to: [adminEmail],
            subject: 'Cold pitch',
            text: 'x'.repeat(5000),
            date: new Date(Date.now() - 70 * DAY),
        }).id;
        ids.internal = gmail.deliver(adminEmail, {
            from: memberEmail,
            to: [adminEmail],
            subject: 'Lunch?',
            text: 'x',
            date: new Date(Date.now() - 80 * DAY),
        }).id;
        ids.draft = gmail.deliver(adminEmail, {
            from: adminEmail,
            to: [dana],
            subject: 'Unsent',
            text: 'x',
            date: new Date(Date.now() - 90 * DAY),
            labels: ['DRAFT'],
        }).id;
        ids.belowFloor = gmail.deliver(adminEmail, {
            from: dana,
            to: [adminEmail],
            subject: 'Ancient',
            text: 'x',
            date: new Date(Date.now() - 200 * DAY),
        }).id;

        const first = await sync.syncMailbox(workspace, mailbox, noWait);
        expect(first).toMatchObject({ mode: 'initial', imported: 2 });
        log = await eventLog(app, 'email.received', 'email.sent');
    });

    afterAll(async () => {
        await app?.close();
    });

    it('estimates without storing or writing anything', async () => {
        const before = await stored();
        const stateBefore = await state();
        const estimate = await sync.estimateBackfill(workspace, mailbox, floor, { retry: noWait });
        expect(estimate).toMatchObject({
            mailboxId: mailbox,
            // From the first import's edge down: edge (again, the margin), danaIn, danaOut, stranger, internal, draft.
            listed: 6,
            alreadyStored: 1,
            matched: 2,
            wouldStore: 2,
        });
        expect(estimate!.windows).toBeGreaterThanOrEqual(4); // ~121 days, a month a time
        expect(await stored()).toEqual(before);
        expect(await state()).toEqual(stateBefore);
        expect(await log.read()).toEqual([]);
        // Headers only: nothing was read whole.
        for (const id of Object.values(ids).filter((i) => i !== ids.recent && i !== ids.edge)) {
            expect(fullReads(id)).toBe(0);
        }
    });

    it('a sampled estimate reads fewer headers and projects the rest at their share', async () => {
        const estimate = await sync.estimateBackfill(workspace, mailbox, floor, { sample: 1, retry: noWait });
        expect(estimate!.headersRead).toBeLessThanOrEqual(estimate!.windows);
        expect(await log.read()).toEqual([]);
    });

    it('stores only mail with a person in it, read whole only then, and announces it', async () => {
        expect(await sync.startBackfill(workspace, mailbox, floor)).toBe(true);
        const before = await stored();
        const headerReadsBefore = headerReads(ids.stranger!);
        const steps = await walk();
        expect(steps.at(-1)!.outcome).toBe('done');
        expect(steps.filter((s) => s.outcome === 'walked').length).toBeGreaterThanOrEqual(3);

        // Dana's two old messages, nothing else.
        expect(await stored()).toEqual({ messages: before.messages + 2, copies: before.copies + 2 });
        expect(fullReads(ids.danaIn!)).toBe(1);
        expect(fullReads(ids.danaOut!)).toBe(1);
        for (const id of [ids.stranger!, ids.internal!, ids.draft!, ids.belowFloor!]) expect(fullReads(id)).toBe(0);
        expect(headerReads(ids.stranger!)).toBe(headerReadsBefore + 1);
        // Below the floor is never listed, so never read at all.
        expect(headerReads(ids.belowFloor!)).toBe(0);

        const s = await state();
        expect(s.backfillStatus).toBe('done');
        expect(s.backfillCompletedAt).not.toBeNull();
        expect(s.backfillBefore!.getTime()).toBe(floor.getTime());
        expect(Number(s.backfillBytes)).toBeGreaterThan(0);
        expect(s.backfillProgress).toMatchObject({ imported: 2, unmatched: 2, skippedByLabel: 1, alreadyStored: 1 });

        // On Dana's timeline as any synced mail: one event each, on her record.
        const events = await log.read();
        expect(events.map((e) => e.type).sort()).toEqual(['email.received', 'email.sent']);
        for (const e of events) expect(e.targets).toContainEqual({ type: 'person', id: danaId });
        const participants = await owner.mailParticipant.count({ where: { workspaceId: workspace, personId: danaId } });
        expect(participants).toBe(4);
    });

    it('does not store what the first import already holds (the margin is skipped unread)', async () => {
        expect(fullReads(ids.edge!)).toBe(1); // the first import's read, and no other
        expect(headerReads(ids.edge!)).toBe(0);
        expect(await owner.mailMessageCopy.count({ where: { mailboxId: mailbox, providerMessageId: ids.edge! } })).toBe(
            1,
        );
    });

    it('a step cut short repeats its window, storing nothing twice', async () => {
        const older = gmail.deliver(adminEmail, {
            from: dana,
            to: [adminEmail],
            subject: 'Older still',
            text: 'x',
            date: new Date(Date.now() - 170 * DAY),
        }).id;
        const other = gmail.deliver(adminEmail, {
            from: dana,
            to: [adminEmail],
            subject: 'Older too',
            text: 'y',
            date: new Date(Date.now() - 171 * DAY),
        }).id;
        await owner.mailboxSyncState.update({
            where: { mailboxId: mailbox },
            data: { backfillProgress: {} },
        });
        // A lower floor walks on from where the last walk ended.
        const lower = new Date(Date.now() - 180 * DAY);
        expect(await sync.startBackfill(workspace, mailbox, lower)).toBe(true);
        const before = await stored();
        // Gmail fails the full reads past every retry (5 attempts each, two read at once): the step throws mid-window.
        gmail.failNext(adminEmail, 'getMessage', 500, 10);
        await expect(sync.backfillStep(workspace, mailbox, noWait)).rejects.toThrow();
        gmail.clearFailures();
        const cut = await state();
        expect(cut.backfillBefore!.getTime()).toBe(floor.getTime()); // the cursor did not move
        expect(cut.backfillLeaseUntil).toBeNull(); // and the mailbox is free again

        const steps = await walk();
        expect(steps.at(-1)!.outcome).toBe('done');
        expect(await stored()).toEqual({ messages: before.messages + 2, copies: before.copies + 2 });
        expect(
            await owner.mailMessageCopy.count({
                where: { mailboxId: mailbox, providerMessageId: { in: [older, other] } },
            }),
        ).toBe(2);
        expect((await state()).backfillBefore!.getTime()).toBe(lower.getTime());
    });

    it('one process at a time: a mailbox another holds is busy', async () => {
        const lower = new Date(Date.now() - 200 * DAY);
        await sync.startBackfill(workspace, mailbox, lower);
        await owner.mailboxSyncState.update({
            where: { mailboxId: mailbox },
            data: { backfillLeaseUntil: new Date(Date.now() + 60_000) },
        });
        expect((await sync.backfillStep(workspace, mailbox, noWait)).outcome).toBe('busy');
        await owner.mailboxSyncState.update({ where: { mailboxId: mailbox }, data: { backfillLeaseUntil: null } });
    });

    it('stops at the byte budget, resumably, and stores nothing past it', async () => {
        const { maxBytes } = await sync.backfillBudget();
        const kept = (await state()).backfillBytes;
        await owner.mailboxSyncState.update({
            where: { mailboxId: mailbox },
            data: { backfillBytes: BigInt(maxBytes) },
        });
        try {
            const before = await stored();
            const step = await sync.backfillStep(workspace, mailbox, noWait);
            expect(step.outcome).toBe('budget_reached');
            expect((await state()).backfillStatus).toBe('budget_reached');
            expect(await stored()).toEqual(before);
            // Nothing walks a stopped backfill until it is started again.
            expect((await sync.backfillStep(workspace, mailbox, noWait)).outcome).toBe('idle');
        } finally {
            await owner.mailboxSyncState.update({ where: { mailboxId: mailbox }, data: { backfillBytes: kept } });
        }
        expect(await sync.startBackfill(workspace, mailbox, new Date(Date.now() - 200 * DAY))).toBe(true);
        const steps = await walk();
        expect(steps.at(-1)!.outcome).toBe('done');
    });

    it('an admin starts it and sees where each mailbox stands; a member may not', async () => {
        const denied = await as(member).post(w('/mail/history-backfill')).send({});
        expect(denied.status).toBe(403);
        expect((await as(member).get(w('/mail/history-backfill'))).status).toBe(403);
        const bad = await as(admin).post(w('/mail/history-backfill')).send({ since: '2999-01-01' });
        expect(bad.status).toBe(400);

        const started = await as(admin).post(w('/mail/history-backfill')).send({});
        expect(started.status).toBe(202);
        const view = started.body as BackfillView;
        expect(view.floor).toBe('2023-04-01');
        expect(view.maxBytes).toBeGreaterThan(0);
        // The default floor is below this mailbox's: its walk is running again.
        expect(view.mailboxes).toEqual([
            expect.objectContaining({ mailboxId: mailbox, email: adminEmail, status: 'running' }),
        ]);
        const read = await as(admin).get(w('/mail/history-backfill'));
        expect(read.status).toBe(200);
        expect((await state()).historyFloor!.toISOString()).toBe('2023-04-01T00:00:00.000Z');
        // Leave nothing running for later specs' workers.
        await owner.mailboxSyncState.update({ where: { mailboxId: mailbox }, data: { backfillStatus: 'done' } });
    });
});
