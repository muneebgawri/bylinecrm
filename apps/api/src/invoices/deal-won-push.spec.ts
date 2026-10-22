import type { DomainEvent } from '@bylinecrm/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewswireosDealWonHttp, parseDealWonAnswer } from './deal-won-push.http';
import type { DealWonBody } from './deal-won-push.port';
import { DealWonPushService } from './deal-won-push.service';
import { NewswireosApiError } from './newswireos-verification.port';
import { amOf, parseTimeline } from './newswireos-timeline.service';

const link = { baseUrl: 'https://nw.example.test/', apiToken: 'tok_secret' };
const body: DealWonBody = {
    event_id: '00000000-0000-4000-8000-000000000001',
    occurred_at: '2026-10-22T09:00:00.000Z',
    deal: {
        byline_id: '00000000-0000-4000-8000-000000000002',
        name: 'Acme launch',
        amount_minor: 100,
        currency: 'USD',
    },
    company: { byline_id: '00000000-0000-4000-8000-000000000003', name: 'Acme', domain: 'acme.test' },
    contact: { byline_id: '00000000-0000-4000-8000-000000000004', email: 'ana@acme.test', name: 'Ana' },
    owner: { email: 'owner@example.test' },
};

describe('PNW-766 deal-won push over HTTP', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('posts the body with the token as a bearer and reads the answer', async () => {
        const fetch = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    customer_id: 'u_1',
                    reason_code: 'COLLEAGUE',
                    am_reason_code: 'UNCHANGED',
                    parent_customer_id: 'u_0',
                }),
                { status: 200 },
            ),
        );
        vi.stubGlobal('fetch', fetch);
        expect(await new NewswireosDealWonHttp().push(link, body)).toEqual({
            customerId: 'u_1',
            parentCustomerId: 'u_0',
            reasonCode: 'COLLEAGUE',
            amReasonCode: 'UNCHANGED',
        });
        const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://nw.example.test/api/v1/crm/deal-won');
        expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok_secret');
        expect(JSON.parse(init.body as string)).toEqual(body);
    });

    it('a refusal is a NewswireosApiError with its status and message, never the token', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'nope' }), { status: 403 })),
        );
        const error = await new NewswireosDealWonHttp().push(link, body).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NewswireosApiError);
        expect(error).toMatchObject({ status: 403, message: 'nope' });
        expect(String((error as Error).message)).not.toContain('tok_secret');
    });

    it('reads NOT_A_CLIENT (a null customer) and numeric ids', () => {
        expect(parseDealWonAnswer({ customer_id: null, reason_code: 'NOT_A_CLIENT', am_reason_code: null })).toEqual({
            customerId: null,
            parentCustomerId: null,
            reasonCode: 'NOT_A_CLIENT',
            amReasonCode: null,
        });
        expect(parseDealWonAnswer({ customer_id: 42 }).customerId).toBe('42');
        expect(parseDealWonAnswer('garbage').reasonCode).toBeNull();
    });

    it('pushes every won deal but an import’s', () => {
        const event = { type: 'deal.won', actor: { kind: 'member', id: 'm' } } as unknown as DomainEvent;
        expect(DealWonPushService.accepts(event)).toBe(true);
        expect(DealWonPushService.accepts({ ...event, actor: { kind: 'import', id: null } } as DomainEvent)).toBe(
            false,
        );
        expect(DealWonPushService.accepts({ ...event, type: 'deal.lost' } as DomainEvent)).toBe(false);
    });
});

describe('PNW-766 deal-won "Send test"', () => {
    const owner = { user: { email: 'Owner@Example.test' } };
    const deal = (id: string, contact: { emailPrimary: string | null } | null) => ({
        id,
        name: `Deal ${id}`,
        amountMinor: 500n,
        currency: 'EUR',
        deletedAt: null,
        stage: { kind: 'won' },
        owner,
        company: { id: 'co', name: 'Acme', domain: 'Acme.test', owner: null },
        pointOfContact: contact && {
            id: 'p',
            nameFirst: 'Ana',
            nameLast: '',
            deletedAt: null,
            owner: null,
            company: null,
            ...contact,
        },
    });
    const service = (deals: ReturnType<typeof deal>[]) => {
        const port = { push: vi.fn() };
        const tx = {
            opportunity: {
                findMany: vi.fn().mockResolvedValue(deals.map((d) => ({ id: d.id, closedAt: null }))),
                findUnique: vi.fn(({ where }: { where: { id: string } }) => deals.find((d) => d.id === where.id)),
            },
        };
        const rls = { withWorkspace: (fn: (t: typeof tx) => unknown) => fn(tx) };
        return { port, svc: new DealWonPushService(rls as never, {} as never, {} as never, port, {} as never) };
    };

    it('shows the latest deal that qualifies and sends nothing', async () => {
        const { port, svc } = service([
            deal('d1', { emailPrimary: null }),
            deal('d2', { emailPrimary: 'ana@acme.test' }),
        ]);
        const preview = await svc.preview();
        expect(preview).toMatchObject({
            sent: false,
            found: true,
            opportunityId: 'd2',
            payload: {
                deal: { byline_id: 'd2', name: 'Deal d2', amount_minor: 500, currency: 'EUR' },
                company: { byline_id: 'co', name: 'Acme', domain: 'acme.test' },
                contact: { byline_id: 'p', email: 'ana@acme.test', name: 'Ana' },
                owner: { email: 'owner@example.test' },
            },
        });
        expect(port.push).not.toHaveBeenCalled();
    });

    it('answers found: false when none qualifies', async () => {
        const { svc } = service([deal('d1', null)]);
        expect(await svc.preview()).toEqual({ sent: false, found: false, opportunityId: null, payload: null });
    });
});

describe('PNW-766 timeline deliveries', () => {
    const envelope = (type: string, data: unknown) => ({
        id: 'evt_body',
        event_type: type,
        occurred_at: '2026-10-22T09:00:00Z',
        data,
    });

    it('reads the five events, preferring x-webhook-id; anything else is the payment hook’s', () => {
        const parsed = parseTimeline(
            envelope('invoice.paid', {
                kind: 'invoice.paid',
                title: 'Invoice INV-1 paid',
                url: 'https://nw.example.test/acme/clients/u_1/',
                amount_cents: 1200,
                currency: 'eur',
                client: {
                    customer_id: 'u_1',
                    email: ' Ana@Acme.TEST ',
                    name: 'Ana',
                    company_domain: 'Acme.test',
                    byline_contact_id: null,
                    byline_company_id: 'c-1',
                },
            }),
            'evt_header',
        );
        expect(parsed).toMatchObject({
            id: 'evt_header',
            type: 'invoice.paid',
            title: 'Invoice INV-1 paid',
            amount: { amountMinor: 1200, currency: 'EUR' },
            client: { customerId: 'u_1', email: 'ana@acme.test', companyDomain: 'acme.test', bylineCompanyId: 'c-1' },
        });
        expect(parseTimeline(envelope('payment.refunded', {}), 'evt')).toBeNull();
        expect(parseTimeline({}, undefined)).toBeNull();
    });

    it('an event with no id or title is ignored; an agency’s (no client) is kept', () => {
        expect(parseTimeline({ event_type: 'order.paid', data: { title: 'Order paid' } }, undefined)).toBe('ignored');
        expect(parseTimeline(envelope('order.paid', { client: null }), 'evt')).toBe('ignored');
        expect(parseTimeline(envelope('order.paid', { title: 'Order paid', client: null }), undefined)).toMatchObject({
            id: 'evt_body',
            client: null,
            amount: null,
        });
    });

    it('a URL that is not http(s) is dropped', () => {
        const parsed = parseTimeline(
            envelope('client.created', { title: 'Client account created', url: 'javascript:alert(1)' }),
            'e',
        );
        expect(parsed).toMatchObject({ url: null });
    });

    it('the account manager is am.assigned’s data.account_manager name', () => {
        const parsed = parseTimeline(
            envelope('am.assigned', {
                title: 'Account manager: Someone Else',
                account_manager: { id: 'u1', name: ' Mia  Lopez ', email: 'mia@example.com' },
            }),
            'e',
        );
        expect(parsed).toMatchObject({ accountManager: 'Mia  Lopez' });
        expect(amOf(parsed as { title: string; accountManager: string | null })).toBe('Mia Lopez');
    });

    it('without data.account_manager, the account manager is the title’s name', () => {
        expect(amOf({ title: 'Account manager: Mia  Lopez', accountManager: null })).toBe('Mia Lopez');
        expect(amOf({ title: 'Account manager: ', accountManager: null })).toBeNull();
        expect(amOf({ title: 'Client account created', accountManager: null })).toBeNull();
    });
});
