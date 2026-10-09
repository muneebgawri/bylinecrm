import { BadRequestException } from '@nestjs/common';
import { LIST_COUNT_CAP } from '@bylinecrm/shared';

/** One page of a list and the cursor that continues it, `null` on the last page. */
export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

/** A record list's total, counted over the same filtered, scoped set as its page (P1-4a). */
export interface Totals {
    total: number;
    totalIsExact: boolean;
}

/** A record list's page with its total. */
export type CountedPage<T> = Page<T> & Totals;

/** The page of a list that matched nothing. */
export const EMPTY_COUNTED_PAGE: CountedPage<never> = { items: [], nextCursor: null, total: 0, totalIsExact: true };

/**
 * The total of a list, from `count(take)` — a count of the same `where` the page reads, asked for
 * at most one row past `LIST_COUNT_CAP`. A count past the cap is the cap and not exact; so is any
 * count over a text search whose candidates were themselves capped (there may be more matches).
 */
export async function countTotal(count: (take: number) => Promise<number>, candidatesCapped: boolean): Promise<Totals> {
    const counted = await count(LIST_COUNT_CAP + 1);
    if (counted > LIST_COUNT_CAP) return { total: LIST_COUNT_CAP, totalIsExact: false };
    return { total: counted, totalIsExact: !candidatesCapped };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cursor is the last row's id, opaque to the client. */
export function encodeCursor(id: string): string {
    return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
    const id = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!UUID.test(id)) throw new BadRequestException('cursor is not valid');
    return id;
}

/** What a page fetch is given: continue after the cursor row, and take one more than the page. */
export interface PageArgs {
    cursor?: { id: string };
    skip?: number;
    take: number;
}

/**
 * Keyset pagination in Prisma's cursor mode: the fetch orders by the sort field with `id` as the
 * tie-break, continues after the cursor row, and takes one row more than the page so the next
 * cursor is known without a second query.
 */
export async function paginate<T extends { id: string }>(
    limit: number,
    cursor: string | undefined,
    fetch: (args: PageArgs) => Promise<T[]>,
): Promise<Page<T>> {
    const args: PageArgs = { take: limit + 1 };
    if (cursor !== undefined) {
        args.cursor = { id: decodeCursor(cursor) };
        args.skip = 1;
    }
    const rows = await fetch(args);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null };
}
