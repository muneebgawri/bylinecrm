import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A record as Twenty's REST API returns it: its id, timestamps, and whatever fields the object has. */
export type FakeTwentyRecord = Record<string, unknown> & {
    id: string;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
};

/** One request the fake saw, for the specs that assert how the importer reads. */
export interface FakeTwentyRequest {
    path: string;
    authorization: string | undefined;
}

const PAGE_MAX = 60;

/**
 * An in-process stand-in for a Twenty workspace's REST API (doc 48 §11): the read grammar the
 * importer uses — `GET /rest/<objects>` with a bearer key, `limit` (at most 60), cursor paging
 * with `starting_after`, `order_by`, `depth`, `filter=updatedAt[gte]:"<iso>"` and the deleted-records
 * filter `deletedAt[is]:NOT_NULL` (#184: deactivated members) — over records a
 * spec seeds, answered the way Twenty answers: `{ data: { <objects>: [...] }, pageInfo, totalCount }`,
 * `401` for a wrong key, `400` for an object it does not have. Nothing here is Twenty's code: it is
 * the shape of its answers, as the parity ledger records them (PAR-066).
 *
 * `failNext` makes the next requests fail with a status, for the retry specs.
 */
export class FakeTwenty {
    apiKey = 'twenty-test-key';
    readonly requests: FakeTwentyRequest[] = [];
    private readonly tables = new Map<string, FakeTwentyRecord[]>();
    private failures: { status: number; left: number } | null = null;
    private server: Server | null = null;
    private base = '';

    async start(): Promise<this> {
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://fake');
            this.requests.push({ path: url.pathname + url.search, authorization: req.headers.authorization });
            const answer = this.answer(url, req.headers.authorization);
            res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
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

    /** Where the importer is pointed: the workspace's base URL, without `/rest`. */
    get baseUrl(): string {
        if (!this.server) throw new Error('FakeTwenty.baseUrl read before start');
        return this.base;
    }

    /** Declares an object (so an empty one answers `[]`, not `400`) and adds records to it. */
    seed(objects: string, records: readonly Record<string, unknown>[]): FakeTwentyRecord[] {
        const table = this.tables.get(objects) ?? [];
        const added = records.map((r, i) => {
            const at = new Date(Date.UTC(2026, 0, 1, 0, 0, table.length + i)).toISOString();
            return {
                id: randomUUID(),
                createdAt: at,
                updatedAt: at,
                deletedAt: null,
                ...r,
            } as FakeTwentyRecord;
        });
        this.tables.set(objects, [...table, ...added]);
        return added;
    }

    /** Changes a record's fields and moves its `updatedAt` forward. */
    update(objects: string, id: string, patch: Record<string, unknown>, updatedAt = new Date().toISOString()): void {
        const table = this.tables.get(objects);
        const row = table?.find((r) => r.id === id);
        if (!row) throw new Error(`FakeTwenty: no ${objects} record ${id}`);
        Object.assign(row, patch, { updatedAt });
    }

    /** Deletes a record the way Twenty does: it is gone from every list (PAR-101), nothing says so. */
    remove(objects: string, id: string): void {
        this.update(objects, id, { deletedAt: new Date().toISOString() });
    }

    /** Puts a deleted record back. */
    restore(objects: string, id: string): void {
        this.update(objects, id, { deletedAt: null });
    }

    all(objects: string): FakeTwentyRecord[] {
        return [...(this.tables.get(objects) ?? [])];
    }

    /** The next `times` requests answer `status` with an empty body (a `429`, a `503`). */
    failNext(status: number, times: number): void {
        this.failures = { status, left: times };
    }

    /** Requests to `/rest/<objects>` so far. */
    reads(objects: string): FakeTwentyRequest[] {
        return this.requests.filter((r) => r.path.startsWith(`/rest/${objects}?`) || r.path === `/rest/${objects}`);
    }

    private answer(url: URL, authorization: string | undefined): { status: number; body: unknown } {
        if (this.failures && this.failures.left > 0) {
            this.failures.left -= 1;
            return { status: this.failures.status, body: { statusCode: this.failures.status, message: 'later' } };
        }
        if (authorization !== `Bearer ${this.apiKey}`) {
            return { status: 401, body: { statusCode: 401, message: 'Unauthorized', error: 'Unauthorized' } };
        }
        const match = /^\/rest\/([A-Za-z]+)$/.exec(url.pathname);
        const table = match ? this.tables.get(match[1]!) : undefined;
        if (!match || !table) {
            return {
                status: 400,
                body: { statusCode: 400, message: `object "${match?.[1] ?? url.pathname}" was not found` },
            };
        }
        const objects = match[1]!;
        const limit = Math.min(Number(url.searchParams.get('limit') ?? PAGE_MAX) || PAGE_MAX, PAGE_MAX);
        const after = url.searchParams.get('starting_after');
        const filter = url.searchParams.get('filter');
        const since = sinceOf(filter);
        const deleted = filter?.includes('deletedAt[is]:NOT_NULL') === true;
        const depth = Number(url.searchParams.get('depth') ?? '1');

        const live = table
            .filter((r) => (deleted ? r.deletedAt !== null : r.deletedAt === null) && (!since || r.updatedAt >= since))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const afterId = after ? Buffer.from(after, 'base64url').toString('utf8') : null;
        const start = afterId ? live.findIndex((r) => r.id === afterId) + 1 : 0;
        const page = live.slice(start, start + limit).map((r) => (depth === 0 ? withoutRelations(r) : r));
        const last = page[page.length - 1];
        return {
            status: 200,
            body: {
                data: { [objects]: page },
                pageInfo: {
                    hasNextPage: start + limit < live.length,
                    startCursor: page[0] ? cursorOf(page[0].id) : null,
                    endCursor: last ? cursorOf(last.id) : null,
                },
                totalCount: live.length,
            },
        };
    }
}

function cursorOf(id: string): string {
    return Buffer.from(id, 'utf8').toString('base64url');
}

/** `updatedAt[gte]:"<iso>"` (alone or inside `and(…)`) → the instant; any other filter is ignored by this fake. */
function sinceOf(filter: string | null): string | null {
    if (!filter) return null;
    const match = /updatedAt\[gte\]:"([^"]+)"/.exec(filter);
    return match ? match[1]! : null;
}

/** `depth=0`: a record without its one-to-many relations (the arrays). */
function withoutRelations(record: FakeTwentyRecord): FakeTwentyRecord {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) if (!Array.isArray(value)) out[key] = value;
    return out as FakeTwentyRecord;
}
