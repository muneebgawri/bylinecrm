import { CUSTOM_FIELD_KEY_PATTERN, type CustomFieldType, type RecordObject } from './records.js';

/**
 * Views, filters, sorting, grouping, export and search: the vocabulary the API and the web app
 * share (corpus doc 48 FR-CRMS-UI-1; parity ledger PAR-056…). One definition — the filter
 * compiler, the sort parser, the CSV writer, the view editor and the command palette all read
 * from here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fields: what a filter, a sort, a column or a group may name.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The kinds a field can be, which decide the operators it takes and how a value is checked.
 * `money` is an integer of minor units (the `Money` type's `amountMinor`); `uuid` names another
 * row (an owner, a company, a person).
 */
export const FIELD_KINDS = [
    'text',
    'number',
    'boolean',
    'date',
    'datetime',
    'select',
    'multiselect',
    'uuid',
    'money',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** A field as the filter, sort and export machinery sees it: its API name and what it holds. */
export type FieldDescriptor = {
    /** The name a client uses (`nameFirst`, `arr`, `custom.beat`). */
    name: string;
    label: string;
    kind: FieldKind;
    /** Whether a list may be ordered by it. Custom fields are not sortable in v1. */
    sortable: boolean;
    /** Whether a list may be grouped by it. */
    groupable: boolean;
    /** For `select`/`multiselect`: the allowed values. */
    options?: readonly string[] | undefined;
};

/**
 * The standard fields of each record object, in the order a default export lists them. The
 * name is the API's; the API maps it to a column in one place (`query/fields.ts`). A field not
 * here is not filterable, sortable, groupable or exportable — adding one is a change to the
 * contract, made here.
 */
export const STANDARD_FIELDS: Readonly<Record<RecordObject, readonly FieldDescriptor[]>> = {
    person: [
        { name: 'nameFirst', label: 'First name', kind: 'text', sortable: true, groupable: false },
        { name: 'nameLast', label: 'Last name', kind: 'text', sortable: true, groupable: false },
        { name: 'emailPrimary', label: 'Email', kind: 'text', sortable: false, groupable: false },
        { name: 'jobTitle', label: 'Job title', kind: 'text', sortable: true, groupable: true },
        { name: 'city', label: 'City', kind: 'text', sortable: false, groupable: true },
        { name: 'companyId', label: 'Company', kind: 'uuid', sortable: false, groupable: true },
        { name: 'ownerId', label: 'Owner', kind: 'uuid', sortable: false, groupable: true },
        { name: 'position', label: 'Position', kind: 'number', sortable: true, groupable: false },
        { name: 'createdAt', label: 'Created', kind: 'datetime', sortable: true, groupable: false },
        { name: 'updatedAt', label: 'Updated', kind: 'datetime', sortable: true, groupable: false },
    ],
    company: [
        { name: 'name', label: 'Name', kind: 'text', sortable: true, groupable: false },
        { name: 'domain', label: 'Domain', kind: 'text', sortable: true, groupable: false },
        { name: 'employeeCount', label: 'Employees', kind: 'number', sortable: true, groupable: false },
        { name: 'arr', label: 'ARR', kind: 'money', sortable: true, groupable: false },
        { name: 'icp', label: 'Ideal customer', kind: 'boolean', sortable: false, groupable: true },
        { name: 'ownerId', label: 'Owner', kind: 'uuid', sortable: false, groupable: true },
        { name: 'position', label: 'Position', kind: 'number', sortable: true, groupable: false },
        { name: 'createdAt', label: 'Created', kind: 'datetime', sortable: true, groupable: false },
        { name: 'updatedAt', label: 'Updated', kind: 'datetime', sortable: true, groupable: false },
    ],
    opportunity: [
        { name: 'name', label: 'Name', kind: 'text', sortable: true, groupable: false },
        { name: 'amount', label: 'Amount', kind: 'money', sortable: true, groupable: false },
        { name: 'currency', label: 'Currency', kind: 'text', sortable: false, groupable: true },
        { name: 'closeDate', label: 'Close date', kind: 'date', sortable: true, groupable: false },
        { name: 'probability', label: 'Probability', kind: 'number', sortable: true, groupable: false },
        { name: 'ownerId', label: 'Owner', kind: 'uuid', sortable: false, groupable: true },
        { name: 'pointOfContactId', label: 'Point of contact', kind: 'uuid', sortable: false, groupable: true },
        { name: 'companyId', label: 'Company', kind: 'uuid', sortable: false, groupable: true },
        { name: 'position', label: 'Position', kind: 'number', sortable: true, groupable: false },
        { name: 'createdAt', label: 'Created', kind: 'datetime', sortable: true, groupable: false },
        { name: 'updatedAt', label: 'Updated', kind: 'datetime', sortable: true, groupable: false },
    ],
};

/**
 * A record's own id, as a filter may name it: only to read or act on many records by id (a
 * selection's export, a page of names). It is not in `STANDARD_FIELDS` — a list never offers it
 * as a column, a sort or a group — but every object's filter, export and bulk route accepts it.
 */
export const ID_FIELD: FieldDescriptor = { name: 'id', label: 'ID', kind: 'uuid', sortable: false, groupable: false };

/** How many ids one `in`/`nin` on `id` may carry; more is `413`, never a silently shorter list. */
export const FILTER_MAX_IDS = 500;

/** The names a list of this object may be sorted by. */
export function sortableFieldNames(object: RecordObject): readonly string[] {
    return STANDARD_FIELDS[object].filter((f) => f.sortable).map((f) => f.name);
}

/** The prefix a custom field's name carries in a filter, sort, column or group. */
export const CUSTOM_FIELD_PREFIX = 'custom.';

/** A field name as a client may write it: a standard name, or `custom.<key>`. */
export const FIELD_NAME_PATTERN = /^(?:[a-zA-Z][a-zA-Z0-9]{0,63}|custom\.[a-z][a-z0-9_]{0,63})$/;

/** The kind a custom field's value is filtered as. */
export const CUSTOM_FIELD_KIND: Readonly<Record<CustomFieldType, FieldKind>> = {
    text: 'text',
    url: 'text',
    email: 'text',
    phone: 'text',
    number: 'number',
    boolean: 'boolean',
    date: 'date',
    datetime: 'datetime',
    select: 'select',
    multiselect: 'multiselect',
};

// ─────────────────────────────────────────────────────────────────────────────
// The filter grammar.
// ─────────────────────────────────────────────────────────────────────────────

export const FILTER_OPERATORS = [
    'eq',
    'neq',
    'in',
    'nin',
    'contains',
    'starts',
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'is_null',
    'not_null',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/**
 * Which operators a kind takes. One table: the grammar check, the compiler and the filter
 * editor's operator menu all read it. `contains` on a multiselect means "has this value".
 */
export const OPERATORS_BY_KIND: Readonly<Record<FieldKind, readonly FilterOperator[]>> = {
    text: ['eq', 'neq', 'in', 'nin', 'contains', 'starts', 'is_null', 'not_null'],
    number: ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'],
    money: ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'],
    boolean: ['eq', 'neq', 'is_null', 'not_null'],
    date: ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'],
    datetime: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'],
    select: ['eq', 'neq', 'in', 'nin', 'is_null', 'not_null'],
    multiselect: ['contains', 'in', 'is_null', 'not_null'],
    uuid: ['eq', 'neq', 'in', 'nin', 'is_null', 'not_null'],
};

/** How deep groups may nest, and how many conditions and groups a filter may hold in all. */
export const FILTER_MAX_DEPTH = 4;
export const FILTER_MAX_NODES = 50;
/** How many values an `in`/`nin` list may carry. */
export const FILTER_MAX_LIST = 100;

export type FilterCondition = {
    field: string;
    op: FilterOperator;
    /** Absent for `is_null`/`not_null`; a two-element array for `between`; an array for `in`/`nin`. */
    value?: unknown;
};
export type FilterGroup = { and: FilterNode[] } | { or: FilterNode[] };
export type FilterNode = FilterGroup | FilterCondition;

/**
 * The shape of a filter — groups of `and`/`or` over conditions — is checked by the API's zod
 * schema (`query/grammar.ts`, built from these types and constants); its structural limits by
 * `filterProblem` below; its semantics (does the field exist, may it take this operator, is the
 * value the right type) by the API against the object's fields. The shared package carries no
 * schema library: the web app's bundle budget is the reason, and the types are the contract.
 */

export function isFilterGroup(node: FilterNode): node is FilterGroup {
    return 'and' in node || 'or' in node;
}

/** The members of a group, whichever connective it uses. */
export function groupNodes(group: FilterGroup): FilterNode[] {
    return 'and' in group ? group.and : group.or;
}

/** How many values an `in`/`nin` on this field may carry: `FILTER_MAX_IDS` on `id`, else `FILTER_MAX_LIST`. */
export function filterListLimit(field: string): number {
    return field === ID_FIELD.name ? FILTER_MAX_IDS : FILTER_MAX_LIST;
}

/**
 * The structural problem with a filter, or `null`: deeper than `FILTER_MAX_DEPTH`, more than
 * `FILTER_MAX_NODES` conditions and groups, or a list longer than `filterListLimit` allows.
 */
export function filterProblem(group: FilterGroup): string | null {
    let nodes = 0;
    const walk = (node: FilterNode, depth: number): string | null => {
        nodes += 1;
        if (nodes > FILTER_MAX_NODES) return `a filter holds at most ${FILTER_MAX_NODES} conditions and groups`;
        if (isFilterGroup(node)) {
            if (depth > FILTER_MAX_DEPTH) return `groups nest at most ${FILTER_MAX_DEPTH} deep`;
            for (const child of groupNodes(node)) {
                const problem = walk(child, depth + 1);
                if (problem) return problem;
            }
            return null;
        }
        const limit = filterListLimit(node.field);
        if ((node.op === 'in' || node.op === 'nin') && Array.isArray(node.value) && node.value.length > limit) {
            return `${node.op} on ${node.field} takes at most ${limit} values`;
        }
        return null;
    };
    return walk(group, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sorts, columns, views.
// ─────────────────────────────────────────────────────────────────────────────

export type SortDirection = 'asc' | 'desc';
export type ViewSort = { field: string; direction: SortDirection };
/** A column of a table view: the field, its width in pixels, in the order the array gives. */
export type ViewColumn = { field: string; width?: number | undefined };

/** How many sort fields a list may order by. */
export const SORT_MAX_FIELDS = 3;
/** A view column's width in pixels: the narrowest and the widest the UI allows. */
export const VIEW_COLUMN_WIDTH_MIN = 40;
export const VIEW_COLUMN_WIDTH_MAX = 2000;

/** A saved view as the API returns it (PAR-056). */
export type SavedView = {
    id: string;
    object: RecordObject;
    name: string;
    icon: string | null;
    ownerMemberId: string | null;
    isShared: boolean;
    filter: FilterGroup | null;
    sorts: ViewSort[];
    columns: ViewColumn[];
    groupBy: string | null;
    position: number;
    createdAt: string;
    updatedAt: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Export and search.
// ─────────────────────────────────────────────────────────────────────────────

/** The most rows one CSV export may hold; a larger result is refused with `413`, never cut. */
export const EXPORT_MAX_ROWS = 100_000;
/** How many rows the export reads per page while streaming. */
export const EXPORT_PAGE_SIZE = 1000;

/**
 * A list's total: counted over the same filtered, scoped set as its page, up to this many rows.
 * Past it the list says `totalIsExact: false` and the total is the cap — counting a large table
 * exactly on every page view is work nobody reads ("10,000+").
 */
export const LIST_COUNT_CAP = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Bulk actions.
// ─────────────────────────────────────────────────────────────────────────────

/** What one bulk request may do to many records of one object. */
export const BULK_ACTIONS = ['assign_owner', 'delete', 'restore'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
/** The most records one bulk request may name or match; more is `413`. */
export const BULK_MAX_IDS = FILTER_MAX_IDS;
/** How many records one transaction of a bulk request changes. */
export const BULK_CHUNK_SIZE = 100;
/** Why one record of a bulk request was not changed. Not visible to the caller, in any workspace, reads the same. */
export const BULK_ROW_ERRORS = ['not_found'] as const;
export type BulkRowError = (typeof BULK_ROW_ERRORS)[number];
export type BulkRowResult = { id: string; ok: true } | { id: string; ok: false; error: BulkRowError };
export type BulkResult = { results: BulkRowResult[]; succeeded: number; failed: number };

/** Global search: results per object, default and ceiling. */
export const SEARCH_GROUP_LIMIT_DEFAULT = 5;
export const SEARCH_GROUP_LIMIT_MAX = 25;

/** One hit of the global search: enough to show and to open. */
export type SearchHit = {
    object: RecordObject;
    id: string;
    title: string;
    subtitle: string | null;
};
export type SearchResults = Record<RecordObject, SearchHit[]>;

/** A custom field's name in a filter, from its key. */
export function customFieldName(key: string): string {
    return `${CUSTOM_FIELD_PREFIX}${key}`;
}

/** The key a `custom.<key>` name refers to, or `null` for a standard name. */
export function customFieldKey(name: string): string | null {
    if (!name.startsWith(CUSTOM_FIELD_PREFIX)) return null;
    const key = name.slice(CUSTOM_FIELD_PREFIX.length);
    return CUSTOM_FIELD_KEY_PATTERN.test(key) ? key : null;
}
