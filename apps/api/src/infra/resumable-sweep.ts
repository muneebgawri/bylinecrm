/**
 * A backstop sweep that examines every candidate eventually (#97).
 *
 * Each sweep (webhook deliveries, mail sends, sequence steps) looks for rows whose queue job was
 * lost. Reading only "the N oldest candidates" each pass starves: when the first N all have live
 * jobs, a lost row behind them is never reached. Instead a pass reads candidates in keyset order —
 * `(time, id)`, so rows with the same time are neither skipped nor read twice at a page boundary —
 * a page at a time, up to a cap per pass, and keeps where it stopped in a cursor store; the next
 * pass resumes there. A pass that reaches the end clears the cursor, so the next starts over.
 */

/** Where a pass stopped: the last row's ordering time (ISO) and id. */
export interface SweepPosition {
    at: string;
    id: string;
}

/** Holds each sweep's position between passes. */
export interface SweepCursorStore {
    get(name: string): Promise<SweepPosition | null>;
    set(name: string, position: SweepPosition | null): Promise<void>;
}

/** The commands the Redis-backed store uses. */
export interface SweepRedis {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
}

/** A cursor older than this is dropped: a sweep that has not run for a day starts over. */
export const SWEEP_CURSOR_TTL_SECONDS = 24 * 60 * 60;

/** Keeps each sweep's position in Redis, so it survives a worker restart and is shared by every worker. */
export class RedisSweepCursors implements SweepCursorStore {
    constructor(private readonly redis: SweepRedis) {}

    async get(name: string): Promise<SweepPosition | null> {
        const raw = await this.redis.get(key(name));
        return raw ? (JSON.parse(raw) as SweepPosition) : null;
    }

    async set(name: string, position: SweepPosition | null): Promise<void> {
        if (position) await this.redis.set(key(name), JSON.stringify(position), 'EX', SWEEP_CURSOR_TTL_SECONDS);
        else await this.redis.del(key(name));
    }
}

function key(name: string): string {
    return `bylinecrm:sweep-cursor:${name}`;
}

export interface ResumableSweepOptions<Row> {
    /** The sweep's cursor name, unique per sweep. */
    name: string;
    cursors: SweepCursorStore;
    /** Rows read per query. */
    pageSize: number;
    /** Rows examined per pass at most; the rest are reached by the next passes. */
    maxRowsPerPass: number;
    /** The candidates strictly after `after` in `(time, id)` order, at most `take`. */
    page: (after: SweepPosition | null, take: number) => Promise<Row[]>;
    position: (row: Row) => SweepPosition;
    visit: (row: Row) => Promise<void>;
}

/** One pass. `completed`: it reached the end (the cursor is cleared). */
export async function resumableSweep<Row>(
    options: ResumableSweepOptions<Row>,
): Promise<{ examined: number; completed: boolean }> {
    let after = await options.cursors.get(options.name);
    let examined = 0;
    for (;;) {
        const take = Math.min(options.pageSize, options.maxRowsPerPass - examined);
        const rows = await options.page(after, take);
        for (const row of rows) await options.visit(row);
        examined += rows.length;
        if (rows.length < take) {
            await options.cursors.set(options.name, null);
            return { examined, completed: true };
        }
        after = options.position(rows[rows.length - 1]!);
        if (examined >= options.maxRowsPerPass) {
            await options.cursors.set(options.name, after);
            return { examined, completed: false };
        }
    }
}

/** The Prisma `where` for "strictly after `position`" on a `(time, id)` keyset. */
export function keysetAfter<Field extends string>(
    field: Field,
    position: SweepPosition | null,
): Record<string, unknown> {
    if (!position) return {};
    const at = new Date(position.at);
    return { OR: [{ [field]: { gt: at } }, { [field]: at, id: { gt: position.id } }] };
}
