import {
    CUSTOM_FIELD_KIND,
    customFieldName,
    FILTER_MAX_DEPTH,
    filterProblem,
    groupNodes,
    isFilterGroup,
    OPERATORS_BY_KIND,
    STANDARD_FIELDS,
    type FieldDescriptor,
    type FieldKind,
    type FilterCondition,
    type FilterGroup,
    type FilterNode,
    type FilterOperator,
    type RecordObject,
} from '@bylinecrm/shared';
import type { CustomFieldView } from '../api/types';

/**
 * The filter builder's model: the editable tree a person builds, and the one conversion from it
 * to the P1-4 grammar the API reads. Pure — the builder component renders it, the tests check
 * it. Every vocabulary here (fields, kinds, which operators a kind takes) is the shared one;
 * nothing is re-declared.
 */

/** The fields of an object a filter may name: its standard fields, then its live custom fields. */
export function filterableFields(object: RecordObject, customFields: readonly CustomFieldView[]): FieldDescriptor[] {
    const custom = customFields
        .filter((f) => f.object === object && f.archivedAt === null)
        .sort((a, b) => a.position - b.position)
        .map<FieldDescriptor>((f) => ({
            name: customFieldName(f.key),
            label: f.label,
            kind: CUSTOM_FIELD_KIND[f.type],
            sortable: false,
            groupable: false,
            options: f.options.length ? f.options : undefined,
        }));
    return [...STANDARD_FIELDS[object], ...custom];
}

/** How each operator reads in the builder's menu. */
export const OPERATOR_LABELS: Readonly<Record<FilterOperator, string>> = {
    eq: 'is',
    neq: 'is not',
    in: 'is any of',
    nin: 'is none of',
    contains: 'contains',
    starts: 'starts with',
    gt: 'is greater than',
    gte: 'is at least',
    lt: 'is less than',
    lte: 'is at most',
    between: 'is between',
    is_null: 'is empty',
    not_null: 'is not empty',
};

/** Date-like kinds read "before / after" rather than "less / greater than". */
const DATE_LABELS: Partial<Record<FilterOperator, string>> = {
    gt: 'is after',
    gte: 'is on or after',
    lt: 'is before',
    lte: 'is on or before',
};

export function operatorLabel(kind: FieldKind, op: FilterOperator): string {
    return (kind === 'date' || kind === 'datetime' ? DATE_LABELS[op] : undefined) ?? OPERATOR_LABELS[op];
}

/** What a condition's value is for an operator: nothing, one value, a list, or a pair. */
export type ValueShape = 'none' | 'one' | 'list' | 'pair';

export function valueShape(op: FilterOperator): ValueShape {
    if (op === 'is_null' || op === 'not_null') return 'none';
    if (op === 'in' || op === 'nin') return 'list';
    if (op === 'between') return 'pair';
    return 'one';
}

/** The operator a new condition on a field of this kind starts with: the one people reach for. */
export function defaultOperator(kind: FieldKind): FilterOperator {
    const preferred: Record<FieldKind, FilterOperator> = {
        text: 'contains',
        number: 'eq',
        money: 'gte',
        boolean: 'eq',
        date: 'gte',
        datetime: 'gte',
        select: 'eq',
        multiselect: 'contains',
        uuid: 'eq',
    };
    return preferred[kind];
}

// ─────────────────────────────────────────────────────────────────────────────
// The editable tree.
// ─────────────────────────────────────────────────────────────────────────────

export interface DraftCondition {
    id: string;
    field: string;
    op: FilterOperator;
    /** Typed already (a number for a number field, minor units for money): inputs convert. */
    value?: unknown;
}

export interface DraftGroup {
    id: string;
    connective: 'and' | 'or';
    children: DraftNode[];
}

export type DraftNode = DraftCondition | DraftGroup;

export function isDraftGroup(node: DraftNode): node is DraftGroup {
    return 'children' in node;
}

let sequence = 0;
/** A local id for a row of the builder; never sent to the API. */
export function draftId(): string {
    sequence += 1;
    return `d${sequence}`;
}

export function emptyGroup(connective: 'and' | 'or' = 'and'): DraftGroup {
    return { id: draftId(), connective, children: [] };
}

export function newCondition(field: FieldDescriptor): DraftCondition {
    return { id: draftId(), field: field.name, op: defaultOperator(field.kind) };
}

/** Whether a group may hold another group without passing the grammar's depth limit. */
export function canNest(depth: number): boolean {
    return depth < FILTER_MAX_DEPTH;
}

/** A condition is sent only when it says something: the right shape of value for its operator. */
export function isComplete(condition: DraftCondition): boolean {
    const shape = valueShape(condition.op);
    const v = condition.value;
    if (shape === 'none') return true;
    if (shape === 'list') return Array.isArray(v) && v.length > 0 && v.every(present);
    if (shape === 'pair') return Array.isArray(v) && v.length === 2 && v.every(present);
    return present(v);
}

function present(value: unknown): boolean {
    return value !== undefined && value !== null && value !== '' && !(typeof value === 'number' && Number.isNaN(value));
}

/**
 * The grammar the API reads, from the tree: incomplete conditions and groups left empty by them
 * are dropped (a half-typed row does not narrow the list), a group of one keeps its connective.
 * `null` when nothing is left — the list is unfiltered.
 */
export function toFilter(group: DraftGroup): FilterGroup | null {
    const nodes = group.children.flatMap<FilterNode>((child) => {
        if (isDraftGroup(child)) {
            const inner = toFilter(child);
            return inner ? [inner] : [];
        }
        if (!isComplete(child)) return [];
        const condition: FilterCondition = { field: child.field, op: child.op };
        if (valueShape(child.op) !== 'none') condition.value = child.value;
        return [condition];
    });
    if (nodes.length === 0) return null;
    return group.connective === 'and' ? { and: nodes } : { or: nodes };
}

/** The tree for editing a filter that came from a saved view or the URL. */
export function fromFilter(filter: FilterGroup | null): DraftGroup {
    if (!filter) return emptyGroup();
    const connective = 'and' in filter ? 'and' : 'or';
    return {
        id: draftId(),
        connective,
        children: groupNodes(filter).map<DraftNode>((node) =>
            isFilterGroup(node)
                ? fromFilter(node)
                : { id: draftId(), field: node.field, op: node.op, value: node.value },
        ),
    };
}

/** The grammar's structural limit the tree would break, or `null` — checked before it is sent. */
export function draftProblem(group: DraftGroup): string | null {
    const filter = toFilter(group);
    return filter ? filterProblem(filter) : null;
}

/** How many conditions a filter holds, for the "Filter · 3" button label. */
export function conditionCount(filter: FilterGroup | null): number {
    if (!filter) return 0;
    return groupNodes(filter).reduce((sum, node) => sum + (isFilterGroup(node) ? conditionCount(node) : 1), 0);
}

/** The operators a field takes, in the shared order. */
export function operatorsFor(field: FieldDescriptor): readonly FilterOperator[] {
    return OPERATORS_BY_KIND[field.kind];
}

/**
 * A typed scalar from what a person typed into an input for this kind; `undefined` when it is not
 * a value of the kind yet. Money is not handled here — its input carries a currency and converts
 * through `lib/money.ts`.
 */
export function parseScalar(kind: FieldKind, raw: string): unknown {
    const text = raw.trim();
    if (text === '') return undefined;
    switch (kind) {
        case 'number': {
            const n = Number(text);
            return Number.isFinite(n) ? n : undefined;
        }
        case 'boolean':
            return text === 'true' ? true : text === 'false' ? false : undefined;
        case 'date':
            return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
        case 'datetime': {
            // An <input type="datetime-local"> gives local time without an offset; the API takes ISO
            // with one, so the browser's zone is applied here, once.
            const at = new Date(text);
            return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
        }
        default:
            return text;
    }
}

/** A value back into the string an input shows. */
export function formatScalar(kind: FieldKind, value: unknown): string {
    if (value === undefined || value === null) return '';
    if (kind === 'datetime' && typeof value === 'string') {
        const at = new Date(value);
        if (Number.isNaN(at.getTime())) return '';
        const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
        return local.toISOString().slice(0, 16);
    }
    return String(value);
}
