import type { BiginImportObject } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { BiginLinkIndex } from './mappers';
import type { DealSnapshot } from './stage-map';

/** What a Bigin record maps to here. */
export type BiginLocalType = 'company' | 'person' | 'opportunity' | 'note' | 'task';

export interface BiginLinkRow {
    object: string;
    externalId: string;
    localType: BiginLocalType;
    localId: string;
    /** Contacts: what Bigin held when last read — what a reuse is detected against. */
    snapshot: { name: string; email: string | null } | null;
}

/** A reuse of a Bigin Contact (BIGIN-1), as the links resolve a record's contact by when it was made. */
interface ReuseRow {
    detectedAt: Date;
    previousPersonId: string;
    newPersonId: string;
}

const key = (object: string, externalId: string) => `${object}:${externalId}`;

/** The links of `refs`, read in one query, as an index the mappers resolve through. */
export async function loadBiginLinks(
    tx: WorkspaceClient,
    refs: readonly { object: BiginImportObject; id: string }[],
): Promise<BiginLinkIndex & { link(object: BiginImportObject, id: string): BiginLinkRow | null }> {
    const byObject = new Map<string, Set<string>>();
    for (const ref of refs) byObject.set(ref.object, (byObject.get(ref.object) ?? new Set()).add(ref.id));
    const rows =
        byObject.size === 0
            ? []
            : await tx.biginImportLink.findMany({
                  where: { OR: [...byObject].map(([object, ids]) => ({ object, externalId: { in: [...ids] } })) },
              });
    const map = new Map<string, BiginLinkRow>();
    for (const row of rows) {
        map.set(key(row.object, row.externalId), {
            object: row.object,
            externalId: row.externalId,
            localType: row.localType as BiginLocalType,
            localId: row.localId,
            snapshot: (row.snapshot as BiginLinkRow['snapshot']) ?? null,
        });
    }
    const contacts = [...(byObject.get('Contacts') ?? [])];
    const reuses = new Map<string, ReuseRow[]>();
    if (contacts.length > 0) {
        for (const row of await tx.biginContactReuse.findMany({
            where: { biginId: { in: contacts } },
            orderBy: { detectedAt: 'asc' },
        })) {
            reuses.set(row.biginId, [...(reuses.get(row.biginId) ?? []), row]);
        }
    }
    return {
        resolve: (object, id, at) => {
            if (typeof id !== 'string') return null;
            const current = map.get(key(object, id))?.localId ?? null;
            const history = object === 'Contacts' ? reuses.get(id) : undefined;
            if (!current || !history || !(at instanceof Date)) return current;
            // A record made before the Contact was reused belongs to the person it held then (BIGIN-1).
            const last = history.filter((r) => r.detectedAt <= at).at(-1);
            return last ? last.newPersonId : history[0]!.previousPersonId;
        },
        link: (object, id) => map.get(key(object, id)) ?? null,
    };
}

/**
 * Records what a Bigin record became, or that it still is what it was. Seen in Bigin just now, so a
 * "missing in source" flag from an earlier deletion is cleared (a record Bigin restored comes back).
 */
export async function writeBiginLink(
    tx: WorkspaceClient,
    workspaceId: string,
    link: Omit<BiginLinkRow, 'snapshot'> & {
        externalUpdatedAt: Date | null;
        /** Contacts: their identity; Deals: their raw Bigin stage (`DealSnapshot`). */
        snapshot?: BiginLinkRow['snapshot'] | DealSnapshot | undefined;
    },
): Promise<void> {
    const data = {
        localType: link.localType,
        localId: link.localId,
        ...(link.snapshot ? { snapshot: link.snapshot as Prisma.InputJsonValue } : {}),
        externalUpdatedAt: link.externalUpdatedAt,
        importedAt: new Date(),
        missingSince: null,
    };
    await tx.biginImportLink.upsert({
        where: { workspaceId_object_externalId: { workspaceId, object: link.object, externalId: link.externalId } },
        create: { workspaceId, object: link.object, externalId: link.externalId, ...data },
        update: data,
    });
}

export function countBiginLinks(tx: WorkspaceClient, object: BiginImportObject): Promise<number> {
    return tx.biginImportLink.count({ where: { object } });
}

/**
 * Bigin deleted these records: their links are flagged missing in source, for a person to review. Nothing
 * here is deleted, and the mirror is one way — BylineCRM never deletes because Bigin did. Returns how many
 * links this call flagged (one flagged already keeps its first instant).
 */
export async function flagBiginDeleted(
    tx: WorkspaceClient,
    object: BiginImportObject,
    deleted: readonly { id: string; at: Date }[],
): Promise<number> {
    let flagged = 0;
    for (const { id, at } of deleted) {
        const { count } = await tx.biginImportLink.updateMany({
            where: { object, externalId: id, missingSince: null },
            data: { missingSince: at },
        });
        flagged += count;
    }
    return flagged;
}
