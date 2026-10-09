import { CSRF_COOKIE, CSRF_HEADER } from '@bylinecrm/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, isClientError, onUnauthorized, readCookie, request } from './client';

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

    it('normalises a Nest error envelope into ApiError', async () => {
        stubFetch(403, { statusCode: 403, error: 'Forbidden', message: 'not a member of this workspace' });
        await expect(request('GET', '/w/x/members')).rejects.toMatchObject({
            name: 'ApiError',
            status: 403,
            code: 'Forbidden',
            message: 'not a member of this workspace',
            isForbidden: true,
        });
    });

    it('carries validation issues as field errors by dotted path', async () => {
        stubFetch(400, {
            statusCode: 400,
            message: 'Validation failed',
            errors: [{ path: ['emails', 'primary'], message: 'Invalid email' }],
        });
        const error = await request('POST', '/w/x/people', { body: {} }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).fieldErrors).toEqual([{ path: 'emails.primary', message: 'Invalid email' }]);
        expect(isClientError(error)).toBe(true);
    });

    it('tells the unauthorized listeners on a 401, once per response', async () => {
        const listener = vi.fn();
        const off = onUnauthorized(listener);
        stubFetch(401, { statusCode: 401, message: 'Unauthorized' });
        await expect(request('GET', '/me')).rejects.toMatchObject({ isUnauthorized: true });
        expect(listener).toHaveBeenCalledTimes(1);
        off();
        stubFetch(401, { statusCode: 401, message: 'Unauthorized' });
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
