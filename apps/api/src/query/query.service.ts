import { Injectable } from '@nestjs/common';
import { type FilterGroup, type RecordObject, SEARCH_CANDIDATE_LIMIT, type ViewSort } from '@bylinecrm/shared';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { CustomFieldsService } from '../records/custom-fields/custom-fields.service';
import { recordWhere } from '../records/record-scope';
import { searchCandidates } from '../records/search';
import { loadView, withoutHiddenFields } from '../views/views.service';
import type { CompiledWhere } from './compile-filter';
import { type Group, groupRows } from './group-by';
import { decodeFilterParam, planQuery, type QueryPlan } from './plan';
import { SEARCHABLE_TABLE } from './search.service';

/** The query-string form of a list request, before the filter is decoded and the view loaded. */
export interface RawQuery {
    filter?: string | FilterGroup | undefined;
    sort?: string | undefined;
    view?: string | undefined;
    q?: string | undefined;
}

/**
 * Resolves a raw request into a plan inside the caller's transaction: the view (if named) is
 * loaded under the caller's sight, the filter decoded, the object's fields read — one path for
 * the lists, the export and the group-by, so they cannot disagree about what a request means.
 */
export async function resolvePlan(
    tx: WorkspaceClient,
    context: WorkspaceRunContext,
    customFields: CustomFieldsService,
    object: RecordObject,
    raw: RawQuery,
    defaultSort?: ViewSort,
): Promise<QueryPlan> {
    // A shared view may name an admin-only field the caller cannot see: it applies without it.
    const view = raw.view
        ? withoutHiddenFields(
              await loadView(tx, context, object, raw.view),
              await customFields.hiddenKeysWithin(tx, object),
          )
        : undefined;
    const filter = typeof raw.filter === 'string' ? decodeFilterParam(raw.filter) : raw.filter;
    const definitions = await customFields.visibleDefinitions(tx, object);
    return planQuery(
        object,
        { filter, sort: raw.sort, view: view ? { filter: view.filter, sorts: view.sorts } : undefined },
        definitions,
        defaultSort,
    );
}

/** What a list request selects: the plan, and the one `where` its page, total, export and bulk read. */
export interface ListScope {
    plan: QueryPlan;
    where: CompiledWhere;
    /** The text search matched nothing: `where` matches no row, and a reader may skip the query. */
    empty: boolean;
    /** The text search's candidates hit their cap, so the set may be larger than this `where` says. */
    candidatesCapped: boolean;
}

/**
 * The set a list request names, as one `where`: live rows or the trash, the caller's owner scope,
 * the planned filter, and the text search's candidates. Every reader of a list — its page and
 * total, the group-by, the export, a bulk action over a filter — takes its rows from here, so
 * none of them can disagree about which rows a request means.
 */
export async function listScope(
    tx: WorkspaceClient,
    context: WorkspaceRunContext,
    customFields: CustomFieldsService,
    object: RecordObject,
    raw: RawQuery,
    deleted: boolean,
    defaultSort?: ViewSort,
): Promise<ListScope> {
    const plan = await resolvePlan(tx, context, customFields, object, raw, defaultSort);
    const ids = raw.q ? await searchCandidates(tx, SEARCHABLE_TABLE[object], raw.q, deleted) : undefined;
    return {
        plan,
        where: {
            ...recordWhere(context, deleted),
            ...plan.where,
            ...(ids ? { id: { in: ids } } : {}),
        },
        empty: ids?.length === 0,
        candidatesCapped: ids?.length === SEARCH_CANDIDATE_LIMIT,
    };
}

@Injectable()
export class QueryService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
    ) {}

    /** Counts and sums per value of one field, over the same filtered, scoped set the list shows. */
    groupBy(object: RecordObject, raw: RawQuery & { field: string }): Promise<Group[]> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const scope = await listScope(tx, context, this.customFields, object, raw, false);
            if (scope.empty) return [];
            return groupRows(tx, object, scope.plan.fields, raw.field, scope.where);
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('QueryService is used inside a workspace scope');
        return context;
    }
}
