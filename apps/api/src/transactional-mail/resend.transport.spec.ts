import { describe, expect, it, vi } from 'vitest';
import { insideTransaction, TransactionAcrossNetworkError } from '../infra/transaction-scope';
import { ResendTransport, TransientMailError } from './resend.transport';
import { RESEND_SEND_URL } from './transactional-mail.constants';
import { PermanentMailError, type OutgoingMail } from './transport.port';

const mail: OutgoingMail = {
    kind: 'email_verification',
    to: 'person@example.test',
    from: 'BylineCRM <no-reply@pinionnewswire.com>',
    subject: 'Verify your email for BylineCRM',
    html: '<p>hi</p>',
    text: 'hi',
    idempotencyKey: 'verify:abc',
};

const answer = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('#93 ResendTransport', () => {
    it('posts one message with the key as bearer and the mail identity as Idempotency-Key', async () => {
        const fetchImpl = vi.fn(() => answer(200, { id: 'msg_1' }));
        const result = await new ResendTransport('re_test_key', fetchImpl as unknown as typeof fetch).send(mail);
        expect(result).toEqual({ id: 'msg_1' });
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(RESEND_SEND_URL);
        const headers = init.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer re_test_key');
        expect(headers['Idempotency-Key']).toBe('verify:abc');
        expect(JSON.parse(init.body as string)).toEqual({
            from: mail.from,
            to: [mail.to],
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
        });
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('treats a refusal a retry cannot fix as permanent, naming Resend’s reason only', async () => {
        for (const [status, name] of [
            [401, 'missing_api_key'],
            [403, 'invalid_api_key'],
            [422, 'validation_error'],
            [409, 'invalid_idempotent_request'],
        ] as const) {
            const fetchImpl = vi.fn(() => answer(status, { name, message: 'secret detail' }));
            const sending = new ResendTransport('re_k', fetchImpl as unknown as typeof fetch).send(mail);
            await expect(sending).rejects.toBeInstanceOf(PermanentMailError);
            await expect(
                new ResendTransport('re_k', vi.fn(() => answer(status, { name })) as unknown as typeof fetch).send(
                    mail,
                ),
            ).rejects.toThrow(name);
        }
    });

    it('retries rate limits, server errors, racing idempotent requests, timeouts and network failures', async () => {
        for (const [status, name] of [
            [429, 'rate_limit_exceeded'],
            [500, 'internal_server_error'],
            [409, 'concurrent_idempotent_requests'],
        ] as const) {
            const fetchImpl = vi.fn(() => answer(status, { name }));
            await expect(
                new ResendTransport('re_k', fetchImpl as unknown as typeof fetch).send(mail),
            ).rejects.toBeInstanceOf(TransientMailError);
        }
        const timeout = vi.fn(() => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })));
        await expect(new ResendTransport('re_k', timeout as unknown as typeof fetch).send(mail)).rejects.toThrow(
            /timed out/,
        );
        const network = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
        await expect(new ResendTransport('re_k', network as unknown as typeof fetch).send(mail)).rejects.toThrow(
            /network error/,
        );
    });

    it('never calls out inside a tenant transaction', async () => {
        const fetchImpl = vi.fn(() => answer(200, { id: 'x' }));
        await expect(
            insideTransaction([], () => new ResendTransport('re_k', fetchImpl as unknown as typeof fetch).send(mail)),
        ).rejects.toBeInstanceOf(TransactionAcrossNetworkError);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
