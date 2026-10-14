import { TWENTY_PAGE_SIZE } from '@bylinecrm/shared';
import { assertNoOpenTransaction } from '../infra/transaction-scope';
import {
    TWENTY_HTTP_TIMEOUT_MS,
    TWENTY_REST_PATH,
    TWENTY_RETRY_ATTEMPTS,
    TWENTY_RETRY_BASE_MS,
    TWENTY_RETRY_CAP_MS,
} from './twenty-import.constants';
import type { TwentyApi, TwentyConnection, TwentyListOptions, TwentyPage, TwentyRecord } from './twenty.port';

/**
 * A Twenty request that failed for good or for now. `permanent` means no retry will help: the key
 * was refused (`401`/`403`), the object does not exist (`400`/`404`); the message is what the
 * screen shows. Anything else was retried and still failed.
 */
export class TwentyApiError extends Error {
    override readonly name = 'TwentyApiError';
    constructor(
        readonly status: number,
        message: string,
        readonly permanent: boolean,
    ) {
        super(message);
    }
}

/** The message a refused key gets, wherever it is reported. */
export const TWENTY_KEY_REFUSED = 'Twenty refused the API key';

interface Clock {
    sleep(ms: number): Promise<void>;
}

const realClock: Clock = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/**
 * Twenty's REST read grammar (PAR-066): `GET <base>/rest/<objects>` with a bearer key, `limit` (60
 * at most), `depth`, `order_by` and cursor paging with `starting_after`; the answer is
 * `{ data: { <objects>: [...] }, pageInfo: { hasNextPage, endCursor }, totalCount }`. Records are
 * read in id order, so a run that resumes from a cursor sees every record once whatever Twenty
 * does to positions meanwhile. A `429` or a `5xx` is retried with a doubling wait; a refused key
 * or an unknown object is final. Never called inside a tenant transaction (#86): a page is read,
 * then written in a transaction of its own.
 */
export class TwentyHttp implements TwentyApi {
    private readonly clock: Clock;

    constructor(clock: Partial<Clock> = {}) {
        this.clock = { ...realClock, ...clock };
    }

    async list(connection: TwentyConnection, objects: string, options: TwentyListOptions): Promise<TwentyPage> {
        const params = new URLSearchParams({
            limit: String(TWENTY_PAGE_SIZE),
            depth: String(options.depth),
            order_by: 'id[AscNullsFirst]',
        });
        if (options.cursor) params.set('starting_after', options.cursor);
        const filters: string[] = [];
        if (options.since) filters.push(`updatedAt[gte]:"${options.since}"`);
        if (options.deleted) filters.push('deletedAt[is]:NOT_NULL');
        if (filters.length > 0) params.set('filter', filters.length === 1 ? filters[0]! : `and(${filters.join(',')})`);
        const body = await this.get(connection, objects, params);
        return {
            records: recordsOf(body, objects),
            endCursor: body.pageInfo?.endCursor ?? null,
            hasNextPage: body.pageInfo?.hasNextPage === true,
            totalCount: totalOf(body),
        };
    }

    async count(connection: TwentyConnection, objects: string): Promise<number> {
        const body = await this.get(connection, objects, new URLSearchParams({ limit: '1', depth: '0' }));
        return totalOf(body);
    }

    private async get(connection: TwentyConnection, objects: string, params: URLSearchParams): Promise<Answer> {
        assertNoOpenTransaction('Twenty read');
        const url = `${connection.baseUrl.replace(/\/+$/, '')}${TWENTY_REST_PATH}/${objects}?${params.toString()}`;
        let last: TwentyApiError | null = null;
        for (let attempt = 1; attempt <= TWENTY_RETRY_ATTEMPTS; attempt++) {
            let response: Response;
            try {
                response = await fetch(url, {
                    headers: { authorization: `Bearer ${connection.apiKey}`, accept: 'application/json' },
                    signal: AbortSignal.timeout(TWENTY_HTTP_TIMEOUT_MS),
                });
            } catch (error) {
                last = new TwentyApiError(0, `Twenty did not answer: ${describe(error)}`, false);
                await this.clock.sleep(retryDelayMs(attempt));
                continue;
            }
            if (response.ok) return (await response.json()) as Answer;
            const text = await response.text().catch(() => '');
            if (response.status === 401 || response.status === 403) {
                throw new TwentyApiError(response.status, TWENTY_KEY_REFUSED, true);
            }
            if (response.status === 400 || response.status === 404) {
                throw new TwentyApiError(
                    response.status,
                    `Twenty has no "${objects}" object: ${messageOf(text)}`,
                    true,
                );
            }
            last = new TwentyApiError(response.status, `Twenty answered ${response.status}: ${messageOf(text)}`, false);
            if (response.status !== 429 && response.status < 500) throw last;
            await this.clock.sleep(retryDelayMs(attempt));
        }
        throw last ?? new TwentyApiError(0, 'Twenty did not answer', false);
    }
}

interface Answer {
    data?: Record<string, unknown>;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    totalCount?: number | string;
}

/** The page's records: under the object's plural name, or whatever one array `data` holds. */
function recordsOf(body: Answer, objects: string): TwentyRecord[] {
    const data = body.data ?? {};
    const named = data[objects];
    if (Array.isArray(named)) return named as TwentyRecord[];
    const first = Object.values(data).find((value) => Array.isArray(value));
    return (first as TwentyRecord[] | undefined) ?? [];
}

function totalOf(body: Answer): number {
    const total = Number(body.totalCount ?? 0);
    return Number.isFinite(total) ? total : 0;
}

function messageOf(text: string): string {
    try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === 'string') return parsed.message;
        if (Array.isArray(parsed.message)) return parsed.message.join('; ');
    } catch {
        // Not JSON: the text itself says what happened.
    }
    return text.slice(0, 200) || 'no detail';
}

function retryDelayMs(attempt: number): number {
    return Math.min(TWENTY_RETRY_BASE_MS * 2 ** (attempt - 1), TWENTY_RETRY_CAP_MS);
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
