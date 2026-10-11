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

    /** A receiver that answers 200, so the worker never disables the endpoint this spec counts on (#110). */
    let hooks: WebhookReceiver;

    beforeAll(async () => {
        hooks = await new WebhookReceiver().start();
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
        await verifyAddress(app, http, `outbox-${stamp}@example.test`);
        admin = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;
        const otherSignup = await http()
            .post('/api/auth/signup')
            .send({ email: `outbox-other-${stamp}@example.test`, password, workspaceName: 'Outbox Elsewhere' })
            .expect(201);
        await verifyAddress(app, http, `outbox-other-${stamp}@example.test`);
        otherWorkspace = (otherSignup.body as { workspace: { id: string } }).workspace.id;
        // Deliver what sign-up recorded, so each test starts from an empty queue.
        await relay.drain();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await app?.close();
        await hooks?.close();
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
            .send({ url: hooks.url('/outbox-redelivery'), events: ['person.created'] })
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
    describe('two relays on one database (#110)', () => {
        let second: INestApplication;
        let relayB: OutboxRelay;
        /** Which consumer received which event, from either process. */
        let calls: { consumer: string; relay: 'A' | 'B'; id: string }[];

        const watch = (target: INestApplication, relayName: 'A' | 'B') => {
            for (const [consumer, type] of [
                ['timeline', TimelineSubscriber],
                ['webhooks', WebhooksSubscriber],
            ] as const) {
                const instance = target.get(type);
                const consume = instance.consume.bind(instance);
                vi.spyOn(instance, 'consume').mockImplementation(async (delivered) => {
                    calls.push({ consumer, relay: relayName, id: delivered.id });
                    return consume(delivered);
                });
            }
        };
        /** Records `count` events about one person in one transaction; returns their outbox ids. */
        const recordMany = async (count: number): Promise<string[]> => {
            const person = await createPerson('Concurrent');
            await relay.drain();
            const mark = (await owner.outboxEvent.aggregate({ _max: { seq: true } }))._max.seq ?? 0n;
            await app.get(RlsPrismaService).withWorkspace(workspace, (tx) =>
                app.get(DomainEvents).recordAll(
                    tx,
                    Array.from({ length: count }, (_, i): DomainEvent => ({
                        type: 'person.updated',
                        object: 'person',
                        workspaceId: workspace,
                        actor: { kind: 'system', id: null },
                        occurredAt: new Date().toISOString(),
                        recordId: person,
                        diff: { jobTitle: { from: null, to: `Title ${i}` } },
                    })),
                ),
            );
            const rows = await owner.outboxEvent.findMany({ where: { seq: { gt: mark } }, select: { id: true } });
            expect(rows).toHaveLength(count);
            return rows.map((r) => r.id);
        };
        const consumedBy = (consumer: string, ids: readonly string[]) => {
            const mine = new Set(ids);
            return calls.filter((c) => c.consumer === consumer && mine.has(c.id));
        };

        beforeAll(async () => {
            // A second process: its own application, its own connection pools, the same database.
            second = await createApp();
            await second.init();
            relayB = second.get(OutboxRelay);
        });

        afterAll(async () => {
            await second?.close();
        });

        it('P1-6a: scanning at the same moment, they deliver every event exactly once per consumer — no claim is shared', async () => {
            calls = [];
            watch(app, 'A');
            watch(second, 'B');
            const ids = await recordMany(120);
            const now = new Date();
            // Both relays scan over and over, at once, until neither finds anything due.
            for (;;) {
                const claimed = await Promise.all([
                    relay.runOnce(now),
                    relayB.runOnce(now),
                    relay.runOnce(now),
                    relayB.runOnce(now),
                ]);
                if (claimed.every((n) => n === 0)) break;
            }

            for (const consumer of ['timeline', 'webhooks']) {
                const got = consumedBy(consumer, ids);
                expect(got).toHaveLength(ids.length);
                expect(new Set(got.map((c) => c.id)).size).toBe(ids.length);
            }
            // The work really was shared between the two processes.
            const byRelay = new Set(consumedBy('timeline', ids).map((c) => c.relay));
            expect(byRelay).toEqual(new Set(['A', 'B']));
            const open = await owner.outboxEvent.count({ where: { id: { in: ids }, completedAt: null } });
            expect(open).toBe(0);
            const attempts = await owner.outboxEvent.findMany({
                where: { id: { in: ids } },
                select: { attempts: true },
            });
            expect(attempts.every((r) => r.attempts === 1)).toBe(true);
        });

        it('P1-6a: an event a relay holds is not taken by the other until the lease expires, then the other delivers it', async () => {
            calls = [];
            const [id] = await recordMany(1);
            // Relay A's timeline consumer stalls (a process that hangs mid-delivery).
            const timeline = app.get(TimelineSubscriber);
            let release!: () => void;
            const stalled = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const consume = timeline.consume.bind(timeline);
            vi.spyOn(timeline, 'consume').mockImplementation(async (delivered) => {
                calls.push({ consumer: 'timeline', relay: 'A', id: delivered.id });
                entered();
                await stalled;
                return consume(delivered);
            });
            watch(second, 'B');

            const claimedAt = Date.now();
            const held = relay.runOnce(new Date(claimedAt));
            // A is inside the consumer, holding the claim.
            await inside;

            // While A's lease holds, B's scans leave the event alone.
            await relayB.runOnce(new Date(claimedAt + OUTBOX_LEASE_MS - 1));
            expect(consumedBy('timeline', [id!]).filter((c) => c.relay === 'B')).toHaveLength(0);

            // Once it expires, B claims and delivers it.
            await relayB.runOnce(new Date(claimedAt + OUTBOX_LEASE_MS));
            expect(consumedBy('timeline', [id!]).filter((c) => c.relay === 'B')).toHaveLength(1);
            const handedOver = await owner.outboxEvent.findUniqueOrThrow({ where: { id: id! } });
            expect(handedOver.completedAt).not.toBeNull();
            expect(handedOver.attempts).toBe(2);

            // A wakes up and finishes too: a second delivery, which the consumers make harmless.
            release();
            await held;
            const event = await owner.outboxEvent.findUniqueOrThrow({ where: { id: id! } });
            const entries = await owner.timelineActivity.count({ where: { eventId: id! } });
            expect(event.completedAt).not.toBeNull();
            expect(entries).toBe(1);
        });
    });
});
