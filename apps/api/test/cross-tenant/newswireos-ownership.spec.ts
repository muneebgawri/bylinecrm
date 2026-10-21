import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, SYSTEM_ROLES, type DomainEvent } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import type { DeliveredEvent } from '../../src/events/outbox-consumer';
import { PrismaService } from '../../src/infra/prisma.service';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { NewswireosApiError } from '../../src/invoices/newswireos-verification.port';
import { OWNERSHIP_PUSH_QUEUE, OWNERSHIP_PUSH_STUCK_MS } from '../../src/invoices/invoices.constants';
import { NEWSWIREOS_OWNERSHIP_PORT } from '../../src/invoices/ownership-push.port';
import { OwnershipPushService } from '../../src/invoices/ownership-push.service';
import type { OwnershipDeliveryView, OwnershipPushPreview } from '../../src/invoices/responses';
import { TRANSFER_REASON_IMPORT_FILL } from '../../src/transfers/transfers.service';
import { FakeNewswireosOwnership } from '../support/fake-newswireos-ownership';
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
 * PNW-765: completed ownership transfers pushed to NewswireOS (a fake here). Off by default; on, every completed
 * transfer of a record with an address becomes one delivery keyed on its event, sent by the worker: a match is
 * recorded, a 4xx is final, a 5xx is retried and then fails, a 404 is "not ready" and never retried. An import's
 * owner fill is never pushed. Nothing crosses workspaces.
 */
describe('PNW-765 ownership push to NewswireOS', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let rls: RlsPrismaService;
    let push: OwnershipPushService;
    const newswireos = new FakeNewswireosOwnership();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const emails = {
        admin: `own-push-admin-${stamp}@example.com`,
        ben: `own-push-ben-${stamp}@example.com`,
        other: `own-push-other-${stamp}@example.com`,
    };
    let admin: Browser;
    let ben: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let adminId: string;
    let benId: string;
    let person: string;
    const personEmail = `dana@ortiz-${stamp}.test`;

    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const deliveries = async (who = admin, id = workspace) =>
        (await as(who).get(w('/integrations/newswireos/ownership-push/deliveries', id)).expect(200))
            .body as OwnershipDeliveryView[];
    const toggle = (enabled: boolean, who = admin, id = workspace) =>
        as(who).put(w('/integrations/newswireos/ownership-push', id)).send({ enabled });
    /** Forces the record to `to` (the admin holds `record:transfer`) and lets the outbox deliver the event. */
    const move = async (recordId: string, to: string, object = 'person') => {
        const res = await as(admin).post(w('/transfers')).send({ object, recordId, toMemberId: to });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect((res.body as { status: string }).status).toBe('forced');
        await settle(app);
    };
    const latest = async () => (await deliveries())[0]!;
    const run = (deliveryId: string, finalAttempt = false, id = workspace) =>
        push.deliver(id, deliveryId, { finalAttempt });
    const delivered = async (eventId: string): Promise<DeliveredEvent> => {
        const row = await owner.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
        return { id: row.id, event: row.payload as unknown as DomainEvent };
    };

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(NEWSWIREOS_OWNERSHIP_PORT)
            .useValue(newswireos)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        rls = app.get(RlsPrismaService);
        push = app.get(OwnershipPushService);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, id: workspace } = await signUp(emails.admin, `Own push ${stamp}`));
        ({ browser: otherAdmin, id: otherWorkspace } = await signUp(emails.other, `Own push other ${stamp}`));

        const roles = (await as(admin).get(w('/roles')).expect(200)).body as { id: string; name: string }[];
        const invite = await as(admin)
            .post(w('/invites'))
            .send({ email: emails.ben, roleId: roles.find((r) => r.name === SYSTEM_ROLES.member)!.id })
            .expect(201);
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password })
            .expect(201);
        await verifyAddress(app, http, emails.ben);
        ben = browserFrom(joined);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        adminId = members.find((m) => m.email === emails.admin)!.id;
        benId = members.find((m) => m.email === emails.ben)!.id;

        person = (
            (
                await as(admin)
                    .post(w('/people'))
                    .send({ nameFirst: 'Dana', nameLast: 'Ortiz', emails: { primary: personEmail, additional: [] } })
                    .expect(201)
            ).body as { id: string }
        ).id;
        await as(admin)
            .put(w('/integrations/newswireos'))
            .send({ baseUrl: 'https://newswireos.example.test', apiToken: `nw_${stamp}` })
            .expect(200);
    });

    afterAll(async () => {
        await app?.close();
    });

    beforeEach(() => newswireos.reset());

    it('is off by default: a transfer while it is off writes and sends nothing', async () => {
        const settings = (await as(admin).get(w('/integrations/newswireos')).expect(200)).body as {
            pushOwnership: boolean;
        };
        expect(settings.pushOwnership).toBe(false);
        await move(person, benId);
        expect(await deliveries()).toEqual([]);
        expect(newswireos.calls).toHaveLength(0);
    });

    it('only an admin turns it on, and only with a link', async () => {
        expect((await toggle(true, ben)).status).toBe(403);
        expect((await toggle(true, otherAdmin, otherWorkspace)).status).toBe(404);
        const on = await toggle(true).expect(200);
        expect((on.body as { pushOwnership: boolean }).pushOwnership).toBe(true);
    });

    it('a forced transfer becomes one delivery, keyed on its event; a match is recorded', async () => {
        await move(person, adminId);
        const queued = await deliveries();
        expect(queued).toHaveLength(1);
        const d = queued[0]!;
        expect(d).toMatchObject({ status: 'pending', recordType: 'person', recordId: person, attempts: 0 });

        // A redelivered event writes nothing new.
        await push.enqueueForEvent(await delivered(d.eventId));
        expect(await deliveries()).toHaveLength(1);

        expect(await run(d.id)).toBe('done');
        expect(newswireos.calls).toHaveLength(1);
        expect(newswireos.calls[0]!.link).toEqual({
            baseUrl: 'https://newswireos.example.test',
            apiToken: `nw_${stamp}`,
        });
        expect(newswireos.calls[0]!.body).toEqual({
            event_id: d.eventId,
            occurred_at: expect.any(String) as string,
            record_type: 'person',
            record: { byline_id: person, emails: [personEmail], name: 'Dana Ortiz' },
            previous_owner: { email: emails.ben },
            new_owner: { email: emails.admin },
            reason: 'forced',
            forced: true,
        });
        expect(await latest()).toMatchObject({
            status: 'delivered',
            attempts: 1,
            matched: true,
            customers: [{ customerId: 'cus_1', reasonCode: 'REASSIGNED' }],
            reasonCode: 'REASSIGNED',
            httpStatus: 200,
            lastError: null,
        });
        // Done is done: running it again sends nothing.
        expect(await run(d.id)).toBe('done');
        expect(newswireos.calls).toHaveLength(1);
    });

    it('a 4xx is final: no retry, NewswireOS’s reason kept', async () => {
        await move(person, benId);
        newswireos.next(new NewswireosApiError(422, 'emails: invalid', 'INVALID_PAYLOAD'));
        const d = await latest();
        expect(await run(d.id)).toBe('done');
        expect(await latest()).toMatchObject({
            id: d.id,
            status: 'failed',
            httpStatus: 422,
            reasonCode: 'INVALID_PAYLOAD',
            lastError: 'emails: invalid',
        });
    });

    it('a 5xx or no answer is retried, then fails on the last attempt', async () => {
        await move(person, adminId);
        newswireos.next(
            new NewswireosApiError(503, 'NewswireOS answered 503'),
            new NewswireosApiError(null, 'timeout'),
        );
        const d = await latest();
        expect(await run(d.id)).toBe('retry');
        expect(await latest()).toMatchObject({ status: 'retrying', attempts: 1, httpStatus: 503 });
        expect(await run(d.id, true)).toBe('done');
        expect(await latest()).toMatchObject({
            status: 'failed',
            attempts: 2,
            httpStatus: null,
            reasonCode: 'NEWSWIREOS_UNAVAILABLE',
        });
        expect(newswireos.calls.map((c) => c.body.event_id)).toEqual([d.eventId, d.eventId]);
    });

    it('a 404 (the route not deployed yet) is "not ready" and never retried', async () => {
        await move(person, benId);
        newswireos.next(new NewswireosApiError(404, 'Not Found'));
        const d = await latest();
        expect(await run(d.id)).toBe('done');
        expect(await latest()).toMatchObject({ status: 'not_ready', reasonCode: 'NEWSWIREOS_NOT_READY', attempts: 1 });
    });

    it('STALE and NO_AM_FOR_EMAIL are final whatever status they come with; a 403 says the scope is missing', async () => {
        for (const [error, reasonCode] of [
            [new NewswireosApiError(409, 'an older change', 'STALE'), 'STALE'],
            [new NewswireosApiError(503, 'no account manager', 'NO_AM_FOR_EMAIL'), 'NO_AM_FOR_EMAIL'],
            [new NewswireosApiError(403, 'forbidden'), 'TOKEN_LACKS_SCOPE'],
            [new NewswireosApiError(400, 'malformed'), 'BAD_REQUEST'],
        ] as const) {
            await move(person, (await latest()).newOwnerEmail === emails.ben ? adminId : benId);
            newswireos.next(error);
            const d = await latest();
            expect(await run(d.id)).toBe('done');
            expect(await latest()).toMatchObject({ id: d.id, status: 'failed', reasonCode, attempts: 1 });
        }
    });

    it('the sweep re-queues a delivery stuck pending with no job, once', async () => {
        await move(person, (await latest()).newOwnerEmail === emails.ben ? adminId : benId);
        const d = await latest();
        expect(d.status).toBe('pending');
        const queue = app.get<Queue>(getQueueToken(OWNERSHIP_PUSH_QUEUE));
        // Redis lost the job.
        await (await queue.getJob(d.id))?.remove();
        // Not yet stuck: left alone.
        await push.sweep();
        expect(await queue.getJob(d.id)).toBeFalsy();
        // Stuck: queued again, under the delivery's id; a second pass adds nothing.
        const later = Date.now() + OWNERSHIP_PUSH_STUCK_MS + 60_000;
        expect(await push.sweep(later)).toBeGreaterThanOrEqual(1);
        expect((await queue.getJob(d.id))?.data).toEqual({ workspaceId: workspace, deliveryId: d.id });
        const again = await push.sweep(later);
        expect(await queue.getJob(d.id)).toBeTruthy();
        expect(again).toBe(0);
        await (await queue.getJob(d.id))?.remove();
        // Delivered: never swept.
        expect(await run(d.id)).toBe('done');
        await push.sweep(later);
        expect(await queue.getJob(d.id)).toBeFalsy();
    });

    it('an import’s owner fill is never pushed', async () => {
        const base = await delivered((await latest()).eventId);
        const transfer = (base.event as DomainEvent & { transfer: { reason: string | null } }).transfer;
        const fill = {
            id: randomUUID(),
            event: { ...base.event, transfer: { ...transfer, reason: TRANSFER_REASON_IMPORT_FILL } } as DomainEvent,
        };
        expect(OwnershipPushService.accepts(fill.event)).toBe(false);
        expect(OwnershipPushService.accepts({ ...base.event, internal: true } as DomainEvent)).toBe(false);
        expect(OwnershipPushService.accepts(base.event)).toBe(true);
        const before = (await deliveries()).length;
        await push.enqueueForEvent(fill);
        expect(await deliveries()).toHaveLength(before);
    });

    it('a record with no address is not pushed', async () => {
        const nameless = (
            (await as(admin).post(w('/people')).send({ nameFirst: 'No', nameLast: 'Address' }).expect(201)).body as {
                id: string;
            }
        ).id;
        const before = (await deliveries()).length;
        await move(nameless, benId);
        expect(await deliveries()).toHaveLength(before);
    });

    it('turned off, a delivery already queued is skipped, not sent; new transfers write nothing', async () => {
        const to = (await latest()).newOwnerEmail === emails.ben ? adminId : benId;
        await move(person, to);
        const d = await latest();
        expect(d.status).toBe('pending');
        await toggle(false).expect(200);
        expect(await run(d.id)).toBe('done');
        expect(await latest()).toMatchObject({ id: d.id, status: 'skipped', reasonCode: 'PUSH_OFF' });
        await move(person, to === adminId ? benId : adminId);
        expect((await latest()).id).toBe(d.id);
        expect(newswireos.calls).toHaveLength(0);
    });

    it('"Send test" sends nothing and shows the body a push would send', async () => {
        const res = await as(admin).post(w('/integrations/newswireos/ownership-push/test')).expect(200);
        const preview = res.body as OwnershipPushPreview;
        expect(preview.sent).toBe(false);
        expect(preview.payload).toMatchObject({
            test: true,
            new_owner: { email: emails.admin },
            record_type: 'person',
        });
        expect(newswireos.calls).toHaveLength(0);
        expect((await as(ben).post(w('/integrations/newswireos/ownership-push/test'))).status).toBe(403);
    });

    describe('cross-tenant', () => {
        it('another workspace neither lists nor reads nor sends this workspace’s deliveries', async () => {
            const ours = await deliveries();
            expect(ours.length).toBeGreaterThan(0);
            expect(await deliveries(otherAdmin, otherWorkspace)).toEqual([]);
            const foreign = await as(otherAdmin).get(w('/integrations/newswireos/ownership-push/deliveries'));
            expect([403, 404]).toContain(foreign.status);
            expect((await as(ben).get(w('/integrations/newswireos/ownership-push/deliveries'))).status).toBe(403);

            const seen = await rls.withWorkspace(otherWorkspace, (tx) =>
                tx.newswireosOwnershipDelivery.findMany({ where: { id: { in: ours.map((d) => d.id) } } }),
            );
            expect(seen).toEqual([]);
            // A pending row of ours, run under the other workspace: invisible there, so nothing is sent.
            await owner.newswireosOwnershipDelivery.update({ where: { id: ours[0]!.id }, data: { status: 'pending' } });
            expect(await run(ours[0]!.id, false, otherWorkspace)).toBe('done');
            expect(newswireos.calls).toHaveLength(0);
        });

        it('the app role cannot write a delivery into another workspace', async () => {
            const ours = (await deliveries())[0]!;
            await expect(
                rls.withWorkspace(otherWorkspace, (tx) =>
                    tx.newswireosOwnershipDelivery.create({
                        data: {
                            workspaceId: workspace,
                            eventId: randomUUID(),
                            transferId: ours.transferId,
                            recordType: 'person',
                            recordId: person,
                            payload: {},
                        },
                    }),
                ),
            ).rejects.toThrow();
            const updated = await rls.withWorkspace(otherWorkspace, (tx) =>
                tx.newswireosOwnershipDelivery.updateMany({ where: { id: ours.id }, data: { status: 'failed' } }),
            );
            expect(updated.count).toBe(0);
        });
    });
});
