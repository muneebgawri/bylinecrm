import { Injectable } from '@nestjs/common';
import { type Money, RECORD_OBJECTS, type RecordObject, type SearchHit, type SearchResults } from '@bylinecrm/shared';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { acrossOwnerScope } from '../records/record-scope';
import { searchCandidates, type SearchableTable } from '../records/search';
import { fetchRows, type RecordRow } from './rows';
import { MEMBER_SUMMARY_SELECT, memberSummaryOf, personName } from '../records/summaries';

/** The searchable table behind each object (the raw search names tables, the API names objects). */
export const SEARCHABLE_TABLE: Readonly<Record<RecordObject, SearchableTable>> = {
    person: 'people',
    company: 'companies',
    opportunity: 'opportunities',
};

/**
 * Global search (FR-CRMS-UI-4, the command palette): the same ranked candidates each list's
 * `?q=` uses, per object, cut to `limit` per object and shaped as something to show and open.
 * A caller who may not read an object gets no hits from it rather than an error.
 *
 * An own-scoped member searches past their owner scope (OWN-2, as adding a lead tells them): a
 * record someone else owns is listed by name and owner only, `canOpen` false, so they can see a
 * lead is taken before they chase it.
 */
@Injectable()
export class SearchService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    search(q: string, limit: number, objects: readonly RecordObject[]): Promise<SearchResults> {
        const context = this.current();
        return acrossOwnerScope(this.rls, this.context, context, async (tx) => {
            const results = Object.fromEntries(RECORD_OBJECTS.map((o) => [o, []])) as unknown as SearchResults;
            for (const object of objects) {
                results[object] = await hitsFor(tx, context.ownerScopeMemberId, object, q, limit);
            }
            return results;
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('SearchService is used inside a workspace scope');
        return context;
    }
}

async function hitsFor(
    tx: WorkspaceClient,
    /** The caller's owner scope, when they have one: what they may open. */
    scope: string | undefined,
    object: RecordObject,
    q: string,
    limit: number,
): Promise<SearchHit[]> {
    const ranked = await searchCandidates(tx, SEARCHABLE_TABLE[object], q, false);
    if (ranked.length === 0) return [];
    const rows = await fetchRows(tx, object, {
        where: { id: { in: ranked.slice(0, limit) }, deletedAt: null },
        orderBy: [{ id: 'asc' }],
        take: limit,
    });
    // The candidates came back best match first; the page fetch does not keep that order, so it is restored here.
    const rank = new Map(ranked.map((id, i) => [id, i] as const));
    rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const shown = rows.slice(0, limit);
    // The owners of every hit in one query, not one per row.
    const ownerIds = [...new Set(shown.map((row) => row.ownerId).filter((o): o is string => typeof o === 'string'))];
    const owners = new Map(
        ownerIds.length === 0
            ? []
            : (
                  await tx.workspaceMember.findMany({ where: { id: { in: ownerIds } }, select: MEMBER_SUMMARY_SELECT })
              ).map((m) => [m.id, memberSummaryOf(m)] as const),
    );
    return shown.map((row) => {
        const owner = (typeof row.ownerId === 'string' && owners.get(row.ownerId)) || null;
        const found = hit(object, row);
        // Outside the caller's scope: the name and the owner, nothing else of the record.
        return scope === undefined || row.ownerId === scope
            ? { ...found, owner, canOpen: true }
            : { ...found, subtitle: null, owner, canOpen: false };
    });
}

function hit(object: RecordObject, row: RecordRow): Omit<SearchHit, 'owner' | 'canOpen'> {
    switch (object) {
        case 'person': {
            const emails = row.emails as { primary: string | null } | null;
            const name = personName(String(row.nameFirst ?? ''), String(row.nameLast ?? ''), emails?.primary);
            return {
                object,
                id: row.id,
                title: name || row.id,
                subtitle: (row.jobTitle as string | null) ?? emails?.primary ?? null,
            };
        }
        case 'company':
            return { object, id: row.id, title: String(row.name), subtitle: (row.domain as string | null) ?? null };
        case 'opportunity': {
            const amount: Money | null =
                row.amountMinor == null
                    ? null
                    : { amountMinor: Number(row.amountMinor), currency: String(row.currency) };
            return {
                object,
                id: row.id,
                title: String(row.name),
                subtitle: amount ? `${amount.amountMinor} ${amount.currency} (minor units)` : null,
            };
        }
    }
}
