import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    SYSTEM_ROLES,
    TWENTY_IMPORT_SOURCE,
    type DomainEvent,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import type { DeliveredEvent } from '../../src/events/outbox-consumer';
import { PrismaService } from '../../src/infra/prisma.service';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { NEWSWIREOS_DEAL_WON_PORT } from '../../src/invoices/deal-won-push.port';
import { DealWonPushService } from '../../src/invoices/deal-won-push.service';
import { NEWSWIREOS_SIGNATURE_HEADER } from '../../src/invoices/invoices.constants';
import { NewswireosApiError } from '../../src/invoices/newswireos-verification.port';
import type { DealWonDeliveryView, DealWonPushPreview } from '../../src/invoices/responses';
import { FakeNewswireosDealWon } from '../support/fake-newswireos-deal-won';
import { verifyAddress } from '../support/mail';
import { settle } from '../support/outbox';

type Who = { cookie: string; csrf: string };
type Stage = { id: string; kind: 'open' | 'won' | 'lost' };
type Entry = { kind: string; target: { type: string; id: string }; properties: Record<string, unknown> };

function browserFrom(res: Response): Who {
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
 * PNW-766 (doc 11 §8s): won deals pushed to NewswireOS (a fake here), and NewswireOS's client activity on the
 * timeline through the payment hook. The push is off by default; on, a won deal with a contact who has an email is
 * one delivery keyed on its event, and NewswireOS's client id is kept on the person (the company keeps its first).
 * A timeline event is stored once whether it matches or not, put on the record it names (its ids, then email, then
 * domain), and `client.created`/`am.assigned` keep the client's exclusion. Nothing crosses workspaces.
 */
describe('PNW-766 deal won and the NewswireOS timeline', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let rls: RlsPrismaService;
    let push: DealWonPushService;
    const newswireos = new FakeNewswireosDealWon();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const domain = `acme-${stamp}.test`;
    const secret = `whsec_${stamp}`;
    const otherSecret = `whsec_other_${stamp}`;
    let a: { who: Who; id: string; email: string };
    let b: { who: Who; id: string; email: string };
    let stages: Stage[];
    let companyId: string;
    let personId: string;
    let hookUrl: string;
    let otherHookUrl: string;

    const as = (who: Who) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, ws = a.id) => `/api/w/${ws}${path}`;
    const won = () => stages.find((s) => s.kind === 'won')!;
    const deliveries = async (ws = a) =>
        (await as(ws.who).get(w('/integrations/newswireos/deal-won-push/deliveries', ws.id)).expect(200))
            .body as DealWonDeliveryView[];
    const latest = async () => (await deliveries())[0]!;
    const toggle = (enabled: boolean, ws = a) =>
        as(ws.who).put(w('/integrations/newswireos/deal-won-push', ws.id)).send({ enabled });
    const newCompany = async (name: string, d: string) =>
        ((await as(a.who).post(w('/companies')).send({ name, domain: d }).expect(201)).body as { id: string }).id;
    const newPerson = async (nameFirst: string, company: string, email?: string) =>
        (
            (
                await as(a.who)
                    .post(w('/people'))
                    .send({
                        nameFirst,
                        nameLast: 'Test',
                        companyId: company,
                        ...(email ? { emails: { primary: email, additional: [] } } : {}),
                    })
                    .expect(201)
            ).body as { id: string }
        ).id;
    /** A deal with the contact at the company, moved into the won stage; the outbox delivers its `deal.won`. */
    const winDeal = async (name: string, contact = personId, company = companyId) => {
        const deal = (
            (
                await as(a.who)
                    .post(w('/opportunities'))
                    .send({
                        name,
                        companyId: company,
                        pointOfContactId: contact,
                        amount: { amountMinor: 250_000, currency: 'USD' },
                    })
                    .expect(201)
            ).body as { id: string }
        ).id;
        await as(a.who)
            .post(w(`/opportunities/${deal}/move`))
            .send({ stageId: won().id, close: {} })
            .expect(201);
        await settle(app);
        return deal;
    };
    const run = (deliveryId: string, finalAttempt = false, ws = a.id) => push.deliver(ws, deliveryId, { finalAttempt });
    const delivered = async (eventId: string): Promise<DeliveredEvent> => {
        const row = await owner.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
        return { id: row.id, event: row.payload as unknown as DomainEvent };
    };
    const timeline = async (target: string, ws = a) =>
        (
            (
                await as(ws.who)
                    .get(w(`/timeline?target=${target}&kinds=external.`, ws.id))
                    .expect(200)
            ).body as {
                items: Entry[];
            }
        ).items;
    /** A delivery in NewswireOS's outbound format: `{id, event_type, occurred_at, data}`, `sha256=`-signed. */
    const hook = (
        type: string,
        data: Record<string, unknown> | null,
        opts: { id?: string; url?: string; key?: string } = {},
    ) => {
        const id = opts.id ?? `evt_${randomUUID()}`;
        const raw = JSON.stringify({ id, event_type: type, occurred_at: '2026-10-22T09:00:00Z', data });
        return http()
            .post(new URL(opts.url ?? hookUrl).pathname)
            .set('content-type', 'application/json')
            .set('x-webhook-id', id)
            .set('x-webhook-event', type)
            .set(
                NEWSWIREOS_SIGNATURE_HEADER,
                `sha256=${createHmac('sha256', opts.key ?? secret)
                    .update(raw)
                    .digest('hex')}`,
            )
            .send(raw);
    };
    const client = (c: Record<string, unknown>) => ({
        customer_id: 'cus_1',
        email: null,
        name: 'Ana Test',
        company_domain: null,
        byline_contact_id: null,
        byline_company_id: null,
        ...c,
    });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(NEWSWIREOS_DEAL_WON_PORT)
            .useValue(newswireos)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        rls = app.get(RlsPrismaService);
        push = app.get(DealWonPushService);
        const signUp = async (email: string) => {
            const res = await http()
                .post('/api/auth/signup')
                .send({ email, password: 'correct horse battery staple', workspaceName: email });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { who: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id, email };
        };
        a = await signUp(`deal-won-a-${stamp}@example.test`);
        b = await signUp(`deal-won-b-${stamp}@example.test`);
        stages = ((await as(a.who).get(w('/pipelines')).expect(200)).body as { stages: Stage[] }[])[0]!.stages;
        companyId = await newCompany('Acme', domain);
        personId = await newPerson('Ana', companyId, `ana@${domain}`);
        const link = async (ws: typeof a, key: string) =>
            (
                (
                    await as(ws.who)
                        .put(w('/integrations/newswireos', ws.id))
                        .send({ baseUrl: 'https://newswireos.example.test', apiToken: `nwos_${stamp}`, secret: key })
                        .expect(200)
                ).body as { hookUrl: string }
            ).hookUrl;
        hookUrl = await link(a, secret);
        otherHookUrl = await link(b, otherSecret);
    });

    afterAll(async () => {
        await app?.close();
    });

    beforeEach(() => newswireos.reset());

    describe('deal won → NewswireOS', () => {
        it('is off by default: a win while it is off writes and sends nothing', async () => {
            const settings = (await as(a.who).get(w('/integrations/newswireos')).expect(200)).body as {
                pushDealWon: boolean;
            };
            expect(settings.pushDealWon).toBe(false);
            await winDeal(`Off ${stamp}`);
            expect(await deliveries()).toEqual([]);
            expect(newswireos.calls).toHaveLength(0);
        });

        it('is an admin’s to turn on, and only with a link', async () => {
            const unlinked = await http()
                .post('/api/auth/signup')
                .send({
                    email: `deal-won-c-${stamp}@example.test`,
                    password: 'correct horse battery staple',
                    workspaceName: 'c',
                });
            const c = { who: browserFrom(unlinked), id: (unlinked.body as { workspace: { id: string } }).workspace.id };
            await verifyAddress(app, http, `deal-won-c-${stamp}@example.test`);
            expect(
                (await as(c.who).put(w('/integrations/newswireos/deal-won-push', c.id)).send({ enabled: true })).status,
            ).toBe(404);
            const on = await toggle(true).expect(200);
            expect(on.body).toMatchObject({ pushDealWon: true, pushOwnership: false });
        });

        it('a won deal becomes one delivery keyed on its event; the client id is kept on the person and company', async () => {
            const deal = await winDeal(`Won ${stamp}`);
            const queued = await deliveries();
            expect(queued).toHaveLength(1);
            const d = queued[0]!;
            expect(d).toMatchObject({ status: 'pending', opportunityId: deal, personId, companyId, attempts: 0 });

            // A redelivered event writes nothing new.
            await push.enqueueForEvent(await delivered(d.eventId));
            expect(await deliveries()).toHaveLength(1);

            expect(await run(d.id)).toBe('done');
            expect(newswireos.calls).toHaveLength(1);
            expect(newswireos.calls[0]!.link).toEqual({
                baseUrl: 'https://newswireos.example.test',
                apiToken: `nwos_${stamp}`,
            });
            expect(newswireos.calls[0]!.body).toEqual({
                event_id: d.eventId,
                occurred_at: expect.any(String) as string,
                deal: { byline_id: deal, name: `Won ${stamp}`, amount_minor: 250_000, currency: 'USD' },
                company: { byline_id: companyId, name: 'Acme', domain },
                contact: { byline_id: personId, email: `ana@${domain}`, name: 'Ana Test' },
                owner: { email: a.email },
            });
            expect(await latest()).toMatchObject({
                status: 'delivered',
                attempts: 1,
                customerId: 'cus_1',
                parentCustomerId: null,
                reasonCode: 'CREATED',
                amReasonCode: 'REASSIGNED',
                httpStatus: 200,
            });
            expect((await owner.person.findUniqueOrThrow({ where: { id: personId } })).newswireosCustomerId).toBe(
                'cus_1',
            );
            expect((await owner.company.findUniqueOrThrow({ where: { id: companyId } })).newswireosCustomerId).toBe(
                'cus_1',
            );
            // The records API shows both, read-only; another workspace reads neither.
            expect(
                (
                    await as(a.who)
                        .get(w(`/people/${personId}`))
                        .expect(200)
                ).body,
            ).toMatchObject({
                newswireosCustomerId: 'cus_1',
            });
            expect(
                (
                    await as(a.who)
                        .get(w(`/companies/${companyId}`))
                        .expect(200)
                ).body,
            ).toMatchObject({
                newswireosCustomerId: 'cus_1',
            });
            const write = await http()
                .patch(w(`/people/${personId}`))
                .set('Cookie', a.who.cookie)
                .set(CSRF_HEADER, a.who.csrf)
                .send({ newswireosCustomerId: 'cus_forged' });
            expect(write.status).toBeLessThan(500);
            expect((await owner.person.findUniqueOrThrow({ where: { id: personId } })).newswireosCustomerId).toBe(
                'cus_1',
            );
            expect((await as(b.who).get(w(`/people/${personId}`, b.id))).status).toBe(404);
            expect((await as(b.who).get(w(`/companies/${companyId}`, b.id))).status).toBe(404);
            // Done is done.
            expect(await run(d.id)).toBe('done');
            expect(newswireos.calls).toHaveLength(1);
        });

        it('a colleague’s company is linked to the parent client; a company keeps the first client it had', async () => {
            const zeta = await newCompany('Zeta', `zeta-${stamp}.test`);
            const zed = await newPerson('Zed', zeta, `zed@zeta-${stamp}.test`);
            await winDeal(`Colleague ${stamp}`, zed, zeta);
            newswireos.next({
                customerId: 'cus_7',
                parentCustomerId: 'cus_parent',
                reasonCode: 'COLLEAGUE',
                amReasonCode: 'UNCHANGED',
            });
            expect(await run((await latest()).id)).toBe('done');
            expect((await owner.person.findUniqueOrThrow({ where: { id: zed } })).newswireosCustomerId).toBe('cus_7');
            expect((await owner.company.findUniqueOrThrow({ where: { id: zeta } })).newswireosCustomerId).toBe(
                'cus_parent',
            );

            const bo = await newPerson('Bo', companyId, `bo@${domain}`);
            await winDeal(`Second ${stamp}`, bo);
            newswireos.next({ customerId: 'cus_8', parentCustomerId: null, reasonCode: 'LINKED', amReasonCode: null });
            expect(await run((await latest()).id)).toBe('done');
            expect((await owner.person.findUniqueOrThrow({ where: { id: bo } })).newswireosCustomerId).toBe('cus_8');
            expect((await owner.company.findUniqueOrThrow({ where: { id: companyId } })).newswireosCustomerId).toBe(
                'cus_1',
            );
        });

        it('NOT_A_CLIENT is delivered and final; nothing is written on the person', async () => {
            const staff = await newPerson('Staff', companyId, `staff@${domain}`);
            await winDeal(`Staff ${stamp}`, staff);
            newswireos.next({
                customerId: null,
                parentCustomerId: null,
                reasonCode: 'NOT_A_CLIENT',
                amReasonCode: null,
            });
            expect(await run((await latest()).id)).toBe('done');
            expect(await latest()).toMatchObject({ status: 'delivered', reasonCode: 'NOT_A_CLIENT', customerId: null });
            expect((await owner.person.findUniqueOrThrow({ where: { id: staff } })).newswireosCustomerId).toBeNull();
        });

        it('a 5xx is retried, then fails on the last attempt; a 401 is final; a 404 is not ready', async () => {
            await winDeal(`Retry ${stamp}`);
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
                reasonCode: 'NEWSWIREOS_UNAVAILABLE',
            });
            expect(newswireos.calls.map((c) => c.body.event_id)).toEqual([d.eventId, d.eventId]);

            for (const [error, status, reasonCode] of [
                [new NewswireosApiError(401, 'bad token'), 'failed', 'TOKEN_REFUSED'],
                [new NewswireosApiError(403, 'forbidden'), 'failed', 'TOKEN_LACKS_SCOPE'],
                [new NewswireosApiError(400, 'contact.email must be an email address.'), 'failed', 'BAD_REQUEST'],
                [new NewswireosApiError(404, 'Not Found'), 'not_ready', 'NEWSWIREOS_NOT_READY'],
            ] as const) {
                await winDeal(`Final ${reasonCode} ${stamp}`);
                newswireos.next(error);
                const e = await latest();
                expect(await run(e.id)).toBe('done');
                expect(await latest()).toMatchObject({ id: e.id, status, reasonCode, attempts: 1 });
            }
        });

        it('a deal whose contact has no email is not pushed', async () => {
            const nameless = await newPerson('Nomail', companyId);
            const before = (await deliveries()).length;
            await winDeal(`No email ${stamp}`, nameless);
            expect(await deliveries()).toHaveLength(before);
        });

        it('turned off, a delivery already queued is skipped, not sent', async () => {
            await winDeal(`Skipped ${stamp}`);
            const d = await latest();
            expect(d.status).toBe('pending');
            await toggle(false).expect(200);
            expect(await run(d.id)).toBe('done');
            expect(await latest()).toMatchObject({ id: d.id, status: 'skipped', reasonCode: 'PUSH_OFF' });
            expect(newswireos.calls).toHaveLength(0);
        });
    });

    describe('"Send test" for won deals', () => {
        const test = (ws = a) => as(ws.who).post(w('/integrations/newswireos/deal-won-push/test', ws.id));

        it('sends and writes nothing; shows the body a push would send for the latest won deal that qualifies', async () => {
            const count = () => owner.newswireosDealWonDelivery.count({ where: { workspaceId: a.id } });
            const deal = await winDeal(`Preview ${stamp}`);
            const before = await count();
            // A later win whose contact has no email does not qualify: the one before it is shown.
            await winDeal(`Preview no email ${stamp}`, await newPerson('Nomail', companyId));
            const preview = (await test().expect(200)).body as DealWonPushPreview;
            expect(preview).toMatchObject({ sent: false, found: true, opportunityId: deal });
            expect(preview.payload).toEqual({
                event_id: expect.any(String) as string,
                occurred_at: expect.any(String) as string,
                deal: { byline_id: deal, name: `Preview ${stamp}`, amount_minor: 250_000, currency: 'USD' },
                company: { byline_id: companyId, name: 'Acme', domain },
                contact: { byline_id: personId, email: `ana@${domain}`, name: 'Ana Test' },
                owner: { email: a.email },
            });
            expect(newswireos.calls).toHaveLength(0);
            expect(await count()).toBe(before);
        });

        it('answers found: false with no qualifying deal; an admin’s only', async () => {
            expect((await test(b).expect(200)).body).toEqual({
                sent: false,
                found: false,
                opportunityId: null,
                payload: null,
            });
            const member = `deal-won-member-${stamp}@example.test`;
            const roles = (await as(a.who).get(w('/roles')).expect(200)).body as { id: string; name: string }[];
            const invite = await as(a.who)
                .post(w('/invites'))
                .send({ email: member, roleId: roles.find((r) => r.name === SYSTEM_ROLES.member)!.id })
                .expect(201);
            const joined = await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password: 'correct horse battery staple' })
                .expect(201);
            await verifyAddress(app, http, member);
            expect((await as(browserFrom(joined)).post(w('/integrations/newswireos/deal-won-push/test'))).status).toBe(
                403,
            );
            expect(newswireos.calls).toHaveLength(0);
        });

        it('cross-tenant: another workspace’s test never reads this workspace’s won deals', async () => {
            expect(((await test().expect(200)).body as DealWonPushPreview).found).toBe(true);
            const theirs = (await test(b).expect(200)).body as DealWonPushPreview;
            expect(theirs).toMatchObject({ found: false, payload: null });
            expect(
                (await as(b.who).post(w('/integrations/newswireos/deal-won-push/test'))).status,
            ).toBeGreaterThanOrEqual(403);
        });
    });

    describe('NewswireOS timeline → the CRM', () => {
        it('an event naming the person is put on their timeline once; a redelivery is a duplicate', async () => {
            const id = `evt_${randomUUID()}`;
            const data = {
                kind: 'order.paid',
                title: 'Order paid',
                url: 'https://app.newswireos.example/acme/clients/cus_1/',
                amount_cents: 49_900,
                currency: 'usd',
                client: client({ byline_contact_id: personId, email: `ana@${domain}` }),
            };
            expect((await hook('order.paid', data, { id }).expect(200)).body).toEqual({ result: 'applied' });
            expect((await hook('order.paid', data, { id }).expect(200)).body).toEqual({ result: 'duplicate' });
            const entries = (await timeline(`person:${personId}`)).filter(
                (e) => e.kind === 'external.newswireos_order_paid',
            );
            expect(entries).toHaveLength(1);
            expect(entries[0]!.properties).toMatchObject({
                title: 'Order paid',
                url: data.url,
                amount: { amountMinor: 49_900, currency: 'USD' },
                customerId: 'cus_1',
            });
            const row = await owner.newswireosTimelineEvent.findUniqueOrThrow({
                where: { workspaceId_eventId: { workspaceId: a.id, eventId: id } },
            });
            expect(row).toMatchObject({ targetType: 'person', targetId: personId, matchedBy: 'byline_contact_id' });
        });

        it('matches on the company id, then the email, then the domain', async () => {
            const cases = [
                [client({ byline_company_id: companyId }), 'company', companyId, 'byline_company_id'],
                [client({ email: `ana@${domain}` }), 'person', personId, 'email'],
                [client({ email: `new@${domain}`, company_domain: domain }), 'company', companyId, 'domain'],
            ] as const;
            for (const [c, type, target, by] of cases) {
                const id = `evt_${randomUUID()}`;
                const title = `Release distributed: ${by}`;
                await hook(
                    'distribution.completed',
                    { kind: 'distribution.completed', title, url: 'https://x.test/', client: c },
                    { id },
                ).expect(200);
                expect(
                    await owner.newswireosTimelineEvent.findUniqueOrThrow({
                        where: { workspaceId_eventId: { workspaceId: a.id, eventId: id } },
                    }),
                ).toMatchObject({ targetType: type, targetId: target, matchedBy: by });
            }
            // A company's timeline shows its own entries and its people's.
            const titles = (await timeline(`company:${companyId}`)).map((e) => e.properties['title']);
            expect(titles).toEqual(
                expect.arrayContaining([
                    'Release distributed: byline_company_id',
                    'Release distributed: email',
                    'Release distributed: domain',
                ]),
            );
        });

        it('an event for no one here, or an agency’s (no client), is stored and answered 2xx', async () => {
            const lost = `evt_${randomUUID()}`;
            expect(
                (
                    await hook(
                        'invoice.paid',
                        {
                            kind: 'invoice.paid',
                            title: 'Invoice INV-1 paid',
                            url: 'https://x.test/',
                            client: client({ email: `nobody@else-${stamp}.test` }),
                        },
                        { id: lost },
                    ).expect(200)
                ).body,
            ).toEqual({ result: 'unmatched' });
            const agency = `evt_${randomUUID()}`;
            expect(
                (
                    await hook(
                        'invoice.paid',
                        { kind: 'invoice.paid', title: 'Invoice INV-2 paid', url: 'https://x.test/', client: null },
                        { id: agency },
                    ).expect(200)
                ).body,
            ).toEqual({ result: 'unmatched' });
            const rows = await owner.newswireosTimelineEvent.findMany({
                where: { workspaceId: a.id, eventId: { in: [lost, agency] } },
            });
            expect(rows).toHaveLength(2);
            expect(rows.every((r) => r.targetId === null && r.matchedBy === null)).toBe(true);
        });

        it('payment events are read as before; an unknown event is acknowledged and dropped; a bad signature is refused', async () => {
            expect(
                (
                    await hook('payment.refunded', {
                        gateway: 'stripe',
                        reference: `pi_none_${stamp}`,
                        references: [],
                    }).expect(200)
                ).body,
            ).toEqual({ result: 'unmatched' });
            expect((await hook('release.published', { title: 'x' }).expect(200)).body).toEqual({ result: 'ignored' });
            await hook(
                'order.paid',
                { kind: 'order.paid', title: 'Order paid', client: null },
                { key: 'not-the-secret' },
            ).expect(401);
        });

        it('client.created and am.assigned keep the client’s account-managed exclusion as the client sync does', async () => {
            const live = (address: string) =>
                owner.outreachExclusion.findMany({ where: { workspaceId: a.id, address, removedAt: null } });
            const fresh = `fresh@client-${stamp}.test`;
            await hook('client.created', {
                kind: 'client.created',
                title: 'Client account created',
                url: 'https://x.test/',
                client: client({ email: fresh }),
            }).expect(200);
            expect(await live(fresh)).toEqual([
                expect.objectContaining({ reason: 'account_managed', source: 'newswireos', accountManagerName: null }),
            ]);
            await hook('am.assigned', {
                kind: 'am.assigned',
                title: 'Account manager: Mia Lopez',
                url: 'https://x.test/',
                account_manager: { id: 'am_1', name: 'Mia Lopez', email: 'mia@newswireos.test' },
                client: client({ email: fresh }),
            }).expect(200);
            await hook('client.created', {
                kind: 'client.created',
                title: 'Client account created',
                url: 'https://x.test/',
                client: client({ email: fresh }),
            }).expect(200);
            expect(await live(fresh)).toEqual([
                expect.objectContaining({ source: 'newswireos', accountManagerName: 'Mia Lopez' }),
            ]);

            // A Twenty lead lookup's becomes this source's; one made by hand is left as it is.
            const looked = `looked@client-${stamp}.test`;
            const manual = `manual@client-${stamp}.test`;
            await owner.outreachExclusion.createMany({
                data: [
                    {
                        workspaceId: a.id,
                        address: looked,
                        reason: 'account_managed',
                        source: TWENTY_IMPORT_SOURCE,
                        externalRef: 'lookup-1',
                        accountManagerName: 'Twenty owner',
                    },
                    { workspaceId: a.id, address: manual, reason: 'account_managed', source: 'manual' },
                ],
            });
            await hook('am.assigned', {
                kind: 'am.assigned',
                title: 'Account manager: Ola',
                url: 'https://x.test/',
                account_manager: { id: 'am_2', name: 'Ola', email: 'ola@newswireos.test' },
                client: client({ email: looked }),
            }).expect(200);
            await hook('client.created', {
                kind: 'client.created',
                title: 'Client account created',
                url: 'https://x.test/',
                client: client({ email: manual }),
            }).expect(200);
            expect(await live(looked)).toEqual([
                expect.objectContaining({ source: 'newswireos', accountManagerName: 'Ola', externalRef: null }),
            ]);
            expect(await live(manual)).toEqual([
                expect.objectContaining({ source: 'manual', accountManagerName: null }),
            ]);
        });
    });

    describe('cross-tenant', () => {
        it('another workspace’s hook never matches this workspace’s records', async () => {
            const id = `evt_${randomUUID()}`;
            expect(
                (
                    await hook(
                        'order.paid',
                        {
                            kind: 'order.paid',
                            title: 'Order paid elsewhere',
                            url: 'https://x.test/',
                            client: client({ byline_contact_id: personId, email: `ana@${domain}` }),
                        },
                        { id, url: otherHookUrl, key: otherSecret },
                    ).expect(200)
                ).body,
            ).toEqual({ result: 'unmatched' });
            expect(
                (await timeline(`person:${personId}`)).some((e) => e.properties['title'] === 'Order paid elsewhere'),
            ).toBe(false);
            // The same delivery id is each workspace's own: here it is new.
            expect(
                (
                    await hook(
                        'order.paid',
                        {
                            kind: 'order.paid',
                            title: 'Order paid here',
                            url: 'https://x.test/',
                            client: client({ byline_contact_id: personId }),
                        },
                        { id },
                    ).expect(200)
                ).body,
            ).toEqual({ result: 'applied' });
        });

        it('another workspace neither lists nor reads this workspace’s deliveries or events', async () => {
            const ours = await deliveries();
            expect(ours.length).toBeGreaterThan(0);
            expect(await deliveries(b)).toEqual([]);
            expect(
                (await as(b.who).get(w('/integrations/newswireos/deal-won-push/deliveries'))).status,
            ).toBeGreaterThanOrEqual(403);
            const seen = await rls.withWorkspace(b.id, async (tx) => ({
                deliveries: await tx.newswireosDealWonDelivery.findMany({ where: { workspaceId: a.id } }),
                events: await tx.newswireosTimelineEvent.findMany({ where: { workspaceId: a.id } }),
            }));
            expect(seen).toEqual({ deliveries: [], events: [] });
            // A pending row of ours, run under the other workspace: invisible there, so nothing is sent.
            await owner.newswireosDealWonDelivery.update({ where: { id: ours[0]!.id }, data: { status: 'pending' } });
            expect(await run(ours[0]!.id, false, b.id)).toBe('done');
            expect(newswireos.calls).toHaveLength(0);
        });

        it('the app role cannot write a delivery or an event into another workspace', async () => {
            const ours = (await deliveries())[0]!;
            await expect(
                rls.withWorkspace(b.id, (tx) =>
                    tx.newswireosDealWonDelivery.create({
                        data: {
                            workspaceId: a.id,
                            eventId: randomUUID(),
                            opportunityId: ours.opportunityId,
                            personId,
                            companyId,
                            payload: {},
                        },
                    }),
                ),
            ).rejects.toThrow();
            await expect(
                rls.withWorkspace(b.id, (tx) =>
                    tx.newswireosTimelineEvent.create({
                        data: {
                            workspaceId: a.id,
                            eventId: `evt_${randomUUID()}`,
                            eventType: 'order.paid',
                            payload: {},
                        },
                    }),
                ),
            ).rejects.toThrow();
            const updated = await rls.withWorkspace(b.id, (tx) =>
                tx.newswireosDealWonDelivery.updateMany({ where: { id: ours.id }, data: { status: 'failed' } }),
            );
            expect(updated.count).toBe(0);
        });
    });
});
