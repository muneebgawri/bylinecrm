import { SEARCH_CANDIDATE_LIMIT, phoneSearchDigits } from '@bylinecrm/shared';
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
    if (table === 'people') return peopleCandidates(tx, q, deleted);
    const { table: name, prefixColumn } = SEARCHABLE[table];
    const deletedClause = deleted ? Prisma.sql`"deleted_at" IS NOT NULL` : Prisma.sql`"deleted_at" IS NULL`;
    // A table with no prefix column matches on the vector alone; `FALSE` keeps one query shape.
    const prefixClause = prefixColumn ? Prisma.sql`${prefixColumn} LIKE ${likePrefix(q)}` : Prisma.sql`FALSE`;
    const words = prefixQuery(q);
    const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM ${name}
        WHERE ${deletedClause} AND ("search" @@ to_tsquery('simple', ${words}) OR ${prefixClause})
        ORDER BY ts_rank("search", to_tsquery('simple', ${words})) DESC, "id"
        LIMIT ${SEARCH_CANDIDATE_LIMIT}`;
    return rows.map((r) => r.id);
}

/**
 * People, at production size (#344). Row-level security lets only leakproof operators use an index, and neither `@@`
 * nor `LIKE` is one, so the old single query seq-scanned the workspace. The name/email/title vector, the primary
 * address and the additional addresses (`person_addresses`, trigger-kept, lower-case) are matched by `people_search`,
 * which runs as `bylinecrm_search` (past RLS, SELECT on those two tables only) with the transaction's workspace and
 * record scope in every branch's WHERE, so each branch uses its index and an own-scoped member's candidates are all
 * their own (migration 20261130090000). A phone number, primary or additional, however it was typed, has no index to use,
 * so it is matched here as before, only when the search holds digits. Best match first, then id, as one query had it.
 */
async function peopleCandidates(tx: WorkspaceClient, q: string, deleted: boolean): Promise<string[]> {
    const low = q.toLowerCase();
    const ranked = await tx.$queryRaw<{ id: string; rank: number }[]>`
        SELECT "id", "rank" FROM people_search(
            ${prefixQuery(q)}, ${low}, ${prefixUpperBound(low)}, ${likePrefix(q)}, ${deleted}, ${SEARCH_CANDIDATE_LIMIT}::int)`;
    const runs = phoneSearchDigits(q);
    if (!runs.length) return ranked.map((r) => r.id);
    // The runs are digits only, so they are safe in the regex; JSONB renders as text with a space after the colon.
    const deletedClause = deleted ? Prisma.sql`"deleted_at" IS NOT NULL` : Prisma.sql`"deleted_at" IS NULL`;
    const byPhone = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "people"
        WHERE ${deletedClause} AND "phones"::text ~ ${`"number":\\s*"[0-9]*(${runs.join('|')})`}
        ORDER BY "id" LIMIT ${SEARCH_CANDIDATE_LIMIT}`;
    return mergeRanked(
        ranked,
        byPhone.map((r) => r.id),
    );
}

/** Ranked hits plus unranked (rank 0) ones, best first then by id — uuid order is its lower-case hex text's order. */
export function mergeRanked(ranked: { id: string; rank: number }[], unranked: string[]): string[] {
    const rank = new Map(ranked.map((r) => [r.id, Number(r.rank)]));
    for (const id of unranked) if (!rank.has(id)) rank.set(id, 0);
    return [...rank.entries()]
        .sort(([a, ra], [b, rb]) => rb - ra || (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, SEARCH_CANDIDATE_LIMIT)
        .map(([id]) => id);
}

/** What was typed, lower-cased, as a LIKE prefix pattern with its wildcards escaped. */
function likePrefix(q: string): string {
    return `${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * The least string after every string that starts with `low`, in byte order (`~<~`): its last character's successor.
 * UTF-8 keeps code-point order, so this bounds the prefix exactly for `text_pattern_ops`.
 */
export function prefixUpperBound(low: string): string {
    const chars = [...low];
    const last = chars.pop()!.codePointAt(0)!;
    return chars.join('') + String.fromCodePoint(last + 1);
}

/**
 * Every word typed as a prefix, all required: "mat smi" finds Matt Smith while it is being typed.
 * Only letters and digits survive, so nothing typed can be read as tsquery syntax; an email is
 * found by the prefix column instead.
 */
export function prefixQuery(q: string): string {
    return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => `${word}:*`).join(' & ');
}
