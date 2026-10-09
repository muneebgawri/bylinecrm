import { BadRequestException } from '@nestjs/common';

/** A sort over one field of the per-object allowlist. */
export interface SortSpec<F extends string> {
    field: F;
    direction: 'asc' | 'desc';
}

/** One page of a list and the cursor that continues it, `null` on the last page. */
export interface Page<T> {
    items: T[];
    nextCursor: string | null;
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

/** Parses `field:asc|desc` against the object's allowlist; anything else is a `400`. */
export function parseSort<F extends string>(
    raw: string | undefined,
    allowed: readonly F[],
    fallback: SortSpec<F>,
): SortSpec<F> {
    if (raw === undefined) return fallback;
    const [field, direction] = raw.split(':');
    if (!field || !(allowed as readonly string[]).includes(field) || (direction !== 'asc' && direction !== 'desc')) {
        throw new BadRequestException(`sort must be one of ${allowed.join(', ')} followed by :asc or :desc`);
    }
    return { field: field as F, direction };
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
