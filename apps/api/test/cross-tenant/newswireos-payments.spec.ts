import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    SYSTEM_ROLES,
    type DealInvoiceView,
    type DomainEvent,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { INVOICE_VERIFY_QUEUE } from '../../src/invoices/invoices.constants';
import { InvoicesService } from '../../src/invoices/invoices.service';
import { InvoicesWorkers } from '../../src/invoices/invoices.workers';
import { NEWSWIREOS_VERIFICATION_PORT } from '../../src/invoices/newswireos-verification.port';
import type { NewswireosPaymentReviewView, NewswireosPaymentView } from '../../src/invoices/responses';
import { StageRulesService } from '../../src/pipelines/stage-rules.service';
import { FakeNewswireos } from '../support/fake-newswireos';
import { verifyAddress } from '../support/mail';
import { newswireosSignature } from '../support/newswireos-hook';

type Who = { cookie: string; csrf: string };
type Stage = { id: string; kind: 'open' | 'won' | 'lost' };

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
 * INV-2: a paid invoice NewswireOS reports (`invoice.paid` with its number) goes on the client's deal as an Account
 * Manager would enter it — the deal NewswireOS names, else the only open one; a new deal when there is none; the
 * owner asked when there are several; never one already entered. Shadow (the default) records and does nothing.
 * The same verification and `invoice.verified` stage rule then close the deal. Nothing crosses workspaces.
 */
describe('INV-2 paid invoices from NewswireOS go on their deal', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let invoices: InvoicesService;
    const newswireos = new FakeNewswireos();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const secret = `whsec_${stamp}`;
    let a: { who: Who; id: string; member: string };
    let b: { who: Who; id: string; member: string };
    let rep: Who;
    let repId: string;
    let stages: Stage[];
    let pipelineId: string;
    let hookUrl: string;
    let n = 0;

    const as = (who: Who) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, ws = a.id) => `/api/w/${ws}${path}`;
    const invoiceNumber = () => `INV-202610-${stamp}-${++n}`;
    const mode = (m: 'off' | 'shadow' | 'on', who = a) =>
        as(who.who).put(w('/integrations/newswireos/payment-mode', who.id)).send({ mode: m });
    /** A client at their own company, owned by A's admin. */
    const newClient = async (name: string) => {
        const slug = `${name.toLowerCase()}-${stamp}-${++n}`;
        const company = (
            (
                await as(a.who)
                    .post(w('/companies'))
                    .send({ name, domain: `${slug}.test` })
                    .expect(201)
            ).body as {
                id: string;
            }
        ).id;
        const email = `${name.toLowerCase()}@${slug}.test`;
        const person = (
            (
                await as(a.who)
                    .post(w('/people'))
                    .send({
                        nameFirst: name,
                        nameLast: 'Client',
                        companyId: company,
                        emails: { primary: email, additional: [] },
                    })
                    .expect(201)
            ).body as { id: string }
        ).id;
        return { company, person, email };
    };
    const newDeal = async (client: { company: string; person: string }, name: string, amountMinor = 50_000) =>
        (
            (
                await as(a.who)
                    .post(w('/opportunities'))
                    .send({
                        name: `${name} ${stamp}`,
                        companyId: client.company,
                        pointOfContactId: client.person,
                        amount: { amountMinor, currency: 'USD' },
                    })
                    .expect(201)
            ).body as { id: string }
        ).id;
    /** `invoice.paid` as NewswireOS sends it, `sha256=`-signed, with INV-2's fields. */
    const paid = (
        number: string,
        client: Record<string, unknown> | null,
        extra: Record<string, unknown> = {},
        opts: { id?: string } = {},
    ) => {
        const id = opts.id ?? `evt_${randomUUID()}`;
        const raw = JSON.stringify({
            id,
            event_type: 'invoice.paid',
            occurred_at: '2026-10-29T09:00:00Z',
            data: {
                kind: 'invoice.paid',
                title: `Invoice ${number} paid`,
                url: 'https://newswireos.example.test/invoices/1',
                amount_cents: 50_000,
                currency: 'usd',
                invoice_number: number,
                payment_method: 'stripe',
                byline_opportunity_id: null,
                client: client && {
                    customer_id: 'cus_1',
                    name: 'A Client',
                    company_domain: null,
                    byline_contact_id: null,
                    byline_company_id: null,
                    ...client,
                },
                ...extra,
            },
        });
        return http()
            .post(new URL(hookUrl).pathname)
            .set('content-type', 'application/json')
            .set('x-webhook-id', id)
            .set('x-webhook-event', 'invoice.paid')
            .set(newswireosSignature(raw, secret))
            .send(raw)
            .expect(200);
    };
    const payment = (number: string, ws = a.id) =>
        owner.newswireosPayment.findUniqueOrThrow({
            where: { workspaceId_invoiceNumber: { workspaceId: ws, invoiceNumber: number } },
        });
    const invoicesOn = async (deal: string) =>
        (
            await as(a.who)
                .get(w(`/opportunities/${deal}/invoices`))
                .expect(200)
        ).body as DealInvoiceView[];
    const notificationsOf = (member: string, kind: string) =>
        owner.notification.findMany({ where: { memberId: member, kind: kind as never } });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(NEWSWIREOS_VERIFICATION_PORT)
            .useValue(newswireos)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        invoices = app.get(InvoicesService);
        const signUp = async (email: string) => {
            const res = await http()
                .post('/api/auth/signup')
                .send({ email, password: 'correct horse battery staple', workspaceName: email });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            const id = (res.body as { workspace: { id: string } }).workspace.id;
            const member = (await owner.workspaceMember.findFirstOrThrow({ where: { workspaceId: id } })).id;
            return { who: browserFrom(res), id, member };
        };
        a = await signUp(`inv2-a-${stamp}@example.test`);
        b = await signUp(`inv2-b-${stamp}@example.test`);
        const pipelines = (await as(a.who).get(w('/pipelines')).expect(200)).body as { id: string; stages: Stage[] }[];
        pipelineId = pipelines[0]!.id;
        stages = pipelines[0]!.stages;
        hookUrl = (
            (
                await as(a.who)
                    .put(w('/integrations/newswireos'))
                    .send({ baseUrl: 'https://newswireos.example.test', apiToken: `nwos_${stamp}`, secret })
                    .expect(200)
            ).body as { hookUrl: string; paymentMode: string }
        ).hookUrl;
        const roles = (await as(a.who).get(w('/roles')).expect(200)).body as { id: string; name: string }[];
        const repEmail = `inv2-rep-${stamp}@example.test`;
        const invite = await as(a.who)
            .post(w('/invites'))
            .send({ email: repEmail, roleId: roles.find((r) => r.name === SYSTEM_ROLES.member)!.id })
            .expect(201);
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password: 'correct horse battery staple' })
            .expect(201);
        await verifyAddress(app, http, repEmail);
        rep = browserFrom(joined);
        repId = (
            await owner.workspaceMember.findFirstOrThrow({ where: { workspaceId: a.id, user: { email: repEmail } } })
        ).id;
    });

    afterAll(async () => {
        await app?.close();
    });

    it('starts in shadow: the deal it would go on is recorded, and nothing is put on it', async () => {
        const settings = (await as(a.who).get(w('/integrations/newswireos')).expect(200)).body as {
            paymentMode: string;
        };
        expect(settings.paymentMode).toBe('shadow');
        const client = await newClient('Shadow');
        const deal = await newDeal(client, 'Shadow deal');
        const number = invoiceNumber();
        await paid(number, { email: client.email });
        expect(await payment(number)).toMatchObject({
            mode: 'shadow',
            decision: 'attached',
            matchedBy: 'only_open_deal',
            opportunityId: deal,
        });
        expect(await invoicesOn(deal)).toEqual([]);
        // An Account Manager enters it by hand: the review shows the CRM chose the same deal.
        await as(a.who)
            .post(w(`/opportunities/${deal}/invoices`))
            .send({ gateway: 'newswireos_invoice', reference: number })
            .expect(201);
        const review = (await as(a.who).get(w('/integrations/newswireos/payments')).expect(200))
            .body as NewswireosPaymentReviewView[];
        expect(review.find((p) => p.invoiceNumber === number)).toMatchObject({
            enteredOnOpportunityId: deal,
            agrees: true,
        });
    });

    it('is an admin’s to switch; off puts a paid invoice on the timeline only', async () => {
        expect((await mode('on').expect(200)).body).toMatchObject({ paymentMode: 'on' });
        await mode('off').expect(200);
        const client = await newClient('Off');
        await newDeal(client, 'Off deal');
        const number = invoiceNumber();
        await paid(number, { email: client.email });
        expect(await owner.newswireosPayment.findFirst({ where: { invoiceNumber: number } })).toBeNull();
        await mode('nonsense' as never).expect(400);
        await mode('on').expect(200);
    });

    it('on: the deal NewswireOS names gets the invoice, and verification closes it Won by the stage rule', async () => {
        const won = stages.find((s) => s.kind === 'won')!;
        await as(a.who)
            .post(w(`/pipelines/${pipelineId}/rules`))
            .send({ event: 'invoice.verified', toStageId: won.id })
            .expect(201);
        const client = await newClient('Named');
        await newDeal(client, 'Other open deal');
        const deal = await newDeal(client, 'Named deal');
        const number = invoiceNumber();
        newswireos.answer(number, FakeNewswireos.decided('verified'));
        await paid(number, { email: client.email }, { byline_opportunity_id: deal });
        expect(await payment(number)).toMatchObject({
            decision: 'attached',
            matchedBy: 'deal_id',
            opportunityId: deal,
        });
        const [invoice] = await invoicesOn(deal);
        expect(invoice).toMatchObject({ gateway: 'newswireos_invoice', reference: number, status: 'verifying' });
        await invoices.runVerification(a.id, invoice!.id, { finalAttempt: true });
        const event = (
            await owner.outboxEvent.findMany({
                where: {
                    workspaceId: a.id,
                    type: 'invoice.verified',
                    payload: { path: ['recordId'], equals: invoice!.id },
                },
            })
        ).map((e) => e.payload as unknown as DomainEvent)[0];
        await app.get(StageRulesService).apply(event!);
        const after = (
            await as(a.who)
                .get(w(`/opportunities/${deal}`))
                .expect(200)
        ).body as {
            stageId: string;
            closedAt: string | null;
        };
        expect(after.stageId).toBe(won.id);
        expect(after.closedAt).not.toBeNull();
    });

    it('on: a client with no open deal gets one for the payment, and its owner is told', async () => {
        const client = await newClient('Fresh');
        const number = invoiceNumber();
        await paid(number, { email: client.email });
        const row = await payment(number);
        expect(row).toMatchObject({ decision: 'created_deal', targetType: 'person', targetId: client.person });
        const deal = await owner.opportunity.findUniqueOrThrow({ where: { id: row.opportunityId! } });
        expect(deal).toMatchObject({ companyId: client.company, pointOfContactId: client.person, ownerId: a.member });
        expect(deal.name).toBe('Fresh — NewswireOS payment');
        expect(await invoicesOn(deal.id)).toHaveLength(1);
        expect(await notificationsOf(a.member, 'payment_created_deal')).toEqual(
            expect.arrayContaining([expect.objectContaining({ newswireosPaymentId: row.id })]),
        );
    });

    it('on: several open deals are never guessed — the owner is asked, and chooses', async () => {
        const client = await newClient('Several');
        const first = await newDeal(client, 'First');
        const second = await newDeal(client, 'Second');
        const number = invoiceNumber();
        await paid(number, { email: client.email });
        const row = await payment(number);
        expect(row).toMatchObject({ decision: 'needs_deal', opportunityId: null });
        expect([...row.candidateIds].sort()).toEqual([first, second].sort());
        expect(await invoicesOn(first)).toEqual([]);
        expect(await notificationsOf(a.member, 'payment_needs_deal')).toHaveLength(1);

        const shown = (
            await as(a.who)
                .get(w(`/newswireos-payments/${row.id}`))
                .expect(200)
        ).body as NewswireosPaymentView;
        expect(shown.candidates.map((c) => c.id).sort()).toEqual([first, second].sort());
        const chosen = (
            await as(a.who)
                .post(w(`/newswireos-payments/${row.id}/choose`))
                .send({ opportunityId: second })
                .expect(200)
        ).body as NewswireosPaymentView;
        expect(chosen).toMatchObject({ opportunityId: second });
        expect(chosen.resolvedAt).not.toBeNull();
        expect(await invoicesOn(second)).toHaveLength(1);
        await as(a.who)
            .post(w(`/newswireos-payments/${row.id}/choose`))
            .send({ opportunityId: first })
            .expect(409);
    });

    it('on: an invoice an Account Manager already entered is left alone; a redelivery does nothing twice', async () => {
        const client = await newClient('Entered');
        const deal = await newDeal(client, 'Entered deal');
        const number = invoiceNumber();
        await as(a.who)
            .post(w(`/opportunities/${deal}/invoices`))
            .send({ gateway: 'newswireos_invoice', reference: number })
            .expect(201);
        const id = `evt_${randomUUID()}`;
        await paid(number, { email: client.email }, {}, { id });
        await paid(number, { email: client.email }, {}, { id });
        await paid(number, { email: client.email });
        expect(await payment(number)).toMatchObject({ decision: 'already_on_deal', opportunityId: deal });
        expect(await owner.newswireosPayment.count({ where: { invoiceNumber: number } })).toBe(1);
        expect(await invoicesOn(deal)).toHaveLength(1);
    });

    it('on: a payment from no one in the CRM is told to whoever verifies invoices', async () => {
        const number = invoiceNumber();
        await paid(number, { email: `stranger-${stamp}@nowhere.test` });
        const row = await payment(number);
        expect(row).toMatchObject({ decision: 'unmatched', opportunityId: null });
        expect(await notificationsOf(a.member, 'payment_unmatched')).toEqual(
            expect.arrayContaining([expect.objectContaining({ newswireosPaymentId: row.id })]),
        );
    });

    it('a deal links to raising its invoice in NewswireOS, for the client the CRM knows', async () => {
        const client = await newClient('Linked');
        const deal = await newDeal(client, 'Linked deal');
        const link = async () =>
            (
                await as(a.who)
                    .get(w(`/opportunities/${deal}/invoices/newswireos-link`))
                    .expect(200)
            ).body as {
                url: string | null;
                reason: string | null;
            };
        expect(await link()).toEqual({ url: null, reason: 'NO_DASHBOARD_URL' });
        await as(a.who)
            .put(w('/integrations/newswireos'))
            .send({ baseUrl: 'https://newswireos.example.test', dashboardUrl: 'https://dash.example.test/pinion/' })
            .expect(200);
        expect(await link()).toEqual({ url: null, reason: 'NOT_A_CLIENT' });
        await owner.person.update({ where: { id: client.person }, data: { newswireosCustomerId: 'cus_42' } });
        expect(await link()).toEqual({
            url: `https://dash.example.test/pinion/clients/cus_42/?generate_invoice=1&byline_opportunity_id=${deal}`,
            reason: null,
        });
    });

    it('on: a deal named for another client is never credited on NewswireOS’s word; its owner confirms', async () => {
        const payer = await newClient('Payer');
        const other = await newClient('Other');
        const elsewhere = await newDeal(other, 'Another client’s deal');
        const number = invoiceNumber();
        await paid(number, { email: payer.email }, { byline_opportunity_id: elsewhere });
        const row = await payment(number);
        expect(row).toMatchObject({ decision: 'needs_deal', opportunityId: null, candidateIds: [elsewhere] });
        expect(await invoicesOn(elsewhere)).toEqual([]);
    });

    it('a payment of nothing moves no deal', async () => {
        const client = await newClient('Zero');
        await newDeal(client, 'Zero deal');
        const number = invoiceNumber();
        await paid(number, { email: client.email }, { amount_cents: 0 });
        expect(await owner.newswireosPayment.findFirst({ where: { invoiceNumber: number } })).toBeNull();
    });

    it('a member sees and places only the payments that concern them, among the deals offered', async () => {
        const mine = async (path: string, body: object) =>
            ((await as(rep).post(w(path)).send(body).expect(201)).body as { id: string }).id;
        const slug = `rep-${stamp}`;
        const company = await mine('/companies', { name: 'Rep Co', domain: `${slug}.test` });
        const person = await mine('/people', {
            nameFirst: 'Rae',
            nameLast: 'Client',
            companyId: company,
            emails: { primary: `rae@${slug}.test`, additional: [] },
        });
        const deal = (name: string, c = company, p = person) =>
            mine('/opportunities', {
                name: `${name} ${stamp}`,
                companyId: c,
                pointOfContactId: p,
                amount: { amountMinor: 50_000, currency: 'USD' },
            });
        const first = await deal('Rae one');
        const second = await deal('Rae two');
        const otherCompany = await mine('/companies', { name: 'Rep Other', domain: `${slug}-other.test` });
        const otherPerson = await mine('/people', {
            nameFirst: 'Other',
            nameLast: 'Contact',
            companyId: otherCompany,
            emails: { primary: `other@${slug}-other.test`, additional: [] },
        });
        const unrelated = await deal('Unrelated', otherCompany, otherPerson);
        const number = invoiceNumber();
        await paid(number, { email: `rae@${slug}.test` });
        const row = await payment(number);
        expect(row.decision).toBe('needs_deal');
        expect(await notificationsOf(repId, 'payment_needs_deal')).toHaveLength(1);

        // Someone else's payment does not exist for them.
        const stranger = await owner.newswireosPayment.findFirstOrThrow({
            where: { workspaceId: a.id, decision: 'unmatched' },
        });
        await as(rep)
            .get(w(`/newswireos-payments/${stranger.id}`))
            .expect(404);
        await as(rep)
            .post(w(`/newswireos-payments/${stranger.id}/choose`))
            .send({ opportunityId: first })
            .expect(404);

        await as(rep)
            .get(w(`/newswireos-payments/${row.id}`))
            .expect(200);
        // Their own deal, but not one offered: refused, or a payment could be credited to any deal they own.
        await as(rep)
            .post(w(`/newswireos-payments/${row.id}/choose`))
            .send({ opportunityId: unrelated })
            .expect(403);
        await as(rep)
            .post(w(`/newswireos-payments/${row.id}/choose`))
            .send({ opportunityId: second })
            .expect(200);
        expect(await invoicesOn(second)).toHaveLength(1);
    });

    it('a delivery signed long ago (a replay), or with the body-only signature, is refused', async () => {
        const raw = JSON.stringify({
            id: `evt_${randomUUID()}`,
            event_type: 'invoice.paid',
            occurred_at: null,
            data: {},
        });
        const post = (headers: Record<string, string>) =>
            http().post(new URL(hookUrl).pathname).set('content-type', 'application/json').set(headers).send(raw);
        const stale = (await post(newswireosSignature(raw, secret, new Date(Date.now() - 10 * 60_000))).expect(401))
            .body as { message: string };
        expect(stale.message).toMatch(/too long ago/);
        await post(newswireosSignature(raw, secret, new Date(Date.now() + 10 * 60_000))).expect(401);
        const bodyOnly = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
        await post({ 'x-webhook-signature': bodyOnly }).expect(401);
        await post(newswireosSignature(raw, secret)).expect(200);
    });

    it('a lost verification is re-queued by the sweep', async () => {
        const client = await newClient('Lost');
        const deal = await newDeal(client, 'Lost deal');
        const number = invoiceNumber();
        await paid(number, { email: client.email });
        const [invoice] = await invoicesOn(deal);
        expect(invoice!.status).toBe('verifying');
        // As if its job never made it to Redis, and long enough ago to count as lost.
        await app.get(getQueueToken(INVOICE_VERIFY_QUEUE)).remove(invoice!.id);
        await owner.dealInvoice.update({
            where: { id: invoice!.id },
            data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
        });
        expect(await app.get(InvoicesWorkers).sweep()).toBeGreaterThanOrEqual(1);
        expect(await app.get(getQueueToken(INVOICE_VERIFY_QUEUE)).getJob(invoice!.id)).toBeTruthy();
    });

    it('cross-tenant: another workspace sees none of this workspace’s payments', async () => {
        const row = await owner.newswireosPayment.findFirstOrThrow({ where: { workspaceId: a.id } });
        await as(b.who)
            .get(w(`/newswireos-payments/${row.id}`, b.id))
            .expect(404);
        await as(b.who)
            .post(w(`/newswireos-payments/${row.id}/choose`, b.id))
            .send({ opportunityId: randomUUID() })
            .expect(404);
        await mode('on', b).expect(404);
    });
});
