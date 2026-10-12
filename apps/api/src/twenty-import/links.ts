import type { TwentyImportObject } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/** What a Twenty record maps to here. */
export type LocalType =
    'member' | 'company' | 'person' | 'opportunity' | 'note' | 'task' | 'exclusion' | 'view' | 'template';

export interface LinkRow {
    object: string;
    externalId: string;
    localType: LocalType;
    localId: string;
    label: string | null;
}

export interface LinkRef {
    object: TwentyImportObject;
    externalId: string;
}

/** Resolves a Twenty id to the local row it maps to; what the mappers read relations through. */
export interface LinkIndex {
    resolve(object: TwentyImportObject, externalId: unknown): string | null;
    /** The whole link, for a mapper that needs its label (a message list's name). */
    link(object: TwentyImportObject, externalId: unknown): LinkRow | null;
}

const key = (object: string, externalId: string) => `${object}:${externalId}`;

/** The links of `refs`, read in one query, as an index the mappers resolve through. */
export async function loadLinks(tx: WorkspaceClient, refs: readonly LinkRef[]): Promise<LinkIndex> {
    const byObject = new Map<string, string[]>();
    for (const ref of refs) byObject.set(ref.object, [...(byObject.get(ref.object) ?? []), ref.externalId]);
    const rows =
        byObject.size === 0
            ? []
            : await tx.twentyImportLink.findMany({
                  where: {
                      OR: [...byObject].map(([object, ids]) => ({ object, externalId: { in: [...new Set(ids)] } })),
                  },
              });
    const map = new Map<string, LinkRow>();
    for (const row of rows) {
        map.set(key(row.object, row.externalId), {
            object: row.object,
            externalId: row.externalId,
            localType: row.localType as LocalType,
            localId: row.localId,
            label: row.label,
        });
    }
    return {
        resolve: (object, externalId) =>
            typeof externalId === 'string' ? (map.get(key(object, externalId))?.localId ?? null) : null,
        link: (object, externalId) =>
            typeof externalId === 'string' ? (map.get(key(object, externalId)) ?? null) : null,
    };
}

/**
 * Records what a Twenty record became, or that it still is what it was. Returns whether the link
 * is new — what makes a first import "created" and a second "unchanged".
 */
export async function writeLink(
    tx: WorkspaceClient,
    workspaceId: string,
    link: LinkRow & { externalUpdatedAt: string | undefined },
): Promise<'created' | 'existing'> {
    const existing = await tx.twentyImportLink.findUnique({
        where: { workspaceId_object_externalId: { workspaceId, object: link.object, externalId: link.externalId } },
        select: { localId: true },
    });
    const data = {
        localType: link.localType,
        localId: link.localId,
        label: link.label,
        externalUpdatedAt: link.externalUpdatedAt ? new Date(link.externalUpdatedAt) : null,
        importedAt: new Date(),
    };
    if (existing) {
        await tx.twentyImportLink.update({
            where: { workspaceId_object_externalId: { workspaceId, object: link.object, externalId: link.externalId } },
            data,
        });
        return 'existing';
    }
    await tx.twentyImportLink.create({
        data: { workspaceId, object: link.object, externalId: link.externalId, ...data },
    });
    return 'created';
}

/** How many of one Twenty object's records are mapped to something here. */
export function countLinks(tx: WorkspaceClient, object: TwentyImportObject): Promise<number> {
    return tx.twentyImportLink.count({ where: { object } });
}
