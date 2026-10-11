import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, GMAIL_SCOPES, SESSION_COOKIE } from '@bylinecrm/shared';
import type { Queue } from 'bullmq';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { MailSyncService, type SyncRunResult } from '../../src/mail-sync/mail-sync.service';
import { WEBHOOK_QUEUE } from '../../src/webhooks/webhooks.constants';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { verifyAddress } from '../support/mail';
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

const DAY = 24 * 60 * 60 * 1000;
const MAILBOXES = 4;
const MESSAGES_PER_MAILBOX = 150;
const CONCURRENT_GETS = 50;
/**
 * The import is judged by progress, not by a wall-clock budget sized for a fast machine (#113): it
 * fails when no message has been imported for this long — stuck, not slow.
 */
const IMPORT_STALL_MS = 60_000;
/** Only a backstop for a hung run; a stall fails the test long before this. */
const IMPORT_BACKSTOP_MS = 20 * 60_000;
const PEOPLE = 12;

/**
 * Background mail work must never starve request handling (#86, FR-CRMS-2). Found in the
 * real-Gmail test: the initial import of two mailboxes made ordinary requests fail with
 * "Unable to start a transaction in the given time", because workers, their event listeners and
 * requests shared one tenant pool. Here four mailboxes (600 messages, each concerning matched
 * people, so timeline and webhook listeners fire for every one) import concurrently — outside any
 * request, as a worker runs them — while rounds of 50 concurrent GETs run until the imports end.
 * Every GET must answer 200 and every message must be imported.
 */
describe('background work and request handling (#86, FR-CRMS-2)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let sync: MailSyncService;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);
    gmail.listPageSize = 100;

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const adminEmail = `pools-admin-${stamp}@example.com`;
    let admin: Browser;
    let workspace: string;
    const mailboxes: string[] = [];
    const mailboxEmails = Array.from({ length: MAILBOXES }, (_, i) => `pools-box${i}-${stamp}@example.com`);
    const people = Array.from({ length: PEOPLE }, (_, i) => `person${i}-${stamp}@client.example`);
    let webhookEndpoint: string | undefined;
    /** The imports under test; teardown waits for them even when the test failed or timed out. */
    let imports: Promise<SyncRunResult[]> | undefined;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;

    /** A receiver that answers 200, so the worker never disables the endpoint this spec counts on (#110). */
    let hooks: WebhookReceiver;

    beforeAll(async () => {
        hooks = await new WebhookReceiver().start();
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

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Pools ${stamp}` });
        await verifyAddress(app, http, adminEmail);
        expect(signup.status).toBe(201);
        admin = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;

        const clientId = `333-pools${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const secret = `GOCSPX-pools-${stamp}`;
        const view = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
        const put = await http()
            .put(w('/mail/oauth-client'))
            .set('Cookie', admin.cookie)
            .set(CSRF_HEADER, admin.csrf)
            .send({ clientId, clientSecret: secret });
        expect(put.status).toBe(200);

        for (const email of mailboxEmails) {
            const start = await as(admin).post(w('/mailboxes/connect')).send({ purpose: 'pool' });
            expect(start.status).toBe(201);
            const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
                email,
                scopes: [...GMAIL_SCOPES],
            });
            const callback = await as(admin).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
            expect(new URL(String(callback.headers['location'])).searchParams.get('connect')).toBe('connected');
        }
        const list = await as(admin).get(w('/mailboxes'));
        for (const email of mailboxEmails) {
            mailboxes.push((list.body as { id: string; email: string }[]).find((m) => m.email === email)!.id);
        }

        // People the mail concerns, each at a company with an open deal: every message lands on
        // several records, so the timeline and webhook listeners work for every import.
        for (const [i, email] of people.entries()) {
            const company = await as(admin)
                .post(w('/companies'))
                .send({ name: `Client ${i} ${stamp}` });
            const person = await as(admin)
                .post(w('/people'))
                .send({
                    nameFirst: `Person${i}`,
                    nameLast: 'Client',
                    emails: { primary: email, additional: [] },
                    companyId: (company.body as { id: string }).id,
                });
            expect(person.status).toBe(201);
            await as(admin)
                .post(w('/opportunities'))
                .send({
                    name: `Deal ${i} ${stamp}`,
                    companyId: (company.body as { id: string }).id,
                    pointOfContactId: (person.body as { id: string }).id,
                });
        }
        const endpoint = await as(admin)
            .post(w('/webhooks'))
            .send({ url: hooks.url('/pools-hook'), events: ['*'] });
        expect(endpoint.status).toBe(201);
        webhookEndpoint =
            (endpoint.body as { endpoint?: { id: string }; id?: string }).endpoint?.id ??
            (endpoint.body as { id: string }).id;

        for (const box of mailboxEmails) {
            for (let n = 0; n < MESSAGES_PER_MAILBOX; n += 1) {
                gmail.deliver(box, {
                    from: people[n % PEOPLE]!,
                    to: [box, people[(n + 1) % PEOPLE]!, people[(n + 2) % PEOPLE]!],
                    subject: `Message ${n} to ${box}`,
                    text: `Body ${n}`,
                    date: new Date(Date.now() - ((n % 25) + 1) * DAY + n * 1000),
                });
            }
        }
    }, 120_000);

    afterAll(async () => {
        await imports?.catch(() => undefined);
        if (webhookEndpoint) {
            // Retire the endpoint, then remove the hundreds of deliveries the import queued for it:
            // the suite shares one queue and one database, and a backlog of jobs to a receiver that
            // never answers would sit in front of every later spec's deliveries and fill the sweep's
            // batch with rows that are not stranded.
            await as(admin).delete(w(`/webhooks/${webhookEndpoint}`));
            const owner = app.get(PrismaService);
            const queue = app.get<Queue>(getQueueToken(WEBHOOK_QUEUE));
            const deliveries = await owner.webhookDelivery.findMany({
                where: { endpointId: webhookEndpoint },
                select: { id: true },
            });
            // A job mid-attempt is locked and stays; its next read finds no row and skips.
            await Promise.allSettled(deliveries.map(({ id }) => queue.remove(id)));
            await owner.webhookDelivery.deleteMany({ where: { endpointId: webhookEndpoint } });
        }
        await app?.close();
        await hooks?.close();
    }, IMPORT_BACKSTOP_MS);

    it(
        'answers every request while four mailboxes import 600 messages',
        async () => {
            let importsDone = false;
            imports = Promise.all(
                mailboxes.map((mailbox) => sync.syncMailbox(workspace, mailbox, { sleep: () => Promise.resolve() })),
            ).finally(() => {
                importsDone = true;
            });

            const paths = [w('/me'), w('/mailboxes'), w('/mail/oauth-client/status'), w('/people?limit=25')];
            const failures: { path: string; status: number; code: unknown }[] = [];
            let answered = 0;
            const owner = app.get(PrismaService);
            const expected = MAILBOXES * MESSAGES_PER_MAILBOX;
            let imported = 0;
            let lastProgressAt = Date.now();
            while (!importsDone) {
                const now = await owner.mailMessageCopy.count({ where: { mailboxId: { in: mailboxes } } });
                if (now > imported) {
                    imported = now;
                    lastProgressAt = Date.now();
                } else if (Date.now() - lastProgressAt > IMPORT_STALL_MS) {
                    throw new Error(
                        `the import made no progress for ${IMPORT_STALL_MS / 1000}s (stuck at ${imported} of ${expected} messages)`,
                    );
                }
                const round = await Promise.all(
                    Array.from({ length: CONCURRENT_GETS }, (_, i) => {
                        const path = paths[i % paths.length]!;
                        return as(admin)
                            .get(path)
                            .then((res) => ({ path, res }));
                    }),
                );
                for (const { path, res } of round) {
                    answered += 1;
                    if (res.status !== 200) {
                        failures.push({ path, status: res.status, code: (res.body as { code?: unknown }).code });
                    }
                }
            }
            const results: SyncRunResult[] = await imports;

            expect(failures).toEqual([]);
            expect(answered).toBeGreaterThanOrEqual(CONCURRENT_GETS);
            expect(results.map((r) => r.mode)).toEqual(Array(MAILBOXES).fill('initial'));
            expect(results.reduce((sum, r) => sum + r.imported, 0)).toBe(expected);
        },
        IMPORT_BACKSTOP_MS,
    );
});
