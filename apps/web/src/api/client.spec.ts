import { CSRF_COOKIE, CSRF_HEADER } from '@bylinecrm/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fieldErrorAt, isClientError, onUnauthorized, readCookie, request } from './client';

function stubFetch(status: number, body?: unknown) {
    const fetchMock = vi.fn(() =>
        Promise.resolve(
            new Response(body === undefined ? null : JSON.stringify(body), {
                status,
                headers: { 'Content-Type': 'application/json' },
            }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function sentInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
    return fetchMock.mock.calls[0]?.[1] as RequestInit;
}

describe('request', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.cookie = `${CSRF_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    });

    it('sends the session cookie and prefixes the path', async () => {
        const fetchMock = stubFetch(200, { ok: true });
        await request('GET', '/me');
        expect(fetchMock).toHaveBeenCalledWith('/api/me', expect.objectContaining({ credentials: 'include' }));
    });

    it('echoes the CSRF cookie in the header on a mutating request, and not on a read', async () => {
        document.cookie = `${CSRF_COOKIE}=tok-123`;
        const post = stubFetch(204);
        await request('POST', '/auth/logout');
        expect(new Headers(sentInit(post).headers).get(CSRF_HEADER)).toBe('tok-123');

        const get = stubFetch(200, {});
        await request('GET', '/me');
        expect(new Headers(sentInit(get).headers).get(CSRF_HEADER)).toBeNull();
    });

    it('serialises a JSON body and returns undefined for 204', async () => {
        const fetchMock = stubFetch(204);
        const result = await request('PATCH', '/w/1/members/2/role', { body: { roleId: 'r' } });
        expect(result).toBeUndefined();
        expect(sentInit(fetchMock).body).toBe('{"roleId":"r"}');
        expect(new Headers(sentInit(fetchMock).headers).get('Content-Type')).toBe('application/json');
    });

    it('reads the one error envelope into ApiError, request id included', async () => {
        stubFetch(403, {
            statusCode: 403,
            code: 'forbidden',
            message: 'not a member of this workspace',
            requestId: 'req-0123456789',
        });
        await expect(request('GET', '/w/x/members')).rejects.toMatchObject({
            name: 'ApiError',
            status: 403,
            code: 'forbidden',
            message: 'not a member of this workspace',
            requestId: 'req-0123456789',
            isForbidden: true,
            fieldErrors: [],
        });
    });

    it('carries field errors by dotted path', async () => {
        stubFetch(400, {
            statusCode: 400,
            code: 'validation.failed',
            message: 'the request is not valid',
            fieldErrors: [{ path: 'emails.primary', message: 'Invalid email' }],
            requestId: 'req-0123456789',
        });
        const error = await request('POST', '/w/x/people', { body: {} }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe('validation.failed');
        expect((error as ApiError).fieldErrors).toEqual([{ path: 'emails.primary', message: 'Invalid email' }]);
        expect(isClientError(error)).toBe(true);
    });

    it('a body that is not the envelope (a proxy page) is coded from its status', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })),
            ),
        );
        await expect(request('GET', '/me')).rejects.toMatchObject({
            status: 502,
            code: 'internal',
            message: 'Bad Gateway',
            requestId: null,
            fieldErrors: [],
        });
    });

    it('tells the unauthorized listeners on a 401, once per response', async () => {
        const listener = vi.fn();
        const off = onUnauthorized(listener);
        stubFetch(401, { statusCode: 401, code: 'unauthorized', message: 'Unauthorized', requestId: 'req-0123456789' });
        await expect(request('GET', '/me')).rejects.toMatchObject({ isUnauthorized: true });
        expect(listener).toHaveBeenCalledTimes(1);
        off();
        stubFetch(401, { statusCode: 401, code: 'unauthorized', message: 'Unauthorized', requestId: 'req-0123456789' });
        await request('GET', '/me').catch(() => undefined);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not treat a network failure as a client error', () => {
        expect(isClientError(new TypeError('Failed to fetch'))).toBe(false);
    });
});

describe('readCookie', () => {
    it('finds a cookie by name and decodes its value', () => {
        expect(readCookie('b', 'a=1; b=two%20words; c=3')).toBe('two words');
        expect(readCookie('missing', 'a=1')).toBeUndefined();
        expect(readCookie('a', 'a=x=y')).toBe('x=y');
    });
});

describe('#76 fieldErrorAt, the one field-error lookup', () => {
    const error = new ApiError(400, 'validation.failed', 'invalid', [
        { path: 'password', message: 'too short' },
        { path: 'body.content.1.text', message: 'empty variable' },
    ]);

    it('finds the error at a path exactly', () => {
        expect(fieldErrorAt(error, 'password')).toBe('too short');
        expect(fieldErrorAt(error, 'email')).toBeUndefined();
        expect(fieldErrorAt(new Error('x'), 'password')).toBeUndefined();
    });

    it('with within, also an error anywhere under the path', () => {
        expect(fieldErrorAt(error, 'body')).toBeUndefined();
        expect(fieldErrorAt(error, 'body', { within: true })).toBe('empty variable');
    });
});
