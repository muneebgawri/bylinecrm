import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A record as Bigin's REST API returns it: its numeric id, `Modified_Time`, and the module's fields. */
export type FakeBiginRecord = Record<string, unknown> & { id: string; Modified_Time: string; Created_Time: string };

export interface FakeBiginRequest {
    method: string;
    path: string;
    ifModifiedSince: string | undefined;
}

const PAGE_MAX = 200;

/**
 * An in-process stand-in for Zoho Bigin (BIGIN-1): Zoho's token endpoint (`POST /oauth/v2/token`, a
 * refresh-token grant answering `{ access_token, expires_in }`, or `200 { error }` for refused credentials,
 * as Zoho does) and the Bigin read grammar the importer uses — `GET /bigin/v1/<Module>` with a
 * `Zoho-oauthtoken`, `If-Modified-Since` (second resolution; `304` when nothing matched), `sort_by=
 * Modified_Time&sort_order=asc`, `page`/`per_page` and `{ data, info: { more_records } }`;
 * `/<Module>/deleted` and `/<Module>/actions/count`, for the modules the importer reads (`Tasks`, `Events`
 * and `Calls` too; an empty one answers no records). Nothing here is Zoho's code: it is the shape of its
 * answers, as the Python sync (`twenty-bigin-sync`) relied on them.
 */
export class FakeBigin {
    clientId = 'bigin-client-id';
    clientSecret = 'bigin-client-secret';
    refreshToken = 'bigin-refresh-token-1234';
    /** The self client's one-time grant code; spent by its exchange. */
    grantCode: string | null = '1000.grant-code-abcdef';
    readonly requests: FakeBiginRequest[] = [];
    /** The Deals `Stage` picklist the fields API answers; null refuses the read (the importer falls back). */
    dealStages: string[] | null = null;
    tokensIssued = 0;
    private readonly tokens = new Set<string>();
    private readonly tables = new Map<string, FakeBiginRecord[]>();
    private readonly deletions = new Map<string, { id: string; deleted_time: string }[]>();
    private failures: { status: number; left: number } | null = null;
    private server: Server | null = null;
    private base = '';
    private nextId = 5_725_767_000_000_000;

    async start(): Promise<this> {
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', (chunk: Buffer) => (body += chunk.toString()));
            req.on('end', () => {
                const url = new URL(req.url ?? '/', 'http://fake');
                const since = req.headers['if-modified-since'];
                this.requests.push({
                    method: req.method ?? 'GET',
                    path: url.pathname + url.search,
                    ifModifiedSince: typeof since === 'string' ? since : undefined,
                });
                const answer = this.answer(req.method ?? 'GET', url, req.headers.authorization, since, body);
                if (answer.body === undefined) res.writeHead(answer.status).end();
                else
                    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(
                        JSON.stringify(answer.body),
                    );
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        this.server = server;
        this.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        return this;
    }

    async close(): Promise<void> {
        const server = this.server;
        if (!server) return;
        this.server = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    /** Both of Zoho's hosts: the fake answers the token grant and the API on one port. */
    get url(): string {
        return this.base;
    }

    seed(module: string, records: readonly Record<string, unknown>[]): FakeBiginRecord[] {
        const table = this.tables.get(module) ?? [];
        const at = new Date().toISOString();
        const made = records.map((record) => ({
            Created_Time: at,
            Modified_Time: at,
            ...record,
            id: String(this.nextId++),
        })) as FakeBiginRecord[];
        table.push(...made);
        this.tables.set(module, table);
        return made;
    }

    /** Changes a record's fields and moves its `Modified_Time` forward. */
    update(module: string, id: string, patch: Record<string, unknown>, at = new Date().toISOString()): void {
        const row = this.tables.get(module)?.find((r) => r.id === id);
        if (!row) throw new Error(`no ${module} ${id}`);
        Object.assign(row, patch, { Modified_Time: at });
    }

    /** Lists `count` deletions of records never seen here, one second apart from `from`, oldest first. */
    seedDeletions(module: string, count: number, from: Date): void {
        const rows = Array.from({ length: count }, (_, i) => ({
            id: String(9_000_000_000_000 + i),
            deleted_time: new Date(from.getTime() + i * 1000).toISOString(),
        }));
        this.deletions.set(module, [...(this.deletions.get(module) ?? []), ...rows]);
    }

    /** Deletes a record: it leaves the module and is listed under `/deleted`. */
    remove(module: string, id: string): void {
        const table = this.tables.get(module) ?? [];
        this.tables.set(
            module,
            table.filter((r) => r.id !== id),
        );
        this.deletions.set(module, [
            ...(this.deletions.get(module) ?? []),
            { id, deleted_time: new Date().toISOString() },
        ]);
    }

    record(module: string, id: string): FakeBiginRecord {
        return this.tables.get(module)!.find((r) => r.id === id)!;
    }

    failNext(status: number, times: number): void {
        this.failures = { status, left: times };
    }

    private answer(
        method: string,
        url: URL,
        authorization: string | undefined,
        since: string | string[] | undefined,
        body: string,
    ): { status: number; body?: unknown } {
        if (method === 'POST' && url.pathname === '/oauth/v2/token') {
            const form = new URLSearchParams(body);
            // A self client's grant code, traded once for the refresh token (Zoho's authorization-code grant).
            if (form.get('grant_type') === 'authorization_code') {
                const ok =
                    form.get('client_id') === this.clientId &&
                    form.get('client_secret') === this.clientSecret &&
                    this.grantCode !== null &&
                    form.get('code') === this.grantCode;
                if (!ok) return { status: 200, body: { error: 'invalid_code' } };
                this.grantCode = null;
                return {
                    status: 200,
                    body: { refresh_token: this.refreshToken, access_token: 'unused', expires_in: 3600 },
                };
            }
            if (
                form.get('grant_type') !== 'refresh_token' ||
                form.get('client_id') !== this.clientId ||
                form.get('client_secret') !== this.clientSecret ||
                form.get('refresh_token') !== this.refreshToken
            ) {
                return { status: 200, body: { error: 'invalid_client' } };
            }
            const token = `access-${++this.tokensIssued}`;
            this.tokens.add(token);
            return { status: 200, body: { access_token: token, expires_in: 3600, token_type: 'Bearer' } };
        }
        if (this.failures && this.failures.left > 0) {
            this.failures.left -= 1;
            return { status: this.failures.status, body: { code: 'INTERNAL_ERROR', message: 'injected' } };
        }
        const token = authorization?.replace(/^Zoho-oauthtoken /, '');
        if (!token || !this.tokens.has(token)) {
            return { status: 401, body: { code: 'INVALID_TOKEN', message: 'invalid oauth token' } };
        }
        // Zoho's fields API: the Deals `Stage` picklist, or a refusal when the account will not say (`null`).
        if (url.pathname === '/bigin/v1/settings/fields' && url.searchParams.get('module') === 'Deals') {
            if (!this.dealStages) return { status: 403, body: { code: 'NO_PERMISSION', message: 'permission denied' } };
            return {
                status: 200,
                body: {
                    fields: [
                        { api_name: 'Deal_Name', data_type: 'text' },
                        {
                            api_name: 'Stage',
                            data_type: 'picklist',
                            pick_list_values: this.dealStages.map((v) => ({ display_value: v, actual_value: v })),
                        },
                    ],
                },
            };
        }
        const parsed = /^\/bigin\/(v1|v2)\/([A-Za-z]+)(\/deleted|\/actions\/count)?$/.exec(url.pathname);
        const v2 = parsed?.[1] === 'v2';
        // `match[1]` the module, `match[2]` what under it — the same shape for both versions.
        const match = parsed ? [parsed[0], parsed[2], parsed[3]] : null;
        if (!match || !['Accounts', 'Contacts', 'Deals', 'Notes', 'Tasks', 'Events', 'Calls'].includes(match[1]!)) {
            return {
                status: 400,
                body: { code: 'INVALID_MODULE', message: 'the module name given seems to be invalid' },
            };
        }
        const module = match[1]!;
        // v2 does not narrow by `If-Modified-Since` (BIGIN-1, production): only v1 and the deletions do.
        const after = typeof since === 'string' && !(v2 && !match[2]) ? new Date(since).getTime() : null;
        if (match[2] === '/actions/count')
            return { status: 200, body: { count: this.tables.get(module)?.length ?? 0 } };
        // v2 names its fields (Zoho refuses a list without them) and pages past 2,000 only by token.
        if (v2 && !match[2] && !url.searchParams.get('fields')) {
            return { status: 400, body: { code: 'REQUIRED_PARAM_MISSING', message: 'fields is required' } };
        }
        const pageToken = url.searchParams.get('page_token');
        const page = pageToken
            ? Number(Buffer.from(pageToken, 'base64url').toString('utf8'))
            : Number(url.searchParams.get('page') ?? '1');
        const perPage = Math.min(Number(url.searchParams.get('per_page') ?? PAGE_MAX), PAGE_MAX);
        if (!pageToken && page * perPage > 2000) {
            return {
                status: 400,
                body: { code: 'LIMIT_REACHED', message: 'page numbers reach 2000 records; use page_token' },
            };
        }
        const rows: Record<string, unknown>[] =
            match[2] === '/deleted'
                ? (this.deletions.get(module) ?? []).filter(
                      (d) => after === null || new Date(d.deleted_time).getTime() > after,
                  )
                : (this.tables.get(module) ?? [])
                      .filter((r) => after === null || new Date(r.Modified_Time).getTime() > after)
                      .sort((a, b) => a.Modified_Time.localeCompare(b.Modified_Time) || a.id.localeCompare(b.id));
        if (rows.length === 0 && after !== null) return { status: 304 };
        const slice = rows
            .slice((page - 1) * perPage, page * perPage)
            .map((row) => (module === 'Tasks' && !match[2] ? taskAsAsked(row, url.searchParams.get('fields')) : row));
        return {
            status: 200,
            body: {
                data: slice,
                info: {
                    page,
                    per_page: perPage,
                    count: slice.length,
                    more_records: page * perPage < rows.length,
                    ...(v2 && page * perPage < rows.length
                        ? { next_page_token: Buffer.from(String(page + 1)).toString('base64url') }
                        : {}),
                },
            },
        };
    }
}

/**
 * A task as Bigin lists it (production, 2026-10-29): its record (`Related_To`, `$related_module`) only when the
 * request names `What_Id`, its contact (`Who_Id`) only when it names `Who_Id` — a list without `fields` has no
 * link at all. Tasks are seeded in the shape Bigin answers when asked.
 */
function taskAsAsked(row: Record<string, unknown>, fields: string | null): Record<string, unknown> {
    const named = new Set((fields ?? '').split(','));
    const out = { ...row };
    if (!named.has('What_Id')) {
        delete out.Related_To;
        delete out.$related_module;
        delete out.What_Id;
    }
    if (!named.has('Who_Id')) delete out.Who_Id;
    return out;
}
