import { fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';
import { createWebhookDispatcher } from '../webhooks/url-guard';
import { createHash } from 'node:crypto';
import { BIGIN_PAGE_SIZE, type BiginImportObject } from '@bylinecrm/shared';
import { assertNoOpenTransaction } from '../infra/transaction-scope';
import {
    BIGIN_HTTP_TIMEOUT_MS,
    BIGIN_REST_PATH,
    BIGIN_RETRY_ATTEMPTS,
    BIGIN_RETRY_BASE_MS,
    BIGIN_RETRY_CAP_MS,
    ZOHO_TOKEN_MARGIN_MS,
    ZOHO_TOKEN_PATH,
    BIGIN_REST_PATH_V2,
    BIGIN_FIELDS_MAX,
} from './bigin-import.constants';
import type {
    BiginApi,
    BiginConnection,
    BiginDeletedPage,
    BiginListOptions,
    BiginPage,
    BiginRecord,
} from './bigin.port';

/**
 * A Bigin request that failed for good or for now. `permanent` means no retry will help: Zoho refused
 * the credentials, or the module does not exist; the message is what the screen shows. It never
 * carries a secret: the client secret, refresh token and access token stay out of every message.
 */
export class BiginApiError extends Error {
    override readonly name = 'BiginApiError';
    constructor(
        readonly status: number,
        message: string,
        readonly permanent: boolean,
    ) {
        super(message);
    }
}

/** The message refused credentials get, wherever they are reported. */
export const BIGIN_CREDENTIALS_REFUSED = 'Zoho refused the Bigin credentials';

interface Clock {
    sleep(ms: number): Promise<void>;
    now(): number;
}

const realClock: Clock = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
};

/**
 * Bigin's REST API, as the importer reads it: an access token from Zoho's OAuth server (a refresh-token
 * grant, kept until shortly before it expires — Zoho limits how often a token may be refreshed), then
 * `GET <api>/bigin/v1/<Module>` with `If-Modified-Since`, `sort_by=Modified_Time&sort_order=asc` and
 * page numbers; `304`/`204` are an empty page. `/<Module>/deleted` lists deletions the same way. A
 * `401` refreshes the token once; a `429` or `5xx` is retried with a doubling wait. Never called inside
 * a tenant transaction (#86).
 */
export class BiginHttp implements BiginApi {
    private readonly clock: Clock;
    private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
    /** The v2 field list per connection and module. */
    private readonly fields = new Map<string, string[]>();

    /**
     * Every request goes through the webhook delivery client: its lookup refuses a private address at connect
     * time, so a host that passed the check on save but later resolves inward (a DNS change) is refused too.
     * Redirects are never followed — a redirect is an error, not a new destination (audit, #217).
     */
    private readonly dispatcher: Dispatcher;
    /** Tests stand in their own request function; production never passes one. */
    private readonly fetchImpl: ((url: string, init: RequestInit) => Promise<Response>) | undefined;

    constructor(
        clock: Partial<Clock> = {},
        options: { allowPrivate?: boolean; fetch?: (url: string, init: RequestInit) => Promise<Response> } = {},
    ) {
        this.clock = { ...realClock, ...clock };
        this.dispatcher = createWebhookDispatcher({ allowPrivate: options.allowPrivate ?? false });
        this.fetchImpl = options.fetch;
    }

    /** undici's `fetch` through the guarded client (the same undici as the dispatcher), refusing redirects. */
    private async send(url: string, init: RequestInit): Promise<Response> {
        if (this.fetchImpl) return this.fetchImpl(url, { ...init, redirect: 'error' });
        const guarded: UndiciRequestInit = {
            ...(init as unknown as UndiciRequestInit),
            redirect: 'error',
            dispatcher: this.dispatcher,
        };
        return (await undiciFetch(url, guarded)) as unknown as Response;
    }

    async list(connection: BiginConnection, module: BiginImportObject, options: BiginListOptions): Promise<BiginPage> {
        const fields = await this.fieldsOf(connection, module);
        const params = new URLSearchParams({
            fields: fields.join(','),
            per_page: String(BIGIN_PAGE_SIZE),
            sort_by: 'Modified_Time',
            sort_order: 'asc',
        });
        if (options.pageToken) params.set('page_token', options.pageToken);
        else params.set('page', String(options.page));
        const body = await this.get(connection, module, module, params, options.since, BIGIN_REST_PATH_V2);
        const next = body.info?.next_page_token;
        return {
            records: (Array.isArray(body.data) ? body.data : []).filter(
                (r): r is BiginRecord => typeof r === 'object' && r !== null && 'id' in r,
            ),
            moreRecords: body.info?.more_records === true,
            nextPageToken: typeof next === 'string' && next !== '' ? next : null,
        };
    }

    /**
     * The fields v2 is asked for: every field a v1 page of the module carries (v1 returns them all, custom
     * fields included), `id` and the timestamps first, at most `BIGIN_FIELDS_MAX`. Read once per module and
     * connection.
     */
    private async fieldsOf(connection: BiginConnection, module: BiginImportObject): Promise<string[]> {
        const key = `${tokenKey(connection)}:${module}`;
        const cached = this.fields.get(key);
        if (cached) return cached;
        const sample = await this.get(
            connection,
            module,
            module,
            new URLSearchParams({ per_page: String(BIGIN_PAGE_SIZE), page: '1' }),
            null,
        );
        const seen = new Set<string>(['id', 'Modified_Time', 'Created_Time']);
        for (const row of Array.isArray(sample.data) ? sample.data : []) {
            if (typeof row !== 'object' || row === null) continue;
            for (const name of Object.keys(row)) if (!name.startsWith('$')) seen.add(name);
        }
        const fields = [...seen].slice(0, BIGIN_FIELDS_MAX);
        this.fields.set(key, fields);
        return fields;
    }

    async deleted(
        connection: BiginConnection,
        module: BiginImportObject,
        options: BiginListOptions,
    ): Promise<BiginDeletedPage> {
        const params = new URLSearchParams({
            type: 'all',
            per_page: String(BIGIN_PAGE_SIZE),
            page: String(options.page),
        });
        const body = await this.get(connection, `${module}/deleted`, module, params, options.since);
        const rows = Array.isArray(body.data) ? body.data : [];
        return {
            records: rows
                .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
                .map((r) => ({
                    id: String(r.id ?? ''),
                    deletedTime: typeof r.deleted_time === 'string' ? r.deleted_time : null,
                }))
                .filter((r) => r.id !== ''),
            moreRecords: body.info?.more_records === true,
        };
    }

    async count(connection: BiginConnection, module: BiginImportObject): Promise<number | null> {
        try {
            const body = await this.get(connection, `${module}/actions/count`, module, new URLSearchParams(), null);
            const count = Number(body.count);
            return Number.isFinite(count) ? count : null;
        } catch (error) {
            if (error instanceof BiginApiError && error.message === BIGIN_CREDENTIALS_REFUSED) throw error;
            if (error instanceof BiginApiError && error.permanent) return null;
            throw error;
        }
    }

    private async get(
        connection: BiginConnection,
        path: string,
        module: string,
        params: URLSearchParams,
        since: string | null,
        restPath: string = BIGIN_REST_PATH,
    ): Promise<Answer> {
        assertNoOpenTransaction('Bigin read');
        const query = params.toString();
        const url = `${connection.apiUrl.replace(/\/+$/, '')}${restPath}/${path}${query ? `?${query}` : ''}`;
        let last: BiginApiError | null = null;
        let refreshed = false;
        for (let attempt = 1; attempt <= BIGIN_RETRY_ATTEMPTS; attempt++) {
            const token = await this.accessToken(connection);
            const headers: Record<string, string> = {
                authorization: `Zoho-oauthtoken ${token}`,
                accept: 'application/json',
            };
            if (since) headers['if-modified-since'] = new Date(since).toUTCString();
            let response: Response;
            try {
                response = await this.send(url, { headers, signal: AbortSignal.timeout(BIGIN_HTTP_TIMEOUT_MS) });
            } catch (error) {
                last = new BiginApiError(0, `Bigin did not answer: ${describe(error)}`, false);
                await this.clock.sleep(retryDelayMs(attempt));
                continue;
            }
            if (response.status === 304 || response.status === 204) return { data: [] };
            if (response.ok) return (await response.json()) as Answer;
            const text = await response.text().catch(() => '');
            if (response.status === 401 && !refreshed) {
                // The token expired early or was revoked: one fresh token, then the same request again.
                this.tokens.delete(tokenKey(connection));
                refreshed = true;
                attempt -= 1;
                continue;
            }
            if (response.status === 401 || response.status === 403) {
                throw new BiginApiError(response.status, BIGIN_CREDENTIALS_REFUSED, true);
            }
            if (response.status === 400 || response.status === 404) {
                throw new BiginApiError(response.status, `Bigin could not read "${module}": ${messageOf(text)}`, true);
            }
            last = new BiginApiError(response.status, `Bigin answered ${response.status}: ${messageOf(text)}`, false);
            if (response.status !== 429 && response.status < 500) throw last;
            await this.clock.sleep(retryDelayMs(attempt));
        }
        throw last ?? new BiginApiError(0, 'Bigin did not answer', false);
    }

    async exchangeGrantCode(
        client: { accountsUrl: string; clientId: string; clientSecret: string },
        code: string,
    ): Promise<string> {
        const url = `${client.accountsUrl.replace(/\/+$/, '')}${ZOHO_TOKEN_PATH}`;
        const form = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: client.clientId,
            client_secret: client.clientSecret,
            code,
        });
        let response: Response;
        try {
            response = await this.send(url, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: form.toString(),
                signal: AbortSignal.timeout(BIGIN_HTTP_TIMEOUT_MS),
            });
        } catch (error) {
            throw new BiginApiError(0, `Zoho's OAuth server did not answer: ${describe(error)}`, false);
        }
        const body = (await response.json().catch(() => ({}))) as { refresh_token?: unknown; error?: unknown };
        // A grant code is single-use and lives a few minutes; Zoho says so with `{ error: 'invalid_code' }`.
        if (typeof body.refresh_token !== 'string' || body.refresh_token === '') {
            const why = typeof body.error === 'string' ? body.error : `status ${response.status}`;
            throw new BiginApiError(
                response.status >= 500 ? response.status : 401,
                `Zoho refused the grant code (${why}): generate a new one and paste it within its few minutes`,
                true,
            );
        }
        return body.refresh_token;
    }

    /** A Zoho access token for the connection: the cached one while it has time left, else a fresh one. */
    private async accessToken(connection: BiginConnection): Promise<string> {
        const key = tokenKey(connection);
        const cached = this.tokens.get(key);
        if (cached && cached.expiresAt - ZOHO_TOKEN_MARGIN_MS > this.clock.now()) return cached.token;
        const url = `${connection.accountsUrl.replace(/\/+$/, '')}${ZOHO_TOKEN_PATH}`;
        const form = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: connection.clientId,
            client_secret: connection.clientSecret,
            refresh_token: connection.refreshToken,
        });
        let last: BiginApiError | null = null;
        for (let attempt = 1; attempt <= BIGIN_RETRY_ATTEMPTS; attempt++) {
            let response: Response;
            try {
                response = await this.send(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                    body: form.toString(),
                    signal: AbortSignal.timeout(BIGIN_HTTP_TIMEOUT_MS),
                });
            } catch (error) {
                last = new BiginApiError(0, `Zoho's OAuth server did not answer: ${describe(error)}`, false);
                await this.clock.sleep(retryDelayMs(attempt));
                continue;
            }
            if (response.status === 429 || response.status >= 500) {
                last = new BiginApiError(response.status, `Zoho's OAuth server answered ${response.status}`, false);
                await this.clock.sleep(retryDelayMs(attempt));
                continue;
            }
            const body = (await response.json().catch(() => ({}))) as {
                access_token?: unknown;
                expires_in?: unknown;
                error?: unknown;
            };
            // Zoho answers a refused grant with `200` and `{ error }` as often as with a 4xx.
            if (typeof body.access_token !== 'string' || body.access_token === '') {
                throw new BiginApiError(
                    response.status === 200 ? 401 : response.status,
                    BIGIN_CREDENTIALS_REFUSED,
                    true,
                );
            }
            const seconds = Number(body.expires_in);
            this.tokens.set(key, {
                token: body.access_token,
                expiresAt: this.clock.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000,
            });
            return body.access_token;
        }
        throw last ?? new BiginApiError(0, "Zoho's OAuth server did not answer", false);
    }
}

interface Answer {
    data?: unknown[];
    info?: { more_records?: boolean; next_page_token?: unknown };
    count?: unknown;
}

/** One cache entry per credential set; the refresh token is hashed, never held as a key. */
function tokenKey(connection: BiginConnection): string {
    const digest = createHash('sha256').update(connection.refreshToken).digest('hex');
    return `${connection.accountsUrl}|${connection.clientId}|${digest}`;
}

function messageOf(text: string): string {
    try {
        const parsed = JSON.parse(text) as { message?: unknown; code?: unknown };
        if (typeof parsed.message === 'string') return parsed.message;
        if (typeof parsed.code === 'string') return parsed.code;
    } catch {
        // Not JSON: the text itself says what happened.
    }
    return text.slice(0, 200) || 'no detail';
}

function retryDelayMs(attempt: number): number {
    return Math.min(BIGIN_RETRY_BASE_MS * 2 ** (attempt - 1), BIGIN_RETRY_CAP_MS);
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
