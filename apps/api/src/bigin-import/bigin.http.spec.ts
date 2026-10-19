import { afterEach, describe, expect, it, vi } from 'vitest';
import { BIGIN_CREDENTIALS_REFUSED, BiginApiError, BiginHttp } from './bigin.http';

const connection = {
    accountsUrl: 'https://accounts.zoho.example',
    apiUrl: 'https://www.zohoapis.example',
    clientId: 'client',
    clientSecret: 'secret-value',
    refreshToken: 'refresh-value',
};
const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('FR-CRMS-25 BIGIN-1 Bigin HTTP adapter', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('takes a token by the refresh grant, reuses it, and reads oldest modification first with If-Modified-Since', async () => {
        const calls: { url: string; init?: RequestInit | undefined }[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: RequestInit) => {
                calls.push({ url, init });
                if (url.endsWith('/oauth/v2/token'))
                    return Promise.resolve(json(200, { access_token: 't1', expires_in: 3600 }));
                return Promise.resolve(json(200, { data: [{ id: '1' }], info: { more_records: true } }));
            }),
        );
        const http = new BiginHttp({ sleep: () => Promise.resolve() }, { fetch: (u, i) => globalThis.fetch(u, i) });
        const page = await http.list(connection, 'Contacts', { since: '2026-10-01T00:00:00.000Z', page: 2 });
        await http.list(connection, 'Contacts', { since: null, page: 1 });
        expect(page).toEqual({ records: [{ id: '1' }], moreRecords: true });
        expect(calls.filter((c) => c.url.endsWith('/oauth/v2/token'))).toHaveLength(1);
        const read = calls[1]!;
        expect(read.url).toContain('/bigin/v1/Contacts?per_page=200&page=2&sort_by=Modified_Time&sort_order=asc');
        const headers = read.init!.headers as Record<string, string>;
        expect(headers.authorization).toBe('Zoho-oauthtoken t1');
        expect(headers['if-modified-since']).toBe('Thu, 01 Oct 2026 00:00:00 GMT');
    });

    it('a 304 is an empty page; a 429 is retried; refused credentials are final and never carry a secret', async () => {
        const answers = [
            json(200, { access_token: 't1', expires_in: 3600 }),
            json(429, { code: 'TOO_MANY' }),
            new Response(null, { status: 304 }),
        ];
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(answers.shift()!)),
        );
        const http = new BiginHttp({ sleep: () => Promise.resolve() }, { fetch: (u, i) => globalThis.fetch(u, i) });
        expect(await http.list(connection, 'Deals', { since: '2026-10-01T00:00:00Z', page: 1 })).toEqual({
            records: [],
            moreRecords: false,
        });

        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(json(200, { error: 'invalid_client' }))),
        );
        const refused = await new BiginHttp({}, { fetch: (u, i) => globalThis.fetch(u, i) })
            .list(connection, 'Deals', { since: null, page: 1 })
            .catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(BiginApiError);
        expect((refused as BiginApiError).permanent).toBe(true);
        expect((refused as BiginApiError).message).toBe(BIGIN_CREDENTIALS_REFUSED);
        expect((refused as BiginApiError).message).not.toContain('secret-value');
    });

    it('refuses a private target by default and never follows a redirect (audit, #217)', async () => {
        vi.unstubAllGlobals();
        const guarded = await new BiginHttp({ sleep: () => Promise.resolve() })
            .list({ ...connection, accountsUrl: 'http://127.0.0.1:9', apiUrl: 'http://127.0.0.1:9' }, 'Deals', {
                since: null,
                page: 1,
            })
            .catch((e: unknown) => e);
        expect(guarded).toBeInstanceOf(BiginApiError);
        expect((guarded as BiginApiError).message).toMatch(/did not answer/);

        const seen: RequestInit[] = [];
        const http = new BiginHttp(
            { sleep: () => Promise.resolve() },
            {
                fetch: (_u, init) => {
                    seen.push(init);
                    return Promise.resolve(json(200, { access_token: 't1', expires_in: 3600 }));
                },
            },
        );
        await http.count(connection, 'Deals').catch(() => null);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((i) => i.redirect === 'error')).toBe(true);
    });
});
