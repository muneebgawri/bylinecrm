import { Injectable } from '@nestjs/common';
import type { FilterGroup, RecordObject, ViewSort } from '@bylinecrm/shared';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { CustomFieldsService } from '../records/custom-fields/custom-fields.service';
import { ownerWhere } from '../records/record-scope';
import { searchCandidates } from '../records/search';
import { loadView } from '../views/views.service';
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
    const view = raw.view ? await loadView(tx, context, object, raw.view) : undefined;
    const filter = typeof raw.filter === 'string' ? decodeFilterParam(raw.filter) : raw.filter;
    const definitions = await customFields.activeDefinitions(tx, object);
    return planQuery(
        object,
        { filter, sort: raw.sort, view: view ? { filter: view.filter, sorts: view.sorts } : undefined },
        definitions,
        defaultSort,
    );
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
            const plan = await resolvePlan(tx, context, this.customFields, object, raw);
            const ids = raw.q ? await searchCandidates(tx, SEARCHABLE_TABLE[object], raw.q, false) : undefined;
            const where = {
                deletedAt: null,
                ...ownerWhere(context),
                ...plan.where,
                ...(ids ? { id: { in: ids } } : {}),
            };
            return groupRows(tx, object, plan.fields, raw.field, where);
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('QueryService is used inside a workspace scope');
        return context;
    }
}
