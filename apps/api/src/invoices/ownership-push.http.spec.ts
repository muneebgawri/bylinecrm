import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewswireosApiError } from './newswireos-verification.port';
import { NewswireosOwnershipHttp, parseOwnershipAnswer } from './ownership-push.http';
import type { OwnershipChangedBody } from './ownership-push.port';
import { OwnershipPushService } from './ownership-push.service';

const link = { baseUrl: 'https://nw.example.test/', apiToken: 'tok_secret' };
const body: OwnershipChangedBody = {
    event_id: '00000000-0000-4000-8000-000000000001',
    occurred_at: '2026-10-21T09:00:00.000Z',
    record_type: 'company',
    record: {
        byline_id: '00000000-0000-4000-8000-000000000002',
        emails: ['a@acme.test'],
        domain: 'acme.test',
        name: 'Acme',
    },
    previous_owner: null,
    new_owner: { email: 'owner@example.test' },
    reason: 'first_contact',
    forced: false,
};

function answer(status: number, json: unknown) {
    return vi.fn().mockResolvedValue(new Response(JSON.stringify(json), { status }));
}

async function failure(promise: Promise<unknown>): Promise<NewswireosApiError> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof NewswireosApiError) return error;
        throw error;
    }
    throw new Error('expected a NewswireosApiError');
}

describe('PNW-765 NewswireOS ownership push (HTTP)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('posts the body to ownership-changed with the bearer token, and reads the answer', async () => {
        const fetch = answer(200, {
            matched: true,
            reason_code: 'REASSIGNED',
            customers: [
                { customer_id: 42, reason_code: 'REASSIGNED' },
                { customer_id: 'c7', reason_code: 'AGENCY_CLIENT' },
            ],
        });
        vi.stubGlobal('fetch', fetch);
        await expect(new NewswireosOwnershipHttp().push(link, body)).resolves.toEqual({
            matched: true,
            reasonCode: 'REASSIGNED',
            customers: [
                { customerId: '42', reasonCode: 'REASSIGNED' },
                { customerId: 'c7', reasonCode: 'AGENCY_CLIENT' },
            ],
        });
        const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://nw.example.test/api/v1/crm/ownership-changed');
        expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok_secret');
        expect(JSON.parse(init.body as string)).toEqual(body);
    });

    it('a 4xx is final, a 404 is "not ready", a 5xx and no answer are transient; the token is never in the message', async () => {
        vi.stubGlobal('fetch', answer(422, { message: 'bad emails', reason_code: 'INVALID_PAYLOAD' }));
        const refused = await failure(new NewswireosOwnershipHttp().push(link, body));
        expect(refused).toMatchObject({ status: 422, reasonCode: 'INVALID_PAYLOAD', transient: false });

        vi.stubGlobal('fetch', answer(404, {}));
        expect(await failure(new NewswireosOwnershipHttp().push(link, body))).toMatchObject({
            status: 404,
            transient: false,
        });

        vi.stubGlobal('fetch', answer(502, null));
        expect((await failure(new NewswireosOwnershipHttp().push(link, body))).transient).toBe(true);

        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
        const none = await failure(new NewswireosOwnershipHttp().push(link, body));
        expect(none).toMatchObject({ status: null, transient: true });
        expect(none.message).not.toContain('tok_secret');
    });

    it('reads an answer defensively', () => {
        expect(parseOwnershipAnswer(null)).toEqual({ matched: false, customers: [], reasonCode: null });
        expect(
            parseOwnershipAnswer({ matched: 'yes', customers: [{ customer_id: '' }], reason_code: 'NO_CUSTOMER' }),
        ).toEqual({
            matched: false,
            customers: [],
            reasonCode: 'NO_CUSTOMER',
        });
    });

    it('reads completed transfers only, never an import’s owner fill', () => {
        const event = {
            type: 'transfer.completed',
            object: 'transfer',
            workspaceId: 'w',
            recordId: 't',
            occurredAt: body.occurred_at,
            actor: { type: 'system' },
            transfer: { reason: null },
        } as unknown as Parameters<typeof OwnershipPushService.accepts>[0];
        expect(OwnershipPushService.accepts(event)).toBe(true);
        expect(OwnershipPushService.accepts({ ...event, internal: true } as typeof event)).toBe(false);
        expect(
            OwnershipPushService.accepts({ ...event, transfer: { reason: 'import_fill' } } as unknown as typeof event),
        ).toBe(false);
        expect(OwnershipPushService.accepts({ ...event, type: 'transfer.proposed' } as unknown as typeof event)).toBe(
            false,
        );
    });
});
