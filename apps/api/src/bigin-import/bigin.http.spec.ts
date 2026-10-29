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
                return Promise.resolve(
                    json(200, {
                        data: [{ id: '1', Last_Name: 'Lee', $approved: true }],
                        info: { more_records: true, next_page_token: 'tok-2' },
                    }),
                );
            }),
        );
        const http = new BiginHttp({ sleep: () => Promise.resolve() }, { fetch: (u, i) => globalThis.fetch(u, i) });
        // A window reads v1, which narrows by `If-Modified-Since`; v1 gives no page token.
        const page = await http.list(connection, 'Contacts', { since: '2026-10-01T00:00:00.000Z', page: 2 });
        expect(page).toEqual({
            records: [{ id: '1', Last_Name: 'Lee', $approved: true }],
            moreRecords: true,
            nextPageToken: null,
        });
        const read = calls.find((c) => c.url.includes('/bigin/v1/Contacts?'))!;
        expect(read.url).toMatch(/[?&]page=2(&|$)/);
        expect(read.url).toContain('sort_by=Modified_Time');
        const headers = read.init!.headers as Record<string, string>;
        expect(headers.authorization).toBe('Zoho-oauthtoken t1');
        expect(headers['if-modified-since']).toBe('Thu, 01 Oct 2026 00:00:00 GMT');
        // By token: the fields are sampled once from v1 (every field, `$` meta left out), then v2 from its first page.
        const byToken = await http.list(connection, 'Contacts', { since: null, page: 11, byToken: true });
        await http.list(connection, 'Contacts', { since: null, page: 12, pageToken: 'tok-2' });
        expect(byToken.nextPageToken).toBe('tok-2');
        expect(calls.filter((c) => c.url.endsWith('/oauth/v2/token'))).toHaveLength(1);
        expect(calls.filter((c) => c.url.includes('/bigin/v1/Contacts?'))).toHaveLength(2);
        const [first, next] = calls.filter((c) => c.url.includes('/bigin/v2/Contacts?'));
        expect(first!.url).toContain('fields=id%2CModified_Time%2CCreated_Time%2CLast_Name');
        expect(first!.url).toMatch(/[?&]page=1(&|$)/);
        expect(first!.url).not.toContain('%24approved');
        expect(next!.url).toContain('page_token=tok-2');
    });

    it('asks v2 for the mapped fields first: past the 50-field cap a custom field is dropped, never First_Name', async () => {
        const calls: string[] = [];
        const customs = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`Custom_${i}`, null]));
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                calls.push(url);
                if (url.endsWith('/oauth/v2/token'))
                    return Promise.resolve(json(200, { access_token: 't1', expires_in: 3600 }));
                return Promise.resolve(
                    json(200, {
                        data: [{ id: '1', ...customs, Last_Name: 'Glusman', First_Name: 'Jeffrey', PR_LINK: null }],
                        info: { more_records: false },
                    }),
                );
            }),
        );
        const http = new BiginHttp({ sleep: () => Promise.resolve() }, { fetch: (u, i) => globalThis.fetch(u, i) });
        await http.list(connection, 'Contacts', { since: null, page: 11, byToken: true });
        const v2 = new URL(calls.find((c) => c.includes('/bigin/v2/Contacts?'))!);
        const fields = v2.searchParams.get('fields')!.split(',');
        expect(fields).toHaveLength(50);
        expect(fields.slice(0, 6)).toEqual([
            'id',
            'Modified_Time',
            'Created_Time',
            'First_Name',
            'Last_Name',
            'PR_LINK',
        ]);
        expect(fields).not.toContain('Custom_59');
    });

    it('BIGIN-1: a task’s record is answered only when named — v1 and v2 both ask for What_Id and Who_Id, which no sample shows', async () => {
        const calls: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                calls.push(url);
                if (url.endsWith('/oauth/v2/token'))
                    return Promise.resolve(json(200, { access_token: 't1', expires_in: 3600 }));
                return Promise.resolve(
                    json(200, { data: [{ id: '1', Subject: 'Call back', Status: 'In Progress' }], info: {} }),
                );
            }),
        );
        const http = new BiginHttp({ sleep: () => Promise.resolve() }, { fetch: (u, i) => globalThis.fetch(u, i) });
        await http.list(connection, 'Tasks', { since: null, page: 1 });
        await http.list(connection, 'Tasks', { since: null, page: 11, byToken: true });
        const named = (fragment: string) =>
            new URL(calls.find((c) => c.includes(fragment) && c.includes('fields='))!).searchParams
                .get('fields')!
                .split(',');
        for (const fields of [named('/bigin/v1/Tasks?'), named('/bigin/v2/Tasks?')]) {
            expect(fields.slice(0, 5)).toEqual(['id', 'Modified_Time', 'Created_Time', 'What_Id', 'Who_Id']);
            expect(fields).toEqual(expect.arrayContaining(['Subject', 'Status']));
        }
        // Every other module's v1 list names no fields: v1 answers them all.
        await http.list(connection, 'Contacts', { since: null, page: 1 });
        expect(calls.filter((c) => c.includes('/bigin/v1/Contacts?')).every((c) => !c.includes('fields='))).toBe(true);
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
            nextPageToken: null,
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

    it('BIGIN-1 inventory: lists the API-served modules and describes a module’s fields with its picklists', async () => {
        const fetch = vi.fn((url: string) => {
            if (url.endsWith('/oauth/v2/token'))
                return Promise.resolve(json(200, { access_token: 't', expires_in: 3600 }));
            if (url.includes('/settings/modules')) {
                return Promise.resolve(
                    json(200, {
                        modules: [
                            { api_name: 'Contacts', plural_label: 'Contacts', api_supported: true },
                            { api_name: 'Tasks', module_name: 'Tasks' },
                            { api_name: 'Home', plural_label: 'Home', api_supported: false },
                            { plural_label: 'nameless' },
                        ],
                    }),
                );
            }
            return Promise.resolve(
                json(200, {
                    fields: [
                        {
                            api_name: 'Pipeline',
                            field_label: 'Pipeline',
                            data_type: 'picklist',
                            custom_field: false,
                            pick_list_values: [
                                { display_value: 'Sales', actual_value: 'Sales' },
                                { display_value: 'Renewals' },
                            ],
                        },
                        { api_name: 'PR_LINK', field_label: 'PR link', data_type: 'website', custom_field: true },
                    ],
                }),
            );
        });
        const http = new BiginHttp({ sleep: () => Promise.resolve() }, { fetch });
        expect(await http.modules(connection)).toEqual([
            { apiName: 'Contacts', label: 'Contacts', apiSupported: true },
            { apiName: 'Tasks', label: 'Tasks', apiSupported: true },
            { apiName: 'Home', label: 'Home', apiSupported: false },
        ]);
        expect(await http.fieldDefinitions(connection, 'Deals')).toEqual([
            { apiName: 'Pipeline', label: 'Pipeline', type: 'picklist', custom: false, values: ['Sales', 'Renewals'] },
            { apiName: 'PR_LINK', label: 'PR link', type: 'website', custom: true, values: [] },
        ]);
        expect(fetch.mock.calls.some(([u]) => String(u).includes('/settings/fields?module=Deals'))).toBe(true);
    });
});
