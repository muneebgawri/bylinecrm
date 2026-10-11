import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, GMAIL_SCOPES, SESSION_COOKIE, SYSTEM_ROLES } from '@bylinecrm/shared';
import type { Queue } from 'bullmq';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { MAIL_SYNC_QUEUE } from '../../src/mail-sync/mail-sync.constants';
import { MailSyncService, type SyncRunResult } from '../../src/mail-sync/mail-sync.service';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { eventLog, settle, type EventLog } from '../support/outbox';

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

interface ThreadSummary {
    id: string;
    mailboxId: string;
    subject: string;
    messageCount: number;
    lastMessage: { direction: string; from: string; snippet: string };
}
interface Thread {
    id: string;
    subject: string;
    bodiesVisible: boolean;
    messages: {
        direction: string;
        from: string;
        snippet: string;
        bodyText: string | null;
        bodyHtml: string | null;
        participants: { role: string; address: string; personId: string | null; memberId: string | null }[];
    }[];
}
interface Activity {
    kind: string;
    target: { type: string; id: string };
    linked: { type: string; id: string } | null;
    properties: {
        email?: { subject: string; snippet: string; direction: string; threadId: string };
        linked?: { name: string };
    };
}
interface EmailEvent {
    type: string;
    workspaceId: string;
    recordId: string;
    targets: { type: string; id: string }[];
    email: { messageId: string; subject: string; direction: string; from: string; inReplyTo: string | null };
    link?: { personId: string };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Mail sync end to end (P2-2) against an in-memory Gmail and Google: a connected mailbox's last
 * 30 days are imported once, then kept up with through Gmail's history; a forgotten cursor is
 * recovered by re-listing; throttling is retried; drafts, spam and fully blocklisted mail are
 * passed over. Each message's participants are matched to people and members — again whenever a
 * person's addresses change — and the message lands exactly once on the timeline of every record
 * it concerns. Bodies of a personal mailbox are its owner's; others who can read the person see
 * metadata. One workspace never sees another's mail, sync state or blocklist.
 */
describe('mail sync', () => {
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
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;

    const adminEmail = `sync-admin-${stamp}@example.com`;
    const memberEmail = `sync-member-${stamp}@example.com`;
    const otherEmail = `sync-other-${stamp}@example.com`;
    const poolEmail = `pool-${stamp}@example.com`;
    const dana = `dana-${stamp}@acme.example`;

    let adminMailbox: string;
    let memberMailbox: string;
    let poolMailbox: string;
    let otherMailbox: string;
    let danaId: string;
    let acmeId: string;
    let dealId: string;

    let log: EventLog;
    /** The mail events recorded since the spec started. */
    const emailEvents = async () => (await log.read()) as unknown as EmailEvent[];
    let webhookEndpoint: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const noWait = { sleep: () => Promise.resolve() };

    async function connect(who: Browser, ws: string, purpose: 'personal' | 'pool', email: string): Promise<string> {
        const start = await as(who).post(w('/mailboxes/connect', ws)).send({ purpose });
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

    /** Reads `read` once every recorded event has reached its consumers (#89). */
    async function settled<T>(read: () => Promise<T>): Promise<T> {
        await settle(app);
        return read();
    }

    /** A record's mail entries, once every recorded event has reached the timeline. */
    async function timeline(target: string, who: Browser = admin): Promise<Activity[]> {
        await settle(app);
        const res = await as(who).get(w(`/timeline?target=${target}&kinds=linked-email&limit=100`));
        expect(res.status).toBe(200);
        return (res.body as { items: Activity[] }).items;
    }

    async function threads(target: string, who: Browser = admin, ws = workspace): Promise<Response> {
        return as(who).get(w(`/mail/threads?target=${target}`, ws));
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
        log = await eventLog(app, 'email.received', 'email.sent', 'email.linked');

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Sync ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other sync ${stamp}`));

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

        // Google for both workspaces; mailboxes: the admin's personal one, the member's, a pool, and one in B.
        for (const [who, ws, tag] of [
            [admin, workspace, 'a'],
            [otherAdmin, otherWorkspace, 'b'],
        ] as const) {
            const clientId = `222-${tag}${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
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
        adminMailbox = await connect(admin, workspace, 'personal', adminEmail);
        memberMailbox = await connect(member, workspace, 'personal', memberEmail);
        poolMailbox = await connect(admin, workspace, 'pool', poolEmail);
        otherMailbox = await connect(otherAdmin, otherWorkspace, 'personal', otherEmail);

        // Workspace A's records: Acme, Dana at Acme, and an open deal with Dana as its contact.
        acmeId = (
            (
                await as(admin)
                    .post(w('/companies'))
                    .send({ name: `Acme ${stamp}` })
            ).body as { id: string }
        ).id;
        const person = await as(admin)
            .post(w('/people'))
            .send({
                nameFirst: 'Dana',
                nameLast: 'Reyes',
                emails: { primary: dana, additional: [] },
                companyId: acmeId,
            });
        expect(person.status).toBe(201);
        danaId = (person.body as { id: string }).id;
        const deal = await as(admin)
            .post(w('/opportunities'))
            .send({ name: `Series B ${stamp}`, companyId: acmeId, pointOfContactId: danaId });
        expect(deal.status).toBe(201);
        dealId = (deal.body as { id: string }).id;

        const endpoint = await as(admin)
            .post(w('/webhooks'))
            .send({ url: 'http://127.0.0.1:9/mail-sync-hook', events: ['*'] });
        expect(endpoint.status).toBe(201);
        webhookEndpoint =
            (endpoint.body as { endpoint?: { id: string }; id?: string }).endpoint?.id ??
            (endpoint.body as { id: string }).id;
    });

    /** The webhook deliveries written for this workspace's endpoint, by event name. */
    async function deliveries(eventName: string, recordId?: string): Promise<number> {
        const rows = await owner.webhookDelivery.findMany({
            where: { endpointId: webhookEndpoint, eventName },
            select: { payload: true },
        });
        return recordId
            ? rows.filter((r) => (r.payload as { data?: { recordId?: string } }).data?.recordId === recordId).length
            : rows.length;
    }

    afterAll(async () => {
        // Retire the counting endpoint: its receiver never answers, and a live endpoint's retries
        // would run in later specs' workers, inside their requests' timing.
        if (webhookEndpoint) await as(admin).delete(w(`/webhooks/${webhookEndpoint}`));
        await app?.close();
    });

    describe('the first import', () => {
        let result: SyncRunResult;
        let threadId: string;

        beforeAll(async () => {
            const first = gmail.deliver(adminEmail, {
                from: `"Dana Reyes" <${dana}>`,
                to: [adminEmail],
                subject: 'Pricing for the Series B',
                text: 'Send me the distribution list and pricing.',
                date: new Date(Date.now() - 10 * DAY),
                messageIdHeader: `root-${stamp}@acme.example`,
            });
            gmail.deliver(adminEmail, {
                from: adminEmail,
                to: [dana],
                subject: 'Re: Pricing for the Series B',
                text: 'Attached.',
                html: '<p>Attached <script>steal()</script><img src="https://t.example/p.gif"></p>',
                date: new Date(Date.now() - 9 * DAY),
                threadId: first.threadId,
                inReplyTo: `root-${stamp}@acme.example`,
                labels: ['SENT'],
            });
            gmail.deliver(adminEmail, {
                from: dana,
                to: [adminEmail],
                subject: 'Too old',
                text: 'x',
                date: new Date(Date.now() - 40 * DAY),
            });
            gmail.deliver(adminEmail, { from: adminEmail, to: [dana], subject: 'Draft', text: 'x', labels: ['DRAFT'] });
            gmail.deliver(adminEmail, { from: dana, to: [adminEmail], subject: 'Junk', text: 'x', labels: ['SPAM'] });
            result = await sync.syncMailbox(workspace, adminMailbox, noWait);
        });

        it('imports the last 30 days once, oldest first, passing over drafts and spam', async () => {
            expect(result).toMatchObject({ mode: 'initial', imported: 2, skippedByLabel: 1 });
            const list = await threads(`person:${danaId}`);
            expect(list.status).toBe(200);
            const items = (list.body as { items: ThreadSummary[] }).items;
            expect(items).toHaveLength(1);
            expect(items[0]).toMatchObject({
                mailboxId: adminMailbox,
                subject: 'Pricing for the Series B',
                messageCount: 2,
                lastMessage: { direction: 'outbound', from: adminEmail },
            });
            threadId = items[0]!.id;
        });

        it('pages through Gmail’s list (page size 3) and records the cursor', async () => {
            expect(gmail.callsOf('listMessages', adminEmail)).toBeGreaterThanOrEqual(1);
            const state = await as(admin).get(w(`/mailboxes/${adminMailbox}/sync`));
            expect(state.status).toBe(200);
            expect(state.body).toMatchObject({ mailboxId: adminMailbox, status: 'idle', lastError: null });
            expect((state.body as { fullSyncCompletedAt: string | null }).fullSyncCompletedAt).not.toBeNull();
        });

        it('matches participants to the person and to the member who owns the mailbox', async () => {
            const thread = (await as(admin).get(w(`/mail/threads/${threadId}`))).body as Thread;
            const inbound = thread.messages[0]!;
            expect(inbound.direction).toBe('inbound');
            expect(inbound.participants.find((p) => p.role === 'from')).toMatchObject({
                address: dana,
                personId: danaId,
                memberId: null,
            });
            expect(inbound.participants.find((p) => p.role === 'to')!.memberId).not.toBeNull();
            expect(thread.messages[1]!.direction).toBe('outbound');
        });

        it('sanitises HTML with the allowlist: no script, no tracking image', async () => {
            const thread = (await as(admin).get(w(`/mail/threads/${threadId}`))).body as Thread;
            const html = thread.messages[1]!.bodyHtml!;
            expect(html).toContain('Attached');
            expect(html).not.toMatch(/script|steal|img|t\.example/);
        });

        it('announces each message once, on the person, their company and their open deal', async () => {
            const mine = (await emailEvents()).filter(
                (e) => e.workspaceId === workspace && e.email.subject.includes('Series B'),
            );
            expect(mine.map((e) => e.type).sort()).toEqual(['email.received', 'email.sent']);
            for (const e of mine) {
                expect(e.targets).toEqual([
                    { type: 'person', id: danaId },
                    { type: 'company', id: acmeId },
                    { type: 'opportunity', id: dealId },
                ]);
            }
            const reply = mine.find((e) => e.type === 'email.sent')!;
            expect(reply.email.inReplyTo).toBe(`root-${stamp}@acme.example`);
        });

        it('writes exactly one timeline entry per message per record, with no body', async () => {
            for (const target of [`person:${danaId}`, `company:${acmeId}`, `opportunity:${dealId}`]) {
                const entries = await timeline(target);
                const own = entries.filter((e) => e.target.id === target.split(':')[1]);
                expect(own.map((e) => e.kind).sort()).toEqual(['linked-email.received', 'linked-email.sent']);
                const received = own.find((e) => e.kind === 'linked-email.received')!;
                expect(received.linked?.type).toBe('email');
                expect(received.properties.email).toMatchObject({
                    subject: 'Pricing for the Series B',
                    direction: 'inbound',
                });
                expect(JSON.stringify(received.properties)).not.toContain('distribution list and pricing.');
            }
        });
    });

    describe('keeping up', () => {
        it('imports what history reports, once; a second run imports nothing', async () => {
            const before = (await timeline(`person:${danaId}`)).length;
            gmail.deliver(adminEmail, {
                from: dana,
                to: [adminEmail],
                subject: 'One more thing',
                text: 'Also the logo.',
            });
            const run = await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(run).toMatchObject({ mode: 'incremental', imported: 1 });
            const again = await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(again).toMatchObject({ mode: 'incremental', imported: 0 });
            expect(await timeline(`person:${danaId}`)).toHaveLength(before + 1);
        });

        it('stores a message Gmail reports twice only once', async () => {
            const { id } = gmail.deliver(adminEmail, { from: dana, to: [adminEmail], subject: 'Repeat', text: 'r' });
            gmail.repeatInHistory(adminEmail, id);
            const run = await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(run.imported).toBe(1);
            const rows = await owner.mailMessage.count({ where: { mailboxId: adminMailbox, providerMessageId: id } });
            expect(rows).toBe(1);
        });

        it('recovers a forgotten history cursor by re-listing since the last sync', async () => {
            gmail.expireHistory(adminEmail);
            gmail.deliver(adminEmail, { from: dana, to: [adminEmail], subject: 'After the gap', text: 'g' });
            const run = await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(run).toMatchObject({ mode: 'recovered', imported: 1 });
            const next = await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(next.mode).toBe('incremental');
        });

        it('waits out Gmail throttling and retries the request', async () => {
            const { id } = gmail.deliver(adminEmail, { from: dana, to: [adminEmail], subject: 'Throttled', text: 't' });
            gmail.failNext(adminEmail, 'getMessage', 429, 2);
            const waits: number[] = [];
            const run = await sync.syncMailbox(workspace, adminMailbox, {
                sleep: (ms) => (waits.push(ms), Promise.resolve()),
            });
            expect(run.imported).toBe(1);
            expect(waits).toHaveLength(2);
            expect(gmail.calls.filter((c) => c.method === 'getMessage' && c.id === id)).toHaveLength(3);
        });

        it('records a failure that outlasts the retries, and the next run starts clean', async () => {
            gmail.failNext(adminEmail, 'listHistory', 503, 10);
            await expect(sync.syncMailbox(workspace, adminMailbox, noWait)).rejects.toMatchObject({ status: 503 });
            const failed = await as(admin).get(w(`/mailboxes/${adminMailbox}/sync`));
            expect(failed.body).toMatchObject({ status: 'failed', lastError: { code: 'gmail.backendError' } });
            gmail.clearFailures();
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            const clean = await as(admin).get(w(`/mailboxes/${adminMailbox}/sync`));
            expect(clean.body).toMatchObject({ status: 'idle', lastError: null });
        });

        it('skips a mailbox that needs reconnecting and says why', async () => {
            await owner.mailbox.update({ where: { id: memberMailbox }, data: { status: 'reconnect_needed' } });
            const run = await sync.syncMailbox(workspace, memberMailbox, noWait);
            expect(run.mode).toBe('skipped');
            const state = await as(member).get(w(`/mailboxes/${memberMailbox}/sync`));
            expect(state.body).toMatchObject({ status: 'failed', lastError: { code: 'reconnect_needed' } });
            await owner.mailbox.update({ where: { id: memberMailbox }, data: { status: 'connected' } });
        });

        it('queues a first import when a mailbox connects, once per mailbox', async () => {
            const queue = app.get<Queue>(getQueueToken(MAIL_SYNC_QUEUE));
            const job = await queue.getJob(adminMailbox);
            expect(job?.data).toEqual({ workspaceId: workspace, mailboxId: adminMailbox });
            const triggered = await as(admin).post(w(`/mailboxes/${adminMailbox}/sync`));
            expect(triggered.status).toBe(202);
            expect(triggered.body).toMatchObject({ queued: false });
        });
    });

    describe('matching follows the people', () => {
        const lena = `lena-${stamp}@newco.example`;
        let lenaThread: string;

        it('a message from an unknown address is stored but on no record', async () => {
            gmail.deliver(adminEmail, { from: lena, to: [adminEmail], subject: 'Hello from NewCo', text: 'n' });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            const row = await owner.mailParticipant.findFirst({ where: { address: lena, workspaceId: workspace } });
            expect(row?.personId).toBeNull();
            const message = await owner.mailMessage.findFirst({
                where: { id: (await owner.mailParticipant.findFirst({ where: { address: lena } }))!.messageId },
            });
            lenaThread = message!.threadId;
        });

        it('a person who gains the address later gets the earlier mail', async () => {
            const created = await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Lena', emails: { primary: null, additional: [lena.toUpperCase()] } });
            expect(created.status).toBe(201);
            const lenaId = (created.body as { id: string }).id;
            const matchOf = async () =>
                (await owner.mailParticipant.findFirst({ where: { address: lena } }))?.personId ?? null;
            expect(await settled(matchOf)).toBe(lenaId);
            const list = await threads(`person:${lenaId}`);
            expect((list.body as { items: ThreadSummary[] }).items.map((t) => t.id)).toEqual([lenaThread]);

            const deleted = await as(admin).delete(w(`/people/${lenaId}`));
            expect([200, 204]).toContain(deleted.status);
            expect(await settled(matchOf)).toBeNull();

            const restored = await as(admin).post(w(`/people/${lenaId}/restore`));
            expect(restored.status).toBeLessThan(300);
            expect(await settled(matchOf)).toBe(lenaId);

            const moved = await as(admin)
                .patch(w(`/people/${lenaId}`))
                .send({ nameFirst: 'Lena', emails: { primary: null, additional: [] } });
            expect(moved.status).toBe(200);
            expect(await settled(matchOf)).toBeNull();
        });
    });

    describe('the blocklist', () => {
        let workspaceEntry: string;

        it('only an admin keeps the workspace’s; a member keeps their own; values are validated', async () => {
            const asMember = await as(member)
                .post(w('/mail/blocklist'))
                .send({ value: '@spam.example', scope: 'workspace' });
            expect(asMember.status).toBe(403);
            const bad = await as(member).post(w('/mail/blocklist')).send({ value: 'not an address' });
            expect(bad.status).toBe(400);
            expect(bad.body).toMatchObject({ code: 'validation.failed', fieldErrors: [{ path: 'value' }] });
            const personal = await as(member).post(w('/mail/blocklist')).send({ value: 'Noisy@Vendor.example' });
            expect(personal.status).toBe(201);
            expect(personal.body).toMatchObject({
                entry: { value: 'noisy@vendor.example', scope: 'personal' },
                purged: { messages: 0, threads: 0 },
            });
            const created = await as(admin)
                .post(w('/mail/blocklist'))
                .send({ value: '@SPAM.example', scope: 'workspace' });
            expect(created.status).toBe(201);
            workspaceEntry = (created.body as { entry: { id: string } }).entry.id;
            const dup = await as(admin).post(w('/mail/blocklist')).send({ value: '@spam.example', scope: 'workspace' });
            expect(dup.status).toBe(409);
            expect(dup.body).toMatchObject({ code: 'conflict.unique' });
        });

        it('each sees the workspace’s entries and their own, never another member’s', async () => {
            const mine = (await as(member).get(w('/mail/blocklist'))).body as { value: string }[];
            expect(mine.map((e) => e.value).sort()).toEqual(['@spam.example', 'noisy@vendor.example']);
            const admins = (await as(admin).get(w('/mail/blocklist'))).body as { value: string }[];
            expect(admins.map((e) => e.value)).toEqual(['@spam.example']);
            const removeByMember = await as(member).delete(w(`/mail/blocklist/${workspaceEntry}`));
            expect(removeByMember.status).toBe(403);
            expect((await as(otherAdmin).get(w('/mail/blocklist'))).status).toBe(403);
        });

        it('mail whose every outside participant is blocklisted is not imported; mixed mail is', async () => {
            gmail.deliver(adminEmail, { from: 'promo@spam.example', to: [adminEmail], subject: 'Buy now', text: 'b' });
            gmail.deliver(adminEmail, {
                from: dana,
                to: [adminEmail],
                cc: ['promo@spam.example'],
                subject: 'Mixed',
                text: 'm',
            });
            const run = await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(run).toMatchObject({ imported: 1, blocked: 1 });
        });

        it('a personal entry applies to its owner’s mailbox only', async () => {
            gmail.deliver(memberEmail, {
                from: 'noisy@vendor.example',
                to: [memberEmail],
                subject: 'Newsletter',
                text: 'n',
            });
            gmail.deliver(adminEmail, {
                from: 'noisy@vendor.example',
                to: [adminEmail],
                subject: 'Newsletter',
                text: 'n',
            });
            const memberRun = await sync.syncMailbox(workspace, memberMailbox, noWait);
            expect(memberRun).toMatchObject({ imported: 0, blocked: 1 });
            const adminRun = await sync.syncMailbox(workspace, adminMailbox, noWait);
            expect(adminRun).toMatchObject({ imported: 1, blocked: 0 });
        });
    });

    describe('a later match writes the timeline', () => {
        const kai = `kai-${stamp}@later.example`;
        let messageId: string;
        let kaiId: string;
        let laterCo: string;
        let laterDeal: string;

        const emailEntriesOn = (targetId: string) =>
            owner.timelineActivity.count({ where: { linkedType: 'email', linkedId: messageId, targetId } });

        it('mail from an unknown address is on no timeline until someone has the address', async () => {
            gmail.deliver(adminEmail, { from: kai, to: [adminEmail], subject: 'Intro from Later', text: 'Hi there' });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            const imported = (await emailEvents()).find(
                (e) => e.type === 'email.received' && e.email.subject === 'Intro from Later',
            )!;
            expect(imported.targets).toEqual([]);
            messageId = imported.recordId;
            expect(
                await settled(() =>
                    owner.timelineActivity.count({ where: { linkedType: 'email', linkedId: messageId } }),
                ),
            ).toBe(0);
        });

        it('a person gaining the address puts the mail on them, their company and their open deal — once, as email.linked', async () => {
            laterCo = (
                (
                    await as(admin)
                        .post(w('/companies'))
                        .send({ name: `Later ${stamp}` })
                ).body as { id: string }
            ).id;
            const created = await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Kai', emails: { primary: null, additional: [] }, companyId: laterCo });
            kaiId = (created.body as { id: string }).id;
            laterDeal = (
                (
                    await as(admin)
                        .post(w('/opportunities'))
                        .send({ name: `Later deal ${stamp}`, companyId: laterCo, pointOfContactId: kaiId })
                ).body as { id: string }
            ).id;
            const receivedBefore = await settled(() => deliveries('email.received', messageId));

            await as(admin)
                .patch(w(`/people/${kaiId}`))
                .send({ emails: { primary: kai, additional: [] } })
                .expect(200);

            for (const target of [kaiId, laterCo, laterDeal]) {
                expect(await settled(() => emailEntriesOn(target))).toBe(1);
            }
            const entries = await timeline(`person:${kaiId}`);
            expect(entries.filter((e) => e.linked?.id === messageId).map((e) => e.kind)).toEqual([
                'linked-email.received',
            ]);
            const linked = (await emailEvents()).filter((e) => e.type === 'email.linked' && e.recordId === messageId);
            expect(linked).toHaveLength(1);
            expect(linked[0]!.link).toEqual({ personId: kaiId });
            expect(await settled(() => deliveries('email.linked', messageId))).toBe(1);
            expect(await deliveries('email.received', messageId)).toBe(receivedBefore);
        });

        it('a person losing the address (deleted) takes the mail off their records; restoring puts it back once', async () => {
            await as(admin).delete(w(`/people/${kaiId}`));
            for (const target of [kaiId, laterCo, laterDeal]) {
                expect(await settled(() => emailEntriesOn(target))).toBe(0);
            }
            await as(admin).post(w(`/people/${kaiId}/restore`));
            for (const target of [kaiId, laterCo, laterDeal]) {
                expect(await settled(() => emailEntriesOn(target))).toBe(1);
            }
            expect(
                (await emailEvents()).filter((e) => e.type === 'email.linked' && e.recordId === messageId),
            ).toHaveLength(2);
        });
    });

    describe('a blocklist entry purges what it now covers', () => {
        const promo = `promo-${stamp}@purge.example`;
        let promoPerson: string;
        let blockedMessage: string;
        let mixedMessage: string;

        it('a workspace entry deletes fully covered mail, its participants, its timeline entries and emptied threads; mixed mail stays', async () => {
            promoPerson = (
                (
                    await as(admin)
                        .post(w('/people'))
                        .send({ nameFirst: 'Promo', emails: { primary: promo, additional: [] } })
                ).body as { id: string }
            ).id;
            const blocked = gmail.deliver(adminEmail, {
                from: promo,
                to: [adminEmail],
                subject: 'Big sale',
                text: 's',
            });
            gmail.deliver(adminEmail, { from: dana, to: [adminEmail], cc: [promo], subject: 'Mixed purge', text: 'm' });
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            blockedMessage = (await owner.mailMessage.findFirst({
                where: { mailboxId: adminMailbox, providerMessageId: blocked.id },
            }))!.id;
            mixedMessage = (await owner.mailMessage.findFirst({
                where: { mailboxId: adminMailbox, subject: 'Mixed purge' },
            }))!.id;
            const blockedThread = (await owner.mailMessage.findUnique({ where: { id: blockedMessage } }))!.threadId;
            expect(await settled(() => owner.timelineActivity.count({ where: { linkedId: blockedMessage } }))).toBe(1);

            const res = await as(admin)
                .post(w('/mail/blocklist'))
                .send({ value: '@purge.example', scope: 'workspace' });
            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({
                entry: { value: '@purge.example', scope: 'workspace' },
                purged: { messages: 1, threads: 1 },
            });

            expect(await owner.mailMessage.count({ where: { id: blockedMessage } })).toBe(0);
            expect(await owner.mailParticipant.count({ where: { messageId: blockedMessage } })).toBe(0);
            expect(await owner.mailThread.count({ where: { id: blockedThread } })).toBe(0);
            expect(await owner.timelineActivity.count({ where: { linkedId: blockedMessage } })).toBe(0);
            expect(await owner.mailMessage.count({ where: { id: mixedMessage } })).toBe(1);
            expect((await timeline(`person:${promoPerson}`)).some((e) => e.linked?.id === blockedMessage)).toBe(false);
        });

        it('a personal entry purges only its owner’s personal mailboxes', async () => {
            const news = `news-${stamp}@letters.example`;
            gmail.deliver(memberEmail, { from: news, to: [memberEmail], subject: 'Weekly', text: 'w' });
            gmail.deliver(adminEmail, { from: news, to: [adminEmail], subject: 'Weekly', text: 'w' });
            await sync.syncMailbox(workspace, memberMailbox, noWait);
            await sync.syncMailbox(workspace, adminMailbox, noWait);
            const res = await as(member).post(w('/mail/blocklist')).send({ value: news });
            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ purged: { messages: 1, threads: 1 } });
            expect(await owner.mailMessage.count({ where: { mailboxId: memberMailbox, fromAddress: news } })).toBe(0);
            expect(await owner.mailMessage.count({ where: { mailboxId: adminMailbox, fromAddress: news } })).toBe(1);
        });

        it('removing the entry does not bring the mail back', async () => {
            const entries = (await as(admin).get(w('/mail/blocklist'))).body as { id: string; value: string }[];
            const entry = entries.find((e) => e.value === '@purge.example')!;
            expect((await as(admin).delete(w(`/mail/blocklist/${entry.id}`))).status).toBe(204);
            expect(await owner.mailMessage.count({ where: { id: blockedMessage } })).toBe(0);
        });
    });

    describe('who sees what', () => {
        let personalThread: string;
        let poolThread: string;

        beforeAll(async () => {
            personalThread = ((await threads(`person:${danaId}`)).body as { items: ThreadSummary[] }).items.find(
                (t) => t.mailboxId === adminMailbox && t.subject === 'Pricing for the Series B',
            )!.id;
            gmail.deliver(poolEmail, { from: dana, to: [poolEmail], subject: 'Pool reply', text: 'Pool body' });
            await sync.syncMailbox(workspace, poolMailbox, noWait);
            poolThread = ((await threads(`person:${danaId}`)).body as { items: ThreadSummary[] }).items.find(
                (t) => t.mailboxId === poolMailbox,
            )!.id;
        });

        it('the owner of a personal mailbox reads its bodies; a colleague reads its metadata only', async () => {
            const ownerView = (await as(admin).get(w(`/mail/threads/${personalThread}`))).body as Thread;
            expect(ownerView.bodiesVisible).toBe(true);
            expect(ownerView.messages[0]!.bodyText).toContain('distribution list');

            const colleague = await as(member).get(w(`/mail/threads/${personalThread}`));
            expect(colleague.status).toBe(200);
            const view = colleague.body as Thread;
            expect(view.bodiesVisible).toBe(false);
            expect(view.messages[0]).toMatchObject({ bodyText: null, bodyHtml: null, from: dana });
            expect(view.messages[0]!.snippet).not.toBe('');
            expect(colleague.text).not.toContain('distribution list and pricing');
        });

        it('a pool mailbox’s bodies are readable by anyone who can read the person', async () => {
            const view = (await as(member).get(w(`/mail/threads/${poolThread}`))).body as Thread;
            expect(view.bodiesVisible).toBe(true);
            expect(view.messages[0]!.bodyText).toBe('Pool body');
        });

        it('sync state follows the mailbox’s visibility; triggering is its owner’s or an admin’s', async () => {
            expect((await as(member).get(w(`/mailboxes/${adminMailbox}/sync`))).status).toBe(404);
            expect((await as(member).get(w(`/mailboxes/${poolMailbox}/sync`))).status).toBe(200);
            expect((await as(member).post(w(`/mailboxes/${poolMailbox}/sync`))).status).toBe(403);
            expect((await as(member).post(w(`/mailboxes/${memberMailbox}/sync`))).status).toBe(202);
        });

        it('another workspace reaches none of it — threads, thread lists, sync state', async () => {
            expect((await as(otherAdmin).get(w(`/mail/threads/${personalThread}`))).status).toBe(403);
            expect((await as(otherAdmin).get(w(`/mail/threads/${personalThread}`, otherWorkspace))).status).toBe(404);
            expect((await threads(`person:${danaId}`, otherAdmin, otherWorkspace)).status).toBe(404);
            expect((await as(otherAdmin).get(w(`/mailboxes/${adminMailbox}/sync`, otherWorkspace))).status).toBe(404);
        });

        it('the same sender in another workspace matches nobody there and writes nothing here', async () => {
            const before = (await timeline(`person:${danaId}`)).length;
            gmail.deliver(otherEmail, { from: dana, to: [otherEmail], subject: 'Elsewhere', text: 'e' });
            const run = await sync.syncMailbox(otherWorkspace, otherMailbox, noWait);
            expect(run.imported).toBe(1);
            const theirs = await owner.mailParticipant.findFirst({
                where: { workspaceId: otherWorkspace, address: dana },
            });
            expect(theirs?.personId).toBeNull();
            expect(await timeline(`person:${danaId}`)).toHaveLength(before);
            const event = (await emailEvents()).find(
                (e) => e.workspaceId === otherWorkspace && e.email.subject === 'Elsewhere',
            );
            expect(event?.targets).toEqual([]);
        });
    });
});
