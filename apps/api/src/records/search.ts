import { SEARCH_CANDIDATE_LIMIT } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * The two searchable tables, each with the column a prefix match runs on beside the vector.
 * Identifiers are taken from this map, never from input, so `Prisma.raw` is safe here.
 */
const SEARCHABLE = {
    people: { table: Prisma.raw('"people"'), prefixColumn: Prisma.raw('"email_primary"') },
    companies: { table: Prisma.raw('"companies"'), prefixColumn: Prisma.raw('"domain"') },
    opportunities: { table: Prisma.raw('"opportunities"'), prefixColumn: null },
} as const;
export type SearchableTable = keyof typeof SEARCHABLE;

/**
 * The ids a text search matches, best match first, capped at `SEARCH_CANDIDATE_LIMIT`. The
 * caller folds them into its ordinary query (`id IN …`), so sort and cursor work the same with
 * or without `q`. Runs in the caller's transaction: the row-level policies apply to it exactly as
 * to any other query.
 */
export async function searchCandidates(
    tx: WorkspaceClient,
    table: SearchableTable,
    q: string,
    deleted: boolean,
): Promise<string[]> {
    const { table: name, prefixColumn } = SEARCHABLE[table];
    const deletedClause = deleted ? Prisma.sql`"deleted_at" IS NOT NULL` : Prisma.sql`"deleted_at" IS NULL`;
    const prefix = `${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    // A table with no prefix column matches on the vector alone; `FALSE` keeps one query shape.
    const prefixClause = prefixColumn ? Prisma.sql`${prefixColumn} LIKE ${prefix}` : Prisma.sql`FALSE`;
    const words = prefixQuery(q);
    const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM ${name}
        WHERE ${deletedClause}
          AND ("search" @@ to_tsquery('simple', ${words}) OR ${prefixClause})
        ORDER BY ts_rank("search", to_tsquery('simple', ${words})) DESC, "id"
        LIMIT ${SEARCH_CANDIDATE_LIMIT}`;
    return rows.map((r) => r.id);
}

/**
 * Every word typed as a prefix, all required: "mat smi" finds Matt Smith while it is being typed.
 * Only letters and digits survive, so nothing typed can be read as tsquery syntax; an email is
 * found by the prefix column instead.
 */
export function prefixQuery(q: string): string {
    return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => `${word}:*`).join(' & ');
}
