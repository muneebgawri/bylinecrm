import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    WEBHOOK_DELIVERY_HEADER,
    WEBHOOK_EVENT_HEADER,
    WEBHOOK_SIGNATURE_HEADER,
    WEBHOOK_TIMESTAMP_HEADER,
    parseWebhookSignature,
} from '@bylinecrm/shared';
import type { Queue } from 'bullmq';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { settle } from '../support/outbox';
import { WebhookReceiver, type Received } from '../support/webhook-receiver';
import { PrismaService } from '../../src/infra/prisma.service';
import { hmacHex } from '../../src/webhooks/signature';
import { WebhooksSweep } from '../../src/webhooks/sweep';
import {
    WEBHOOK_AUTO_DISABLE_AFTER_DEAD,
    WEBHOOK_MAX_ATTEMPTS,
    WEBHOOK_QUEUE,
    WEBHOOK_STUCK_DELIVERING_MS,
    WEBHOOK_SWEEP_BATCH,
    WEBHOOK_SWEEP_GRACE_MS,
} from '../../src/webhooks/webhooks.constants';
import { WebhooksService } from '../../src/webhooks/webhooks.service';
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

interface Endpoint {
    id: string;
    url: string;
    events: string[];
    enabled: boolean;
    disabledReason: string | null;
    consecutiveFailures: number;
    secretPrefix: string;
    previousSecretExpiresAt: string | null;
}
interface Delivery {
    id: string;
    eventName: string;
    status: string;
    attempts: number;
    lastStatusCode: number | null;
    lastError: string | null;
}
interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

/** The worker runs after the request answered; a reader waits a bounded moment for a condition. */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, tries = 200, everyMs = 100): Promise<T> {
    let last = await read();
    for (let i = 0; i < tries && !ok(last); i++) {
        await new Promise((r) => setTimeout(r, everyMs));
        last = await read();
    }
    return last;
}

/**
 * Outbound webhooks end to end against a receiver in this process: an endpoint gets the events
 * it subscribed to, signed so the secret shown once verifies the body; a receiver that fails is
 * retried on the schedule and succeeds when it recovers; one that never recovers sees the
 * delivery die and, after enough deaths, the endpoint switched off; a workspace's endpoints
 * never hear another workspace's events, and its delivery log is unreadable from elsewhere.
 */
describe('webhooks', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let receiver: WebhookReceiver;
    let received: Received[];

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let other: Browser;
    let workspace: string;
    let otherWorkspace: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const deliveriesOf = (endpointId: string, who = admin, ws = workspace) =>
        as(who)
            .get(w(`/webhooks/${endpointId}/deliveries`, ws))
            .then((res) => res.body as Page<Delivery>);

    beforeAll(async () => {
        receiver = await new WebhookReceiver().start();
        received = receiver.received;

        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        const queue = app.get<Queue>(getQueueToken(WEBHOOK_QUEUE));
        await queue.drain(true);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(`wh-admin-${stamp}@example.com`, `Webhooks ${stamp}`));
        ({ browser: other, workspace: otherWorkspace } = await signUp(
            `wh-other-${stamp}@example.com`,
            `Other ${stamp}`,
        ));
    });

    afterAll(async () => {
        await app?.close();
        await receiver.close();
    });

    it('lists the catalogue an endpoint may subscribe to', async () => {
        const res = await as(admin).get(w('/webhooks/events'));
        expect(res.status).toBe(200);
        const names = (res.body as { name: string; object: string }[]).map((e) => e.name);
        expect(names).toContain('person.created');
        expect(names).toContain('deal.stage_changed');
        expect(names).not.toContain('ping');
    });

    it('refuses an endpoint that is not an https public target (unless the environment allows private ones)', async () => {
        const res = await as(admin)
            .post(w('/webhooks'))
            .send({ url: 'https://user:pw@hooks.example.com/in', events: ['*'] });
        expect(res.status).toBe(400);
        const ftp = await as(admin)
            .post(w('/webhooks'))
            .send({ url: 'ftp://hooks.example.com/in', events: ['*'] });
        expect(ftp.status).toBe(400);
        const unknown = await as(admin)
            .post(w('/webhooks'))
            .send({ url: receiver.url('/x'), events: ['no.such_event'] });
        expect(unknown.status).toBe(400);
    });

    it('delivers a subscribed event, signed with the secret shown once, and records it', async () => {
        const path = `/ok-${stamp}`;
        const created = await as(admin)
            .post(w('/webhooks'))
            .send({
                url: receiver.url(path),
                description: 'all events',
                events: ['person.created', 'person.updated'],
            });
        expect(created.status).toBe(201);
        const { endpoint, secret } = created.body as { endpoint: Endpoint; secret: string };
        expect(secret).toMatch(/^whsec_/);
        expect(endpoint.secretPrefix).toBe(`whsec_${secret.slice(6, 14)}…`);
        expect(JSON.stringify(created.body)).not.toContain('Ciphertext');

        const person = await as(admin)
            .post(w('/people'))
            .send({
                name: { first: 'Dana', last: 'Reyes' },
                emails: { primary: `dana-${stamp}@acme.example`, additional: [] },
            });
        expect(person.status).toBe(201);
        const personId = (person.body as { id: string }).id;
        await settle(app);

        const hit = await until(
            async () => received.find((r) => r.path === path && r.headers[WEBHOOK_EVENT_HEADER] === 'person.created'),
            (r) => r !== undefined,
        );
        expect(hit).toBeDefined();
        const body = JSON.parse(hit!.body) as {
            id: string;
            event: string;
            workspaceId: string;
            data: { recordId: string; type: string };
        };
        expect(body.event).toBe('person.created');
        expect(body.workspaceId).toBe(workspace);
        expect(body.data.recordId).toBe(personId);
        expect(body.data.type).toBe('person.created');
        expect(hit!.headers[WEBHOOK_DELIVERY_HEADER]).toBe(body.id);

        // The signature verifies over the raw body with the secret the admin was shown.
        const parsed = parseWebhookSignature(String(hit!.headers[WEBHOOK_SIGNATURE_HEADER]));
        expect(parsed).not.toBeNull();
        expect(String(hit!.headers[WEBHOOK_TIMESTAMP_HEADER])).toBe(String(parsed!.timestamp));
        expect(parsed!.signatures).toContain(hmacHex(secret, parsed!.timestamp, hit!.body));
        expect(Math.abs(parsed!.timestamp - Date.now() / 1000)).toBeLessThan(60);

        const log = await until(
            () => deliveriesOf(endpoint.id),
            (page) => page.items.some((d) => d.eventName === 'person.created' && d.status === 'succeeded'),
        );
        const delivery = log.items.find((d) => d.eventName === 'person.created')!;
        expect(delivery.status).toBe('succeeded');
        expect(delivery.attempts).toBe(1);
        expect(delivery.lastStatusCode).toBe(200);

        // Not subscribed: a company event never reaches this endpoint.
        const company = await as(admin)
            .post(w('/companies'))
            .send({ name: `Acme ${stamp}` });
        expect(company.status).toBe(201);
        // Delivered to every consumer: had the endpoint been owed it, its delivery row would exist now.
        await settle(app);
        expect((await deliveriesOf(endpoint.id)).items.some((d) => d.eventName === 'company.created')).toBe(false);
        expect(received.some((r) => r.path === path && r.headers[WEBHOOK_EVENT_HEADER] === 'company.created')).toBe(
            false,
        );
    });

    it('delivers exactly one event per deal move: stage_changed, won, stage_changed on reopen, lost', async () => {
        const path = `/moves-${stamp}`;
        const created = await as(admin)
            .post(w('/webhooks'))
            .send({ url: receiver.url(path), events: ['*'] });
        expect(created.status).toBe(201);

        const pipeline = (
            (await as(admin).get(w('/pipelines'))).body as { stages: { id: string; name: string }[] }[]
        )[0]!;
        const stage = (name: string) => pipeline.stages.find((s) => s.name === name)!.id;
        const dealRes = await as(admin)
            .post(w('/opportunities'))
            .send({ name: `Moves ${stamp}` });
        expect(dealRes.status).toBe(201);
        const dealId = (dealRes.body as { id: string }).id;

        const move = async (stageId: string, close?: Record<string, unknown>) => {
            const res = await as(admin)
                .post(w(`/opportunities/${dealId}/move`))
                .send(close ? { stageId, close } : { stageId });
            expect(res.status).toBe(201);
        };
        await move(stage('Contacted')); // open → open
        await move(stage('Won'), { wonAmount: { amountMinor: 500 } }); // open → won
        await move(stage('Replied')); // won → open (reopen)
        await move(stage('Lost'), { lostReason: 'budget' }); // open → lost
        await settle(app);
        // One delivery row per move, whatever the relay did: no second row, so no second send.
        const rows = (await deliveriesOf((created.body as { endpoint: Endpoint }).endpoint.id)).items.filter((d) =>
            d.eventName.startsWith('deal.'),
        );
        expect(rows.map((d) => d.eventName).sort()).toEqual(
            ['deal.lost', 'deal.stage_changed', 'deal.stage_changed', 'deal.won'].sort(),
        );

        const dealEvents = () =>
            received
                .filter((r) => r.path === path && String(r.headers[WEBHOOK_EVENT_HEADER]).startsWith('deal.'))
                .map((r) => {
                    const body = JSON.parse(r.body) as { data: { stage?: { toStageId: string } } };
                    return { event: String(r.headers[WEBHOOK_EVENT_HEADER]), to: body.data.stage?.toStageId };
                });
        await until(
            async () => dealEvents(),
            (seen) => seen.length >= 4,
        );
        const seen = dealEvents();
        expect(seen.map((s) => s.event).sort()).toEqual(
            ['deal.lost', 'deal.stage_changed', 'deal.stage_changed', 'deal.won'].sort(),
        );
        // Each landing stage is delivered once, under the event that names it.
        expect(seen.find((s) => s.to === stage('Won'))?.event).toBe('deal.won');
        expect(seen.find((s) => s.to === stage('Lost'))?.event).toBe('deal.lost');
        expect(seen.filter((s) => s.to === stage('Contacted')).map((s) => s.event)).toEqual(['deal.stage_changed']);
        expect(seen.filter((s) => s.to === stage('Replied')).map((s) => s.event)).toEqual(['deal.stage_changed']);
    });

    it('a test send pings the receiver now and reports what it answered', async () => {
        const path = `/ping-${stamp}`;
        const created = await as(admin)
            .post(w('/webhooks'))
            .send({ url: receiver.url(path), events: ['*'] });
        const { endpoint, secret } = created.body as { endpoint: Endpoint; secret: string };
        const res = await as(admin).post(w(`/webhooks/${endpoint.id}/test`));
        expect(res.status).toBe(200);
        const body = res.body as { ok: boolean; statusCode: number; delivery: Delivery };
        expect(body.ok).toBe(true);
        expect(body.statusCode).toBe(200);
        expect(body.delivery.eventName).toBe('ping');
        expect(body.delivery.status).toBe('succeeded');
        const hit = received.find((r) => r.path === path)!;
        expect(hit.headers[WEBHOOK_EVENT_HEADER]).toBe('ping');
        const parsed = parseWebhookSignature(String(hit.headers[WEBHOOK_SIGNATURE_HEADER]))!;
        expect(parsed.signatures).toContain(hmacHex(secret, parsed.timestamp, hit.body));
    });

    it('a receiver that fails is retried on the schedule and succeeds once it recovers', async () => {
        const path = `/flaky-${stamp}`;
        receiver.failNext(path, 2);
        const created = await as(admin)
            .post(w('/webhooks'))
            .send({ url: receiver.url(path), events: ['company.created'] });
        const { endpoint } = created.body as { endpoint: Endpoint };
        await as(admin)
            .post(w('/companies'))
            .send({ name: `Flaky ${stamp}` });
        const log = await until(
            () => deliveriesOf(endpoint.id),
            (page) => page.items.some((d) => d.status === 'succeeded'),
        );
        const delivery = log.items[0]!;
        expect(delivery.status).toBe('succeeded');
        expect(delivery.attempts).toBe(3);
        expect(received.filter((r) => r.path === path)).toHaveLength(3);
        const after = await as(admin).get(w(`/webhooks/${endpoint.id}`));
        expect((after.body as Endpoint).consecutiveFailures).toBe(0);
    }, 60_000);

    it('a receiver that never recovers sees the delivery die, and enough deaths switch the endpoint off', async () => {
        const path = `/dead-${stamp}`;
        receiver.failNext(path, Number.POSITIVE_INFINITY);
        const created = await as(admin)
            .post(w('/webhooks'))
            .send({ url: receiver.url(path), events: ['company.created'] });
        const { endpoint } = created.body as { endpoint: Endpoint };
        // One event per needed death; each runs its whole retry schedule in parallel with the others.
        for (let i = 0; i < WEBHOOK_AUTO_DISABLE_AFTER_DEAD; i++) {
            await as(admin)
                .post(w('/companies'))
                .send({ name: `Dead ${stamp} ${i}` });
        }
        const log = await until(
            () => deliveriesOf(endpoint.id),
            (page) =>
                page.items.length >= WEBHOOK_AUTO_DISABLE_AFTER_DEAD && page.items.every((d) => d.status === 'dead'),
            400,
        );
        expect(log.items.every((d) => d.status === 'dead' && d.attempts === WEBHOOK_MAX_ATTEMPTS)).toBe(true);
        expect(log.items[0]!.lastStatusCode).toBe(500);
        expect(log.items[0]!.lastError).toContain('500');
        const after = await until(
            async () => (await as(admin).get(w(`/webhooks/${endpoint.id}`))).body as Endpoint,
            (e) => e.enabled === false,
        );
        expect(after.enabled).toBe(false);
        expect(after.disabledReason).toContain('consecutive');
        expect(after.consecutiveFailures).toBeGreaterThanOrEqual(WEBHOOK_AUTO_DISABLE_AFTER_DEAD);

        // Switching it back on is a person's decision, and it starts a fresh count.
        const on = await as(admin)
            .patch(w(`/webhooks/${endpoint.id}`))
            .send({ enabled: true });
        expect(on.status).toBe(200);
        expect((on.body as Endpoint).enabled).toBe(true);
        expect((on.body as Endpoint).consecutiveFailures).toBe(0);
        expect((on.body as Endpoint).disabledReason).toBeNull();

        // A dead delivery can be queued again as a new one.
        receiver.recover(path);
        const redo = await as(admin).post(w(`/webhooks/${endpoint.id}/deliveries/${log.items[0]!.id}/redeliver`));
        expect(redo.status).toBe(201);
        const redone = await until(
            () => deliveriesOf(endpoint.id),
            (page) => page.items.some((d) => d.id === (redo.body as Delivery).id && d.status === 'succeeded'),
        );
        expect(redone.items.find((d) => d.id === (redo.body as Delivery).id)!.attempts).toBe(1);
    }, 120_000);

    it('rotating the secret signs with both until the old one expires, and the new one is shown once', async () => {
        const path = `/rotate-${stamp}`;
        const created = await as(admin)
            .post(w('/webhooks'))
            .send({ url: receiver.url(path), events: ['*'] });
        const { endpoint, secret: oldSecret } = created.body as { endpoint: Endpoint; secret: string };
        const rotated = await as(admin).post(w(`/webhooks/${endpoint.id}/rotate`));
        expect(rotated.status).toBe(201);
        const { secret: newSecret, endpoint: after } = rotated.body as { endpoint: Endpoint; secret: string };
        expect(newSecret).not.toBe(oldSecret);
        expect(after.secretPrefix).toBe(`whsec_${newSecret.slice(6, 14)}…`);
        expect(after.previousSecretExpiresAt).not.toBeNull();
        await as(admin).post(w(`/webhooks/${endpoint.id}/test`));
        const hit = received.find((r) => r.path === path)!;
        const parsed = parseWebhookSignature(String(hit.headers[WEBHOOK_SIGNATURE_HEADER]))!;
        expect(parsed.signatures).toHaveLength(2);
        expect(parsed.signatures).toContain(hmacHex(newSecret, parsed.timestamp, hit.body));
        expect(parsed.signatures).toContain(hmacHex(oldSecret, parsed.timestamp, hit.body));
    });

    it('another workspace never hears these events, and cannot read this log', async () => {
        const path = `/other-${stamp}`;
        const theirs = await as(other)
            .post(w('/webhooks', otherWorkspace))
            .send({ url: receiver.url(path), events: ['*'] });
        expect(theirs.status).toBe(201);
        const theirEndpoint = (theirs.body as { endpoint: Endpoint }).endpoint;
        const before = received.filter((r) => r.path === path).length;
        await as(admin)
            .post(w('/companies'))
            .send({ name: `Private ${stamp}` });
        await settle(app);
        expect(received.filter((r) => r.path === path).length).toBe(before);
        const theirLog = await deliveriesOf(theirEndpoint.id, other, otherWorkspace);
        expect(theirLog.items.filter((d) => d.eventName !== 'ping')).toHaveLength(0);

        const mine = (await as(admin).get(w('/webhooks'))).body as Endpoint[];
        expect(mine.length).toBeGreaterThan(0);
        const crossList = await as(other).get(w(`/webhooks/${mine[0]!.id}/deliveries`, otherWorkspace));
        expect(crossList.status).toBe(404);
        const crossGet = await as(other).get(w(`/webhooks/${mine[0]!.id}`, otherWorkspace));
        expect(crossGet.status).toBe(404);
        const crossWs = await as(other).get(w('/webhooks'));
        expect(crossWs.status).toBe(403);
    });

    it('a retired endpoint receives nothing more, and its log stays readable', async () => {
        const path = `/retired-${stamp}`;
        const created = await as(admin)
            .post(w('/webhooks'))
            .send({ url: receiver.url(path), events: ['*'] });
        const { endpoint } = created.body as { endpoint: Endpoint };
        await as(admin).post(w(`/webhooks/${endpoint.id}/test`));
        const gone = await as(admin).delete(w(`/webhooks/${endpoint.id}`));
        expect(gone.status).toBe(204);
        expect((await as(admin).get(w(`/webhooks/${endpoint.id}`))).status).toBe(404);
        const before = received.filter((r) => r.path === path).length;
        await as(admin)
            .post(w('/companies'))
            .send({ name: `Retired ${stamp}` });
        await settle(app);
        expect(received.filter((r) => r.path === path).length).toBe(before);
        const log = await deliveriesOf(endpoint.id);
        expect(log.items.some((d) => d.eventName === 'ping')).toBe(true);
        expect(log.items.some((d) => d.eventName === 'company.created')).toBe(false);
    });

    describe('the stranded-delivery sweep', () => {
        /**
         * A delivery row exactly as `enqueueForEvent` writes it, but with no job — what a Redis outage
         * between the row and the `queue.add` leaves behind. Written as the owner (a fixture), with
         * the same envelope shape a real delivery carries.
         */
        async function strandedRow(endpointId: string, overrides: Record<string, unknown> = {}): Promise<string> {
            const owner = app.get(PrismaService);
            const id = crypto.randomUUID();
            await owner.webhookDelivery.create({
                data: {
                    id,
                    workspaceId: workspace,
                    endpointId,
                    eventId: crypto.randomUUID(),
                    eventName: 'company.created',
                    payload: {
                        id,
                        event: 'company.created',
                        occurredAt: new Date().toISOString(),
                        workspaceId: workspace,
                        data: { type: 'company.created', recordId: crypto.randomUUID(), workspaceId: workspace },
                    },
                    ...overrides,
                },
            });
            return id;
        }
        const later = () => Date.now() + WEBHOOK_SWEEP_GRACE_MS + 1_000;
        /** A delay no test run reaches: a job held this long only runs when the test promotes it. */
        const HELD_MS = 60 * 60 * 1_000;
        const hits = (path: string) => received.filter((r) => r.path === path).length;
        const endpointAt = async (path: string) =>
            (
                (
                    await as(admin)
                        .post(w('/webhooks'))
                        .send({ url: receiver.url(path), events: ['company.created'] })
                ).body as { endpoint: Endpoint }
            ).endpoint;

        it('delivers a delivery written while the queue was unavailable, and running it again never sends twice', async () => {
            const path = `/swept-${stamp}`;
            const endpoint = await endpointAt(path);
            const id = await strandedRow(endpoint.id);
            const sweep = app.get(WebhooksSweep);

            const queue = app.get<Queue>(getQueueToken(WEBHOOK_QUEUE));

            // Inside the grace period a fresh row is not stranded: the sweep enqueues nothing for it. The
            // sweep adds jobs before it returns, so the queue's answer is final — no waiting.
            await sweep.run();
            expect(await queue.getJob(id)).toBeUndefined();

            const first = await sweep.run(later());
            expect(first.requeued).toBeGreaterThanOrEqual(1);
            const log = await until(
                () => deliveriesOf(endpoint.id),
                (page) => page.items.some((d) => d.id === id && d.status === 'succeeded'),
            );
            expect(log.items.find((d) => d.id === id)!.attempts).toBe(1);

            // A delivered row is not stranded: later sweeps enqueue nothing, so nothing can send twice.
            await sweep.run(later());
            await sweep.run(later());
            expect(await queue.getJob(id)).toBeUndefined();
            expect(hits(path)).toBe(1);
        });

        it('never gives a delivery that still has a live job a second one', async () => {
            const path = `/live-${stamp}`;
            const endpoint = await endpointAt(path);
            const id = await strandedRow(endpoint.id);
            const queue = app.get<Queue>(getQueueToken(WEBHOOK_QUEUE));
            // The job exists (delayed), as it would mid-retry or just after the subscriber added it. It is
            // held far past this test's horizon and released explicitly below, so how fast the machine
            // runs the sweeps cannot decide whether the job is still there when the assertion reads it.
            await app
                .get(WebhooksService)
                .enqueue({ deliveryId: id, workspaceId: workspace, endpointId: endpoint.id }, HELD_MS);
            await app.get(WebhooksSweep).run(later());
            await app.get(WebhooksSweep).run(later());
            const held = await queue.getJob(id);
            expect(await held?.getState()).toBe('delayed');
            expect(hits(path)).toBe(0);

            await held!.promote();
            await until(
                () => deliveriesOf(endpoint.id),
                (page) => page.items.some((d) => d.id === id && d.status === 'succeeded'),
            );
            // The one job ran and was removed; the sweeps added no second job (same id), so one request.
            expect(await queue.getJob(id)).toBeUndefined();
            expect(hits(path)).toBe(1);
        });

        it('#97 finds a lost delivery behind more live-job deliveries than one page: the sweep resumes, never restarts', async () => {
            const path = `/behind-${stamp}`;
            const endpoint = await endpointAt(path);
            const owner = app.get(PrismaService);
            const queue = app.get<Queue>(getQueueToken(WEBHOOK_QUEUE));
            const service = app.get(WebhooksService);
            // More than a page of stranded-looking rows that do have a live (held) job, all older than the lost one.
            const live = WEBHOOK_SWEEP_BATCH + 100;
            const base = Date.now() - 10 * 60 * 1_000;
            const ids = Array.from({ length: live }, () => crypto.randomUUID());
            await owner.webhookDelivery.createMany({
                data: ids.map((id, i) => ({
                    id,
                    workspaceId: workspace,
                    endpointId: endpoint.id,
                    eventId: crypto.randomUUID(),
                    eventName: 'company.created',
                    payload: { id, event: 'company.created' },
                    createdAt: new Date(base + i),
                })),
            });
            for (let i = 0; i < ids.length; i += 50) {
                await Promise.all(
                    ids
                        .slice(i, i + 50)
                        .map((id) =>
                            service.enqueue(
                                { deliveryId: id, workspaceId: workspace, endpointId: endpoint.id },
                                HELD_MS,
                            ),
                        ),
                );
            }
            const lost = await strandedRow(endpoint.id, { createdAt: new Date(base + live + 1) });

            // Every candidate is eventually examined: within as many passes as the backlog needs.
            const sweep = app.get(WebhooksSweep);
            const passes = Math.ceil((live + 1) / WEBHOOK_SWEEP_BATCH) + 1;
            let found = false;
            for (let pass = 0; pass < passes && !found; pass += 1) {
                await sweep.run(later());
                found = (await queue.getJob(lost)) !== undefined;
            }
            expect(found).toBe(true);

            for (const id of ids) await (await queue.getJob(id))?.remove();
            await owner.webhookDelivery.deleteMany({ where: { id: { in: ids } } });
        });

        it('returns an attempt abandoned mid-flight to pending with its count kept, then delivers it', async () => {
            const path = `/stuck-${stamp}`;
            const endpoint = await endpointAt(path);
            const id = await strandedRow(endpoint.id, {
                status: 'delivering',
                attempts: 1,
                attemptStartedAt: new Date(Date.now() - WEBHOOK_STUCK_DELIVERING_MS - 1_000),
            });
            const result = await app.get(WebhooksSweep).run(later());
            expect(result.freed).toBeGreaterThanOrEqual(1);
            const log = await until(
                () => deliveriesOf(endpoint.id),
                (page) => page.items.some((d) => d.id === id && d.status === 'succeeded'),
            );
            // The abandoned attempt still counts: this was the second.
            expect(log.items.find((d) => d.id === id)!.attempts).toBe(2);
            expect(hits(path)).toBe(1);
        });
    });
});
