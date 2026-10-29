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

    it('PNW-1125 keeps Google’s own message and when it says to retry, from the body or the Retry-After header', async () => {
        respond(403, {
            error: {
                errors: [
                    {
                        reason: 'rateLimitExceeded',
                        message: 'User-rate limit exceeded.  Retry after 2026-10-29T18:12:00.000Z',
                    },
                ],
                message: 'User-rate limit exceeded.  Retry after 2026-10-29T18:12:00.000Z',
                status: 'PERMISSION_DENIED',
            },
        });
        const fromBody = (await new GmailHttp().getProfile('t').catch((e: unknown) => e)) as GmailApiError;
        expect(fromBody).toMatchObject({ status: 403, reason: 'rateLimitExceeded' });
        expect(fromBody.googleMessage).toBe('User-rate limit exceeded.  Retry after 2026-10-29T18:12:00.000Z');
        expect(fromBody.retryAfter).toEqual(new Date('2026-10-29T18:12:00.000Z'));

        vi.restoreAllMocks();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }), {
                status: 429,
                headers: { 'retry-after': '120' },
            }),
        );
        const before = Date.now();
        const fromHeader = (await new GmailHttp().getProfile('t').catch((e: unknown) => e)) as GmailApiError;
        expect(fromHeader.retryAfter!.getTime()).toBeGreaterThanOrEqual(before + 119_000);
        expect(fromHeader.googleMessage).toBeNull();
    });

    it('reports a network failure without a status', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        await expect(new GmailHttp().getProfile('t')).rejects.toMatchObject({ status: null, reason: 'network' });
    });

    it('FR-CRMS-2 sends a raw message as base64url JSON, in the thread when given', async () => {
        const spy = respond(200, { id: 'sent-1', threadId: 'thr-9', labelIds: ['SENT'] });
        const mime = 'From: a@x.example\r\nSubject: Hé\r\n\r\nbody';
        const sent = await new GmailHttp().send('tok', { raw: mime, threadId: 'thr-9' });
        expect(sent).toEqual({ id: 'sent-1', threadId: 'thr-9' });
        const [url, init] = spy.mock.calls[0]!;
        expect(String(url)).toMatch(/\/messages\/send$/);
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
        expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
        const body = JSON.parse(String(init?.body)) as { raw: string; threadId?: string };
        expect(Buffer.from(body.raw, 'base64url').toString('utf8')).toBe(mime);
        expect(body.raw).not.toMatch(/[+/=]/);
        expect(body.threadId).toBe('thr-9');
    });

    it('FR-CRMS-2 reads only the named headers of a message (format=metadata)', async () => {
        const spy = respond(200, {
            id: 'm9',
            threadId: 't9',
            payload: { headers: [{ name: 'X-BylineCRM-Id', value: 'abc' }, { name: 7 }] },
        });
        const found = await new GmailHttp().getMessageHeaders('tok', 'm9', ['X-BylineCRM-Id']);
        expect(found).toEqual({ id: 'm9', threadId: 't9', headers: [{ name: 'X-BylineCRM-Id', value: 'abc' }] });
        expect(String(spy.mock.calls[0]![0])).toContain('/messages/m9?format=metadata&metadataHeaders=X-BylineCRM-Id');
    });

    it('FR-CRMS-2 sends a new message without a thread', async () => {
        const spy = respond(200, { id: 'sent-2', threadId: 'thr-new' });
        await new GmailHttp().send('tok', { raw: 'x' });
        const body = JSON.parse(String(spy.mock.calls[0]![1]?.body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty('threadId');
    });
});
