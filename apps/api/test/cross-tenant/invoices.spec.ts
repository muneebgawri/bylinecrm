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
    type DealInvoiceView,
    type DomainEvent,
    type NotificationsView,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { NEWSWIREOS_SIGNATURE_HEADER } from '../../src/invoices/invoices.constants';
import { InvoicesService } from '../../src/invoices/invoices.service';
import { NEWSWIREOS_VERIFICATION_PORT, NewswireosApiError } from '../../src/invoices/newswireos-verification.port';
import { StageRulesService } from '../../src/pipelines/stage-rules.service';
import { FakeNewswireos } from '../support/fake-newswireos';
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

interface Stage {
    id: string;
    name: string;
    kind: 'open' | 'won' | 'lost';
    position: number;
}

/**
 * Invoices on a deal (INV-1, #206, FR-CRMS-19): a reference is verified by NewswireOS (a fake here) before it
 * counts; what NewswireOS cannot decide — or everything, without a link — waits for a person with `invoice:verify`,
 * who is told. One payment is one deal. A refund reported on the signed hook takes a verified invoice back. A
 * verified invoice covering the deal moves it by a stage rule. Nothing crosses workspaces.
 */
describe('INV-1 invoices on a deal (FR-CRMS-19)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let rls: RlsPrismaService;
    let invoices: InvoicesService;
    const newswireos = new FakeNewswireos();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const emails = {
        admin: `inv-admin-${stamp}@example.com`,
        ana: `inv-ana-${stamp}@example.com`,
        mia: `inv-mia-${stamp}@example.com`,
        other: `inv-other-${stamp}@example.com`,
    };
    let admin: Browser;
    let ana: Browser;
    let mia: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let miaId: string;
    let anaId: string;
    let deal: string;
    let pipelineId: string;
    let target: Stage;
    let hookUrl: string;
    // Minted by NewswireOS and pasted into Byline: any length.
    const secret = `whsec_${stamp}`;

    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const ref = (s: string) => `${s}-${stamp}`;
    const add = (who: Browser, dealId: string, body: Record<string, unknown>, id = workspace) =>
        as(who)
            .post(w(`/opportunities/${dealId}/invoices`, id))
            .send(body);
    const run = (invoiceId: string, finalAttempt = true, id = workspace) =>
        invoices.runVerification(id, invoiceId, { finalAttempt });
    const listOf = async (dealId: string, who: Browser = ana) =>
        (
            await as(who)
                .get(w(`/opportunities/${dealId}/invoices`))
                .expect(200)
        ).body as DealInvoiceView[];
    const one = async (dealId: string, invoiceId: string) => (await listOf(dealId)).find((i) => i.id === invoiceId)!;
    const newDeal = async (who: Browser, name: string, amountMinor: number | null, id = workspace) => {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const company = await as(who)
            .post(w('/companies', id))
            .send({ name, domain: `${slug}.test` });
        if (company.status !== 201) throw new Error(`company: ${company.status} ${JSON.stringify(company.body)}`);
        const companyId = (company.body as { id: string }).id;
        const res = await as(who)
            .post(w('/opportunities', id))
            .send({ name, companyId, ...(amountMinor ? { amount: { amountMinor, currency: 'USD' } } : {}) });
        if (res.status !== 201) throw new Error(`deal: ${res.status} ${JSON.stringify(res.body)}`);
        return (res.body as { id: string }).id;
    };
    const outboxEvents = async (invoiceId: string) =>
        (
            await owner.outboxEvent.findMany({
                where: { workspaceId: workspace, payload: { path: ['recordId'], equals: invoiceId } },
                orderBy: { createdAt: 'asc' },
            })
        ).map((e) => e.payload as unknown as DomainEvent);
    /** A delivery in NewswireOS's outbound format: `{id, event_type, occurred_at, data}`, `sha256=`-signed. */
    const deliver = (
        url: string,
        body: {
            id?: string;
            type: string;
            data: Record<string, unknown> & { reference?: string; references?: string[] };
        },
        key = secret,
    ) => {
        const id = body.id ?? `evt_${randomUUID()}`;
        const raw = JSON.stringify({
            id,
            event_type: body.type,
            occurred_at: '2026-10-21T09:00:00Z',
            data: { ...body.data, references: body.data.references ?? [body.data.reference] },
        });
        return http()
            .post(new URL(url).pathname)
            .set('content-type', 'application/json')
            .set('x-webhook-id', id)
            .set('x-webhook-event', body.type)
            .set(NEWSWIREOS_SIGNATURE_HEADER, `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`)
            .send(raw);
    };

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(NEWSWIREOS_VERIFICATION_PORT)
            .useValue(newswireos)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        rls = app.get(RlsPrismaService);
        invoices = app.get(InvoicesService);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, id: workspace } = await signUp(emails.admin, `Inv ${stamp}`));
        ({ browser: otherAdmin, id: otherWorkspace } = await signUp(emails.other, `Inv other ${stamp}`));

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
        miaId = members.find((m) => m.email === emails.mia)!.id;
        anaId = members.find((m) => m.email === emails.ana)!.id;

        deal = await newDeal(ana, `Ana deal ${stamp}`, 150_000);
        const pipelines = (await as(admin).get(w('/pipelines')).expect(200)).body as {
            id: string;
            stages: Stage[];
        }[];
        pipelineId = pipelines[0]!.id;
        // A rule may close a deal: fully paid → Won.
        target = pipelines[0]!.stages.find((s) => s.kind === 'won')!;
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('with no NewswireOS link', () => {
        let invoiceId: string;

        it('a reference is entered as verifying, at the deal’s amount', async () => {
            const res = await add(ana, deal, { gateway: 'stripe', reference: `  ${ref('pi_manual')} ` }).expect(201);
            const invoice = res.body as DealInvoiceView;
            expect(invoice).toMatchObject({
                status: 'verifying',
                reference: ref('pi_manual'),
                amountMinor: '150000',
                currency: 'USD',
                createdById: anaId,
            });
            invoiceId = invoice.id;
        });

        it('waits for finance, and whoever may verify invoices is told', async () => {
            await run(invoiceId);
            expect(await one(deal, invoiceId)).toMatchObject({ status: 'needs_review', reasonCode: 'NO_LINK' });
            expect(newswireos.calls).toHaveLength(0);
            const told = (await as(mia).get(w('/notifications')).expect(200)).body as NotificationsView;
            expect(told.items.find((n) => n.kind === 'invoice_needs_review')?.invoice).toMatchObject({
                id: invoiceId,
                opportunityId: deal,
                reference: ref('pi_manual'),
                reasonCode: 'NO_LINK',
            });
            const notTold = (await as(ana).get(w('/notifications')).expect(200)).body as NotificationsView;
            expect(notTold.items.some((n) => n.kind === 'invoice_needs_review')).toBe(false);
        });

        it('only `invoice:verify` verifies by hand; the event names the deal once it is covered', async () => {
            await as(ana)
                .post(w(`/opportunities/${deal}/invoices/${invoiceId}/verify`))
                .send({})
                .expect(403);
            const verified = (
                await as(mia)
                    .post(w(`/opportunities/${deal}/invoices/${invoiceId}/verify`))
                    .send({ note: 'Seen in Stripe' })
                    .expect(200)
            ).body as DealInvoiceView;
            expect(verified).toMatchObject({
                status: 'verified',
                reasonCode: 'MANUAL',
                note: 'Seen in Stripe',
                decidedById: miaId,
            });
            await as(mia)
                .post(w(`/opportunities/${deal}/invoices/${invoiceId}/verify`))
                .send({})
                .expect(409);
            const [event] = await outboxEvents(invoiceId);
            expect(event).toMatchObject({
                type: 'invoice.verified',
                object: 'invoice',
                targets: [{ type: 'opportunity', id: deal }],
                related: [{ type: 'opportunity', id: deal }],
                invoice: { covers: true, amountMinor: '150000' },
            });
        });

        it('one payment is one deal', async () => {
            const other = await newDeal(ana, `Ana second ${stamp}`, 1000);
            const res = await add(ana, other, { gateway: 'stripe', reference: ref('pi_manual') }).expect(409);
            expect((res.body as { details?: Record<string, string> }).details).toMatchObject({
                reason: 'INVOICE_TAKEN',
            });
            // The same reference on another rail is another payment.
            await add(ana, other, { gateway: 'paypal', reference: ref('pi_manual') }).expect(201);
        });

        it('a bank transfer never asks NewswireOS; a refusal by hand needs a reason', async () => {
            const id = (
                (await add(ana, deal, { gateway: 'bank_wire', reference: ref('wire') }).expect(201))
                    .body as DealInvoiceView
            ).id;
            await run(id);
            expect(await one(deal, id)).toMatchObject({
                status: 'needs_review',
                reasonCode: 'AWAITING_BANK_CONFIRMATION',
            });
            await as(mia)
                .post(w(`/opportunities/${deal}/invoices/${id}/reject`))
                .send({})
                .expect(400);
            const rejected = (
                await as(mia)
                    .post(w(`/opportunities/${deal}/invoices/${id}/reject`))
                    .send({ reason: 'No such transfer' })
                    .expect(200)
            ).body as DealInvoiceView;
            expect(rejected).toMatchObject({ status: 'invalid', reasonCode: 'MANUAL', note: 'No such transfer' });
        });

        it('a deal with no amount needs the amount expected', async () => {
            const bare = await newDeal(ana, `No amount ${stamp}`, null);
            await add(ana, bare, { gateway: 'stripe', reference: ref('pi_bare') }).expect(422);
            await add(ana, bare, { gateway: 'stripe', reference: ref('pi_bare'), expectedAmountMinor: '500' }).expect(
                201,
            );
        });
    });

    describe('linked to NewswireOS', () => {
        it('is an admin’s to link; the token and secret are never shown back', async () => {
            await as(mia)
                .put(w('/integrations/newswireos'))
                .send({ baseUrl: 'https://newswireos.example', apiToken: 'nwos_token', secret })
                .expect(403);
            await as(admin)
                .put(w('/integrations/newswireos'))
                .send({ baseUrl: 'https://newswireos.example' })
                .expect(400);
            // Linked first without the secret: NewswireOS mints it only once it has the hook URL linking makes.
            const linked = await as(admin)
                .put(w('/integrations/newswireos'))
                .send({ baseUrl: 'https://newswireos.example/ignored', apiToken: `nwos_${stamp}` })
                .expect(200);
            expect(linked.body).toMatchObject({ configured: true, secretSet: false });
            const early = (linked.body as { hookUrl: string }).hookUrl;
            expect(early).toBeTruthy();
            await deliver(early, {
                id: 'evt_0',
                type: 'payment.refunded',
                data: { gateway: 'stripe', reference: 'x' },
            }).expect(401);
            expect((await as(admin).get(w('/integrations/newswireos')).expect(200)).body).toMatchObject({
                lastDeliveryResult: 'no_secret',
            });
            const res = await as(admin)
                .put(w('/integrations/newswireos'))
                .send({ baseUrl: 'https://newswireos.example/ignored', secret })
                .expect(200);
            expect(res.body).toMatchObject({
                configured: true,
                secretSet: true,
                baseUrl: 'https://newswireos.example',
            });
            expect((res.body as { hookUrl: string }).hookUrl).toBe(early);
            expect(JSON.stringify(res.body)).not.toContain(secret);
            expect(JSON.stringify(res.body)).not.toContain(`nwos_${stamp}`);
            hookUrl = (res.body as { hookUrl: string }).hookUrl;
        });

        it('verified attaches, with the amount expected sent and the token presented', async () => {
            const deal2 = await newDeal(ana, `Partial ${stamp}`, 100_000);
            newswireos.answer(ref('pi_ok'), FakeNewswireos.decided('verified', null, ref('pi_canon')));
            const id = (
                (
                    await add(ana, deal2, {
                        gateway: 'stripe',
                        reference: ref('pi_ok'),
                        expectedAmountMinor: '40000',
                    }).expect(201)
                ).body as DealInvoiceView
            ).id;
            await run(id);
            expect(newswireos.calls.at(-1)).toEqual({
                link: { baseUrl: 'https://newswireos.example', apiToken: `nwos_${stamp}` },
                request: { gateway: 'stripe', reference: ref('pi_ok'), amountCents: 40000, currency: 'usd' },
            });
            expect(await one(deal2, id)).toMatchObject({ status: 'verified', canonicalReference: ref('pi_canon') });
            // A partial payment does not cover the deal: the stage rule is not told.
            const [event] = await outboxEvents(id);
            expect(event).toMatchObject({ type: 'invoice.verified', invoice: { covers: false } });
            expect(event!.related).toBeUndefined();
        });

        it('invalid is refused with NewswireOS’s reason, and may be entered again', async () => {
            newswireos.answer(ref('pi_bad'), FakeNewswireos.decided('invalid', 'AMOUNT_MISMATCH'));
            const id = (
                (await add(ana, deal, { gateway: 'stripe', reference: ref('pi_bad') }).expect(201))
                    .body as DealInvoiceView
            ).id;
            await run(id);
            expect(await one(deal, id)).toMatchObject({ status: 'invalid', reasonCode: 'AMOUNT_MISMATCH' });
            newswireos.answer(ref('pi_bad'), FakeNewswireos.decided('verified'));
            const again = (
                await add(ana, deal, {
                    gateway: 'stripe',
                    reference: ref('pi_bad'),
                    expectedAmountMinor: '149000',
                }).expect(201)
            ).body as DealInvoiceView;
            expect(again).toMatchObject({ id, status: 'verifying', amountMinor: '149000', reasonCode: null });
        });

        it('NewswireOS down is retried, then waits for finance; a re-check asks again', async () => {
            newswireos.answer(ref('pi_down'), new NewswireosApiError(null, 'NewswireOS did not answer (timeout)'));
            const id = (
                (await add(ana, deal, { gateway: 'paypal', reference: ref('pi_down') }).expect(201))
                    .body as DealInvoiceView
            ).id;
            await expect(run(id, false)).rejects.toThrow();
            expect(await one(deal, id)).toMatchObject({ status: 'verifying' });
            await run(id, true);
            expect(await one(deal, id)).toMatchObject({ status: 'needs_review', reasonCode: 'PROVIDER_ERROR' });

            newswireos.answer(ref('pi_down'), FakeNewswireos.decided('verified'));
            await as(ana)
                .post(w(`/opportunities/${deal}/invoices/${id}/recheck`))
                .expect(200);
            await run(id);
            expect(await one(deal, id)).toMatchObject({ status: 'verified' });
        });

        it('a refused token waits for finance; pending (under-confirmed) is never verified', async () => {
            newswireos.answer(ref('tx_pending'), FakeNewswireos.decided('pending', 'UNDER_CONFIRMED'));
            const id = (
                (await add(ana, deal, { gateway: 'crypto_onchain', reference: ref('tx_pending') }).expect(201))
                    .body as DealInvoiceView
            ).id;
            await run(id);
            expect(await one(deal, id)).toMatchObject({ status: 'needs_review', reasonCode: 'UNDER_CONFIRMED' });
            newswireos.answer(ref('pi_401'), new NewswireosApiError(401, 'refused'));
            const id2 = (
                (await add(ana, deal, { gateway: 'stripe', reference: ref('pi_401') }).expect(201))
                    .body as DealInvoiceView
            ).id;
            await run(id2, false);
            expect(await one(deal, id2)).toMatchObject({ status: 'needs_review', reasonCode: 'TOKEN_REFUSED' });
        });

        it('a token without the scope, or a payment another release holds, waits for finance', async () => {
            newswireos.answer(ref('pi_403'), new NewswireosApiError(403, 'missing scope'));
            const id = (
                (await add(ana, deal, { gateway: 'stripe', reference: ref('pi_403') }).expect(201))
                    .body as DealInvoiceView
            ).id;
            await run(id, false);
            expect(await one(deal, id)).toMatchObject({ status: 'needs_review', reasonCode: 'TOKEN_LACKS_SCOPE' });

            newswireos.answerWire(ref('pi_used'), {
                status: 'verified',
                reason_code: null,
                amount_cents: 150000,
                currency: 'usd',
                already_used: true,
            });
            const used = (
                (await add(ana, deal, { gateway: 'stripe', reference: ref('pi_used') }).expect(201))
                    .body as DealInvoiceView
            ).id;
            await run(used);
            expect(await one(deal, used)).toMatchObject({ status: 'needs_review', reasonCode: 'ALREADY_USED' });

            // Finance verifies it in NewswireOS, within the on-chain tolerance: the reason is kept.
            const res = await deliver(hookUrl, {
                type: 'payment.verified',
                data: { gateway: 'stripe', reference: ref('pi_used'), reason_code: 'UNDERPAID_WITHIN_TOLERANCE' },
            }).expect(200);
            expect(res.body).toEqual({ result: 'applied' });
            expect(await one(deal, used)).toMatchObject({
                status: 'verified',
                reasonCode: 'UNDERPAID_WITHIN_TOLERANCE',
            });
        });

        it('a verified invoice covering the deal closes it Won by an `invoice.verified` rule', async () => {
            await as(admin)
                .post(w(`/pipelines/${pipelineId}/rules`))
                .send({ event: 'invoice.verified', toStageId: target.id })
                .expect(201);
            const covered = await newDeal(ana, `Covered ${stamp}`, 2_000);
            newswireos.answer(ref('pi_full'), FakeNewswireos.decided('verified'));
            const id = (
                (await add(ana, covered, { gateway: 'stripe', reference: ref('pi_full') }).expect(201))
                    .body as DealInvoiceView
            ).id;
            await run(id);
            const [event] = await outboxEvents(id);
            await app.get(StageRulesService).apply(event!);
            const after = (
                await as(ana)
                    .get(w(`/opportunities/${covered}`))
                    .expect(200)
            ).body as { stageId: string; closedAt: string | null };
            expect(after.stageId).toBe(target.id);
            // The normal close path: closed, and announced as `deal.won` by the rule.
            expect(after.closedAt).not.toBeNull();
            const won = await owner.outboxEvent.findMany({
                where: { workspaceId: workspace, type: 'deal.won', payload: { path: ['recordId'], equals: covered } },
            });
            expect(won).toHaveLength(1);
            expect((won[0]!.payload as unknown as DomainEvent).actor).toMatchObject({ kind: 'rule' });
        });

        it('a refund on the signed hook takes the invoice back; a wrong signature or token is refused', async () => {
            await deliver(
                hookUrl,
                { id: 'evt_1', type: 'payment.refunded', data: { gateway: 'stripe', reference: ref('pi_full') } },
                'wrong-secret-0000000',
            ).expect(401);
            await deliver(hookUrl.replace(/[^/]+$/, 'nope'), {
                type: 'payment.refunded',
                data: { gateway: 'stripe', reference: ref('pi_full') },
            }).expect(404);
            // An event the CRM does not read is acknowledged.
            expect(
                (
                    await deliver(hookUrl, {
                        type: 'release.published',
                        data: { gateway: 'stripe', reference: 'x' },
                    }).expect(200)
                ).body,
            ).toEqual({ result: 'ignored' });

            // Matched by NewswireOS's canonical reference as well as the one entered.
            const res = await deliver(hookUrl, {
                id: 'evt_2',
                type: 'payment.disputed',
                data: {
                    gateway: 'stripe',
                    reference: 'ch_unknown',
                    references: [ref('pi_canon')],
                    reason_code: 'CHARGEBACK',
                },
            }).expect(200);
            expect(res.body).toEqual({ result: 'applied' });
            // NewswireOS retries until it gets a 2xx: the same delivery id is acknowledged, not applied again.
            expect(
                (
                    await deliver(hookUrl, {
                        id: 'evt_2',
                        type: 'payment.disputed',
                        data: { gateway: 'stripe', references: [ref('pi_canon')] },
                    }).expect(200)
                ).body,
            ).toEqual({ result: 'duplicate' });
            const rows = await owner.dealInvoice.findMany({
                where: { workspaceId: workspace, reference: ref('pi_ok') },
            });
            expect(rows[0]).toMatchObject({ status: 'invalidated', reasonCode: 'DISPUTED' });
            const events = await outboxEvents(rows[0]!.id);
            expect(events.at(-1)).toMatchObject({ type: 'invoice.invalidated', invoice: { status: 'invalidated' } });
            // A replay changes nothing.
            expect(
                (
                    await deliver(hookUrl, {
                        type: 'payment.disputed',
                        data: { gateway: 'stripe', references: [ref('pi_canon')] },
                    }).expect(200)
                ).body,
            ).toEqual({ result: 'unmatched' });
        });
    });

    describe('partial refunds', () => {
        it('a partial refund keeps the invoice verified, counts it net, and tells finance the deal is short', async () => {
            const paid = await newDeal(ana, `Refunded ${stamp}`, 10_000);
            newswireos.answer(ref('pi_part'), FakeNewswireos.decided('verified'));
            const id = (
                (await add(ana, paid, { gateway: 'stripe', reference: ref('pi_part') }).expect(201))
                    .body as DealInvoiceView
            ).id;
            await run(id);
            const refund = (refunded: number) =>
                deliver(hookUrl, {
                    type: 'payment.refunded',
                    data: {
                        gateway: 'stripe',
                        reference: ref('pi_part'),
                        amount_cents: 10_000,
                        refunded_amount_cents: refunded,
                    },
                });
            expect((await refund(2_500).expect(200)).body).toEqual({ result: 'applied' });
            expect(await one(paid, id)).toMatchObject({ status: 'verified', refundedAmountMinor: '2500' });
            const events = await outboxEvents(id);
            expect(events.at(-1)).toMatchObject({
                type: 'invoice.refunded',
                invoice: { amountMinor: '10000', refundedAmountMinor: '2500', covers: false },
            });
            const told = (await as(mia).get(w('/notifications')).expect(200)).body as NotificationsView;
            expect(told.items.find((n) => n.kind === 'invoice_coverage_lost')?.invoice).toMatchObject({ id });
            // The deal was closed Won by the rule and stays won.
            const after = (
                await as(ana)
                    .get(w(`/opportunities/${paid}`))
                    .expect(200)
            ).body as { stageId: string };
            expect(after.stageId).toBe(target.id);
            // A replay (or an older total) changes nothing; a larger total moves it on; the whole amount ends it.
            expect((await refund(2_500).expect(200)).body).toEqual({ result: 'unmatched' });
            await refund(4_000).expect(200);
            expect(await one(paid, id)).toMatchObject({ status: 'verified', refundedAmountMinor: '4000' });
            await refund(10_000).expect(200);
            expect(await one(paid, id)).toMatchObject({
                status: 'invalidated',
                reasonCode: 'REFUNDED',
                refundedAmountMinor: '10000',
            });
        });
    });

    describe('cross-tenant', () => {
        it('another workspace cannot read, add to or verify this workspace’s invoices', async () => {
            await as(otherAdmin)
                .get(w(`/opportunities/${deal}/invoices`))
                .expect(403);
            await as(otherAdmin)
                .get(w(`/opportunities/${deal}/invoices`, otherWorkspace))
                .expect(404);
            await add(otherAdmin, deal, { gateway: 'stripe', reference: ref('pi_x') }, otherWorkspace).expect(404);
            const mine = (await listOf(deal))[0]!;
            await as(otherAdmin)
                .post(w(`/opportunities/${deal}/invoices/${mine.id}/verify`, otherWorkspace))
                .send({})
                .expect(404);
            const seen = await rls.withWorkspace(otherWorkspace, (tx) => tx.dealInvoice.count());
            expect(seen).toBe(0);
        });

        it('the same payment may be on a deal in each workspace, and one workspace’s hook touches only its own', async () => {
            const theirs = await newDeal(otherAdmin, `Theirs ${stamp}`, 2_000, otherWorkspace);
            const res = await add(
                otherAdmin,
                theirs,
                { gateway: 'stripe', reference: ref('pi_full') },
                otherWorkspace,
            ).expect(201);
            const id = (res.body as DealInvoiceView).id;
            await run(id, true, otherWorkspace);
            await as(otherAdmin)
                .post(w(`/opportunities/${theirs}/invoices/${id}/verify`, otherWorkspace))
                .send({})
                .expect(200);
            await deliver(hookUrl, {
                type: 'payment.refunded',
                data: { gateway: 'stripe', reference: ref('pi_full') },
            }).expect(200);
            const mine = await owner.dealInvoice.findFirst({
                where: { workspaceId: workspace, reference: ref('pi_full') },
            });
            const other = await owner.dealInvoice.findUnique({ where: { id } });
            expect(mine?.status).toBe('invalidated');
            expect(other?.status).toBe('verified');
        });
    });
});
