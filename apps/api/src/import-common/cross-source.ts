import { plainBiginId, type BiginImportObject } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * Cross-source dedup (BIGIN-1, FR-CRMS-25). A record can reach BylineCRM from Bigin directly and from
 * Twenty, whose records migrated from Bigin carry Bigin's id in their `biginrecordid` field (with the
 * `zcrm_` prefix of Bigin's CSV export, or without it). Each importer looks the other's way before it
 * creates anything, so one Bigin record is one BylineCRM record whichever importer met it first:
 *
 * - the Bigin importer finds the record the Twenty importer made by its `biginrecordid` custom value;
 * - the Twenty importer finds the record the Bigin importer made by Bigin's link.
 */

/** The record types both importers write that carry a Bigin id. */
export type CrossSourceType = 'company' | 'person' | 'opportunity';

/** The Bigin module a record type is read from. */
export const BIGIN_MODULE_OF: Readonly<Record<CrossSourceType, BiginImportObject>> = {
    company: 'Accounts',
    person: 'Contacts',
    opportunity: 'Deals',
};

const TABLE: Readonly<Record<CrossSourceType, Prisma.Sql>> = {
    company: Prisma.sql`companies`,
    person: Prisma.sql`people`,
    opportunity: Prisma.sql`opportunities`,
};

/**
 * The live records of a type whose `biginrecordid` (a custom value the Twenty importer wrote) is one of
 * `biginIds`, by the bare Bigin id. One query for a page of ids; the partial expression index on
 * `custom->>'biginrecordid'` answers it.
 */
export async function localsByBiginRecordId(
    tx: WorkspaceClient,
    workspaceId: string,
    type: CrossSourceType,
    biginIds: readonly string[],
): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const wanted = [...new Set(biginIds.flatMap((id) => [id, `zcrm_${id}`]))];
    if (wanted.length === 0) return found;
    const rows = await tx.$queryRaw<{ id: string; bid: string }[]>`
        SELECT id::text AS id, custom->>'biginrecordid' AS bid
        FROM ${TABLE[type]}
        WHERE workspace_id = ${workspaceId}::uuid
          AND custom ? 'biginrecordid'
          AND custom->>'biginrecordid' = ANY(${wanted}::text[])
          AND deleted_at IS NULL
        ORDER BY created_at ASC`;
    for (const row of rows) {
        const id = plainBiginId(row.bid);
        if (id && !found.has(id)) found.set(id, row.id);
    }
    return found;
}

/**
 * The live record the Bigin importer linked a Bigin id to, for the Twenty importer: a Twenty record
 * whose `biginrecordid` names it is the same record, updated rather than made twice.
 */
export async function localLinkedFromBigin(
    tx: WorkspaceClient,
    type: CrossSourceType,
    biginRecordId: unknown,
): Promise<string | null> {
    const externalId = plainBiginId(biginRecordId);
    if (!externalId) return null;
    const link = await tx.biginImportLink.findFirst({
        where: { object: BIGIN_MODULE_OF[type], externalId, localType: type },
        select: { localId: true },
    });
    if (!link) return null;
    const where = { id: link.localId, deletedAt: null };
    const live =
        type === 'company'
            ? await tx.company.findFirst({ where, select: { id: true } })
            : type === 'person'
              ? await tx.person.findFirst({ where, select: { id: true } })
              : await tx.opportunity.findFirst({ where, select: { id: true } });
    return live?.id ?? null;
}
