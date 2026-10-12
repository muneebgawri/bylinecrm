import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insideTransaction, TransactionAcrossNetworkError } from '../infra/transaction-scope';
import { FakeTwenty } from '../../test/support/fake-twenty';
import { TwentyApiError, TwentyHttp } from './twenty.http';

/**
 * The HTTP adapter against the fake Twenty server: the read grammar (PAR-066), paging through every
 * record, retries on the answers Twenty gives when busy, no retry on a refused key, and never from
 * inside a tenant transaction (#86).
 */
describe('P4-4 (doc 48 §11): reading a Twenty workspace through its REST API', () => {
    const twenty = new FakeTwenty();
    const noWait = { sleep: () => Promise.resolve() };
    let http: TwentyHttp;
    const connection = () => ({ baseUrl: twenty.baseUrl, apiKey: twenty.apiKey });

    beforeAll(async () => {
        await twenty.start();
        twenty.seed(
            'companies',
            Array.from({ length: 130 }, (_, i) => ({ name: `Company ${i}` })),
        );
        twenty.seed('people', []);
        http = new TwentyHttp(noWait);
    });
    afterAll(() => twenty.close());

    it('pages with the bearer key, at most 60 a page, following the end cursor until there is no next page', async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        let total = 0;
        for (;;) {
            const page = await http.list(connection(), 'companies', { cursor, depth: 0 });
            total = page.totalCount;
            seen.push(...page.records.map((r) => r.id));
            if (!page.hasNextPage) break;
            cursor = page.endCursor;
        }
        expect(total).toBe(130);
        expect(new Set(seen).size).toBe(130);
        const reads = twenty.reads('companies');
        expect(reads).toHaveLength(3);
        expect(reads.every((r) => r.authorization === `Bearer ${twenty.apiKey}`)).toBe(true);
        expect(reads[0]!.path).toContain('limit=60');
        expect(reads[0]!.path).toContain('depth=0');
        expect(reads[1]!.path).toContain('starting_after=');
    });

    it('counts without reading: one record asked for, the total taken from the answer', async () => {
        expect(await http.count(connection(), 'companies')).toBe(130);
        expect(await http.count(connection(), 'people')).toBe(0);
        expect(twenty.reads('people').at(-1)!.path).toContain('limit=1');
    });

    it('a changes read asks Twenty for what was updated since the instant, as its filter grammar', async () => {
        const since = '2026-01-01T00:01:00.000Z';
        const page = await http.list(connection(), 'companies', { cursor: null, depth: 0, since });
        expect(page.totalCount).toBe(70);
        expect(decodeURIComponent(twenty.reads('companies').at(-1)!.path)).toContain(
            `filter=updatedAt[gte]:"${since}"`,
        );
    });

    it('a busy answer (429, 5xx) is retried with a wait; the record is read once it answers', async () => {
        twenty.failNext(429, 2);
        const page = await http.list(connection(), 'people', { cursor: null, depth: 0 });
        expect(page.records).toEqual([]);
    });

    it('a refused key is final: no retry, and the error says so for the screen', async () => {
        await expect(
            http.list({ baseUrl: twenty.baseUrl, apiKey: 'wrong' }, 'people', { cursor: null, depth: 0 }),
        ).rejects.toMatchObject({
            name: 'TwentyApiError',
            status: 401,
            permanent: true,
        });
        expect(twenty.requests.filter((r) => r.authorization === 'Bearer wrong')).toHaveLength(1);
    });

    it('an object Twenty does not have is final too', async () => {
        const error = await http.list(connection(), 'dragons', { cursor: null, depth: 0 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TwentyApiError);
        expect((error as TwentyApiError).permanent).toBe(true);
    });

    it('is never called inside a tenant transaction (#86)', async () => {
        await expect(
            insideTransaction([], () => http.list(connection(), 'people', { cursor: null, depth: 0 })),
        ).rejects.toBeInstanceOf(TransactionAcrossNetworkError);
    });
});
