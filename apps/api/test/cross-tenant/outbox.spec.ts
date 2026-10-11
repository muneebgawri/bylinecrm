import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, type DomainEvent } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { DomainEvents } from '../../src/events/domain-events.service';
import { OutboxRelay } from '../../src/events/outbox-relay.service';
import {
    OUTBOX_LEASE_MS,
    OUTBOX_MAX_ATTEMPTS,
    OUTBOX_RETENTION_DAYS,
    outboxRetryDelayMs,
} from '../../src/events/outbox.constants';
import { PrismaService } from '../../src/infra/prisma.service';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { TimelineService } from '../../src/timeline/timeline.service';
import { TimelineSubscriber } from '../../src/timeline/timeline.subscriber';
import { WebhooksSubscriber } from '../../src/webhooks/webhooks.subscriber';

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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The transactional outbox (P1-6, #98) end to end. A mutation's event is a row written in the
 * mutation's own transaction — there when the change committed, absent when it rolled back. The
 * relay delivers each row to the consumers at least once: a consumer that fails is retried alone,
 * a relay that dies mid-delivery leaves its claim to expire and the event is delivered again, and
 * the consumers' writes are keyed on the event so nothing appears twice. The rows are tenant data.
 *
 * The relay's timer and commit wake-ups are off in this file (`OUTBOX_RELAY=0`): each test drives
 * delivery itself, with its own clock, so retries and lease expiry happen exactly when it says.
 */
describe('P1-6 transactional outbox (#98)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let relay: OutboxRelay;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    const relayFlag = process.env['OUTBOX_RELAY'];

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;

    const createPerson = async (nameFirst: string): Promise<string> =>
        ((await as(admin).post(w('/people')).send({ nameFirst, nameLast: stamp }).expect(201)).body as { id: string })
            .id;
    const eventFor = (recordId: string, type = 'person.created') =>
        owner.outboxEvent.findFirstOrThrow({
            where: { workspaceId: workspace, type, payload: { path: ['recordId'], equals: recordId } },
        });
    const entriesFor = (recordId: string, kind = 'person.created') =>
        owner.timelineActivity.count({ where: { workspaceId: workspace, targetId: recordId, kind } });

    beforeAll(async () => {
        process.env['OUTBOX_RELAY'] = '0';
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());
        owner = app.get(PrismaService);
        relay = app.get(OutboxRelay);

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `outbox-${stamp}@example.test`, password, workspaceName: 'Outbox Co' })
            .expect(201);
        admin = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;
        const otherSignup = await http()
            .post('/api/auth/signup')
            .send({ email: `outbox-other-${stamp}@example.test`, password, workspaceName: 'Outbox Elsewhere' })
            .expect(201);
        otherWorkspace = (otherSignup.body as { workspace: { id: string } }).workspace.id;
        // Deliver what sign-up recorded, so each test starts from an empty queue.
        await relay.drain();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await app?.close();
        if (relayFlag === undefined) delete process.env['OUTBOX_RELAY'];
        else process.env['OUTBOX_RELAY'] = relayFlag;
    });

    it('P1-6: a mutation records its event in its own transaction, before any consumer has run', async () => {
        const person = await createPerson('Recorded');
        const event = await eventFor(person);
        expect(event.completedAt).toBeNull();
        expect(event.payload).toMatchObject({ type: 'person.created', object: 'person', workspaceId: workspace });
        expect(await entriesFor(person)).toBe(0);

        await relay.drain();
        expect((await owner.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).completedAt).not.toBeNull();
        expect(await entriesFor(person)).toBe(1);
    });

    it('P1-6: a mutation that rolls back records no event, and nothing reaches a consumer', async () => {
        const rls = app.get(RlsPrismaService);
        const events = app.get(DomainEvents);
        let personId = '';
        await expect(
            rls.withWorkspace(workspace, async (tx) => {
                const person = await tx.person.create({
                    data: {
                        workspaceId: workspace,
                        nameFirst: 'Rolled',
                        nameLast: stamp,
                        createdBy: { kind: 'system', id: null },
                    },
                });
                personId = person.id;
                await events.record(tx, {
                    type: 'person.created',
                    object: 'person',
                    workspaceId: workspace,
                    actor: { kind: 'system', id: null },
                    occurredAt: new Date().toISOString(),
                    recordId: person.id,
                } as DomainEvent);
                throw new Error('the change fails after its event was recorded');
            }),
        ).rejects.toThrow('the change fails');
        expect(personId).not.toBe('');
        expect(await owner.person.count({ where: { id: personId } })).toBe(0);
        expect(await owner.outboxEvent.count({ where: { payload: { path: ['recordId'], equals: personId } } })).toBe(0);
        await relay.drain();
        expect(await entriesFor(personId)).toBe(0);
    });

    it('P1-6: recording an event outside a transaction is refused, not silently dropped', async () => {
        const events = app.get(DomainEvents);
        await expect(
            events.record(
                {} as never,
                {
                    type: 'person.created',
                    object: 'person',
                    workspaceId: workspace,
                    actor: { kind: 'system', id: null },
                    occurredAt: new Date().toISOString(),
                    recordId: workspace,
                } as DomainEvent,
            ),
        ).rejects.toThrow('must be called inside withWorkspace');
    });

    it('P1-6: a consumer that fails is retried alone after its wait, and its entry appears exactly once', async () => {
        const writeFor = vi
            .spyOn(app.get(TimelineService), 'writeFor')
            .mockRejectedValueOnce(new Error('timeline down'));
        const enqueue = vi.spyOn(app.get(WebhooksSubscriber), 'consume');
        const person = await createPerson('Retried');
        const event = await eventFor(person);

        const now = Date.now();
        await relay.runOnce(new Date(now));
        const failed = await owner.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(failed.completedAt).toBeNull();
        expect(failed.attempts).toBe(1);
        expect(failed.lastError).toContain('timeline: timeline down');
        expect(failed.completedConsumers).toContain('webhooks');
        expect(failed.completedConsumers).not.toContain('timeline');
        expect(failed.nextAttemptAt?.getTime()).toBe(now + outboxRetryDelayMs(1));
        expect(await entriesFor(person)).toBe(0);

        // Not due yet: a scan before the wait is over leaves it alone.
        await relay.runOnce(new Date(now + outboxRetryDelayMs(1) - 1));
        expect((await owner.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).attempts).toBe(1);

        const webhookCalls = enqueue.mock.calls.length;
        await relay.runOnce(new Date(now + outboxRetryDelayMs(1)));
        const done = await owner.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(done.completedAt).not.toBeNull();
        expect(done.attempts).toBe(2);
        expect(done.lastError).toBeNull();
        expect(await entriesFor(person)).toBe(1);
        expect(writeFor).toHaveBeenCalledTimes(2);
        // The consumer that had finished was not run again.
        expect(enqueue.mock.calls.length).toBe(webhookCalls);
    });

    it('P1-6: an event whose relay died mid-delivery is delivered again after its lease — no entry and no webhook delivery twice', async () => {
        const endpoint = await as(admin)
            .post(w('/webhooks'))
            .send({ url: 'http://127.0.0.1:9/outbox-redelivery', events: ['person.created'] })
            .expect(201);
        const endpointId = (endpoint.body as { endpoint: { id: string } }).endpoint.id;
        const person = await createPerson('Redelivered');
        const event = await eventFor(person);

        // A relay claims the event and runs the consumers, then dies before it records the outcome.
        const claimedAt = Date.now();
        await owner.outboxEvent.update({
            where: { id: event.id },
            data: { attempts: 1, leaseUntil: new Date(claimedAt + OUTBOX_LEASE_MS) },
        });
        const delivered = { id: event.id, event: event.payload as unknown as DomainEvent };
        await app.get(TimelineSubscriber).consume(delivered);
        await app.get(WebhooksSubscriber).consume(delivered);
        expect(await entriesFor(person)).toBe(1);
        expect(await owner.webhookDelivery.count({ where: { eventId: event.id, endpointId } })).toBe(1);

        // While the claim holds, no other scan takes the event.
        await relay.runOnce(new Date(claimedAt + OUTBOX_LEASE_MS - 1));
        expect((await owner.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).attempts).toBe(1);
        // Once it expires, the event is delivered again — and the consumers write nothing new.
        await relay.runOnce(new Date(claimedAt + OUTBOX_LEASE_MS));
        const done = await owner.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(done.completedAt).not.toBeNull();
        expect(done.attempts).toBe(2);
        expect(await entriesFor(person)).toBe(1);
        expect(await owner.webhookDelivery.count({ where: { eventId: event.id, endpointId } })).toBe(1);
    });

    it('P1-6: an event that fails every attempt is marked failed and kept, never retried again', async () => {
        vi.spyOn(app.get(TimelineService), 'writeFor').mockRejectedValue(new Error('timeline down for good'));
        const person = await createPerson('Doomed');
        const event = await eventFor(person);
        await owner.outboxEvent.update({ where: { id: event.id }, data: { attempts: OUTBOX_MAX_ATTEMPTS - 1 } });

        await relay.runOnce(new Date());
        const failed = await owner.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(failed.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
        expect(failed.failedAt).not.toBeNull();
        expect(failed.completedAt).toBeNull();
        expect(failed.lastError).toContain('timeline down for good');
        await relay.runOnce(new Date(Date.now() + DAY_MS));
        expect((await owner.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).attempts).toBe(
            OUTBOX_MAX_ATTEMPTS,
        );
    });

    it('P1-6: retention removes delivered events past their days and keeps the rest', async () => {
        const person = await createPerson('Pruned');
        await relay.drain();
        const event = await eventFor(person);
        const now = Date.now();
        await owner.outboxEvent.update({
            where: { id: event.id },
            data: { completedAt: new Date(now - OUTBOX_RETENTION_DAYS.completed * DAY_MS - 1) },
        });
        const fresh = await eventFor(await createPerson('Kept'));
        await relay.drain();

        await relay.prune(now);
        expect(await owner.outboxEvent.count({ where: { id: event.id } })).toBe(0);
        expect(await owner.outboxEvent.count({ where: { id: fresh.id } })).toBe(1);
    });

    it('P1-6: outbox rows are tenant data — another workspace sees none, and the app role cannot rewrite or delete them', async () => {
        const rls = app.get(RlsPrismaService);
        const person = await createPerson('Isolated');
        const event = await eventFor(person);

        expect(await rls.withWorkspace(workspace, (tx) => tx.outboxEvent.count({ where: { id: event.id } }))).toBe(1);
        expect(await rls.withWorkspace(otherWorkspace, (tx) => tx.outboxEvent.count({ where: { id: event.id } }))).toBe(
            0,
        );
        // Recording into another workspace from this one is refused by the policy.
        await expect(
            rls.withWorkspace(otherWorkspace, (tx) =>
                tx.outboxEvent.create({
                    data: { id: crypto.randomUUID(), workspaceId: workspace, type: 'person.created', payload: {} },
                }),
            ),
        ).rejects.toThrow();
        // Delivery state is the relay's (owner): the app role may append, never update or delete.
        const denied = (fn: () => Promise<unknown>) =>
            expect(fn()).rejects.toSatisfy(
                (error: unknown) =>
                    error instanceof Prisma.PrismaClientKnownRequestError ||
                    error instanceof Prisma.PrismaClientUnknownRequestError,
            );
        await denied(() =>
            rls.withWorkspace(workspace, (tx) =>
                tx.outboxEvent.update({ where: { id: event.id }, data: { completedAt: new Date() } }),
            ),
        );
        await denied(() => rls.withWorkspace(workspace, (tx) => tx.outboxEvent.delete({ where: { id: event.id } })));
        await relay.drain();
    });
});
