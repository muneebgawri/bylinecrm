import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmailApiError } from './gmail.port';
import { GmailHttp } from './gmail.http';

function respond(status: number, body: unknown) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('GmailHttp', () => {
    afterEach(() => vi.restoreAllMocks());

    it('sends the bearer token and reads the history page', async () => {
        const spy = respond(200, {
            historyId: '900',
            nextPageToken: 'p2',
            history: [{ messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] }, { labelsAdded: [] }],
        });
        const page = await new GmailHttp().listHistory('tok', { startHistoryId: '100' });
        expect(page).toEqual({ addedMessageIds: ['a', 'b'], historyId: '900', nextPageToken: 'p2' });
        const [url, init] = spy.mock.calls[0]!;
        expect(String(url)).toContain('/history?startHistoryId=100&historyTypes=messageAdded');
        expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    });

    it('turns Gmail errors into GmailApiError with the status and reason, never the token', async () => {
        respond(404, { error: { errors: [{ reason: 'notFound' }], status: 'NOT_FOUND' } });
        const error = await new GmailHttp()
            .listHistory('secret-token', { startHistoryId: '1' })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GmailApiError);
        expect(error).toMatchObject({ status: 404, reason: 'notFound' });
        expect((error as Error).message).not.toContain('secret-token');
    });

    it('marks 429 and 5xx as transient', async () => {
        respond(429, { error: { errors: [{ reason: 'rateLimitExceeded' }] } });
        const throttled = (await new GmailHttp().getProfile('t').catch((e: unknown) => e)) as GmailApiError;
        expect(throttled.transient).toBe(true);
        expect(new GmailApiError(403, 'forbidden', 'x').transient).toBe(false);
    });

    it('reports a network failure without a status', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        await expect(new GmailHttp().getProfile('t')).rejects.toMatchObject({ status: null, reason: 'network' });
    });
});
