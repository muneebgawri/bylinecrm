import { BadRequestException } from '@nestjs/common';
import { type FilterGroup, type RecordObject, type ViewSort } from '@bylinecrm/shared';
import { filterGroupSchema } from './grammar';
import type { FieldDefinition } from '../records/custom-fields/custom-values';
import { compileFilter, type CompiledWhere } from './compile-filter';
import { resolveFields, type ResolvedField } from './fields';
import { type CompiledOrderBy, orderBy, parseSorts } from './sort';

/** What a list, an export or a group-by asks for, before it is resolved against the object. */
export interface QueryRequest {
    /** Inline filter, already parsed from JSON (the DTO decodes the query-string form). */
    filter?: FilterGroup | undefined;
    /** `field:asc,field2:desc`. */
    sort?: string | undefined;
    /** A saved view's filter and sorts apply as defaults; inline `filter`/`sort` override them. */
    view?: { filter: FilterGroup | null; sorts: ViewSort[] } | undefined;
}

/** The query as the service runs it: a `where` to spread into its own, and the order. */
export interface QueryPlan {
    fields: ResolvedField[];
    where: CompiledWhere;
    orderBy: CompiledOrderBy;
    sorts: ViewSort[];
}

/** The order a list takes when neither the request nor a view names one; a caller may name its own (the board: position). */
export const DEFAULT_SORT: ViewSort = { field: 'createdAt', direction: 'desc' };

/**
 * Resolves a request against the object's fields (standard + the workspace's custom ones) and
 * compiles it. Pure: the caller supplies the definitions it already has, so the records module
 * and the query module need nothing from each other at construction.
 */
export function planQuery(
    object: RecordObject,
    request: QueryRequest,
    definitions: readonly FieldDefinition[],
    defaultSort: ViewSort = DEFAULT_SORT,
): QueryPlan {
    const fields = resolveFields(object, definitions);
    const filter = request.filter ?? request.view?.filter ?? null;
    const sorts = request.sort !== undefined ? parseSorts(request.sort, fields) : (request.view?.sorts ?? []);
    return {
        fields,
        where: filter ? compileFilter(filter, fields) : {},
        orderBy: orderBy(sorts, fields, defaultSort),
        sorts,
    };
}

/**
 * A filter as it travels in a query string: base64url of its JSON. The body form (`POST …/query`)
 * carries the JSON directly; both land here. A filter that is not valid JSON or not the grammar's
 * shape is `400` with the reason.
 */
export function decodeFilterParam(raw: string): FilterGroup {
    let json: unknown;
    try {
        json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        throw new BadRequestException('filter is base64url-encoded JSON');
    }
    return parseFilter(json);
}

export function parseFilter(json: unknown): FilterGroup {
    const parsed = filterGroupSchema.safeParse(json);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BadRequestException(
            `filter: ${issue ? `${issue.path.join('.') || 'root'} ${issue.message}` : 'invalid'}`,
        );
    }
    return parsed.data;
}
