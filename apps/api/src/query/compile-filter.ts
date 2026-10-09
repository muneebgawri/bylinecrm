import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
    type FieldKind,
    type FilterCondition,
    type FilterGroup,
    FILTER_MAX_IDS,
    type FilterNode,
    type FilterOperator,
    filterProblem,
    ID_FIELD,
    groupNodes,
    isFilterGroup,
    OPERATORS_BY_KIND,
} from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { fieldNamed, type ResolvedField } from './fields';

/**
 * A Prisma `where` object, untyped at the boundary: the three record models share the shape
 * this compiler produces (`AND`/`OR`/`NOT`, a column's operators, the `custom` JSON path
 * operators), and the service that owns the model gives it its type at the one call site.
 */
export type CompiledWhere = Record<string, unknown>;

/**
 * Turns a filter into a Prisma `where` — the one place the grammar meets the database, and no
 * SQL string anywhere: a standard field compiles to the column's operators, a custom field to
 * Prisma's JSON path operators on the `custom` column. Every condition is checked first: the
 * field exists, the kind takes the operator, the value is the kind's type; the first problem is
 * a `400` naming the condition's field.
 */
export function compileFilter(group: FilterGroup, fields: readonly ResolvedField[]): CompiledWhere {
    assertIdListsFit(group);
    const problem = filterProblem(group);
    if (problem) throw new BadRequestException(`filter: ${problem}`);
    return compileGroup(group, fields);
}

/**
 * Too many ids in one `in`/`nin` is a request too large to serve (`413`), not a malformed one:
 * the caller asked for more records by id than one request reads, and a shorter list would
 * silently drop some. Checked before the structural limits, which would call it a `400`.
 */
function assertIdListsFit(group: FilterGroup): void {
    const visit = (node: FilterNode): void => {
        if (isFilterGroup(node)) return groupNodes(node).forEach(visit);
        if (
            node.field === ID_FIELD.name &&
            (node.op === 'in' || node.op === 'nin') &&
            Array.isArray(node.value) &&
            node.value.length > FILTER_MAX_IDS
        ) {
            throw new PayloadTooLargeException(
                `filter: id ${node.op} takes at most ${FILTER_MAX_IDS} ids; split the request`,
            );
        }
    };
    visit(group);
}

function compileGroup(group: FilterGroup, fields: readonly ResolvedField[]): CompiledWhere {
    const nodes = groupNodes(group).map((node) => compileNode(node, fields));
    return 'and' in group ? { AND: nodes } : { OR: nodes };
}

function compileNode(node: FilterNode, fields: readonly ResolvedField[]): CompiledWhere {
    if (isFilterGroup(node)) return compileGroup(node, fields);
    const field = fieldNamed(fields, node.field, 'filter');
    if (!OPERATORS_BY_KIND[field.kind].includes(node.op)) {
        throw new BadRequestException(`filter: ${node.op} does not apply to ${node.field} (${field.kind})`);
    }
    const value = checkedValue(field, node);
    return field.storage === 'column'
        ? columnCondition(field.column, field.kind, node.op, value)
        : customCondition(field.key, field.kind, node.op, value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Values: each kind's scalar, lists for in/nin, a pair for between, nothing for null checks.
// ─────────────────────────────────────────────────────────────────────────────

const UUID = z.uuid();
const scalarByKind: Record<FieldKind, z.ZodType> = {
    text: z.string().max(10_000),
    number: z.number().finite(),
    money: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    boolean: z.boolean(),
    date: z.iso.date(),
    datetime: z.iso.datetime({ offset: true }),
    select: z.string().max(120),
    multiselect: z.string().max(120),
    uuid: UUID,
};

function checkedValue(field: ResolvedField, node: FilterCondition): unknown {
    const scalar = field.options ? z.enum(field.options as [string, ...string[]]) : scalarByKind[field.kind];
    const schema =
        node.op === 'is_null' || node.op === 'not_null'
            ? z.undefined()
            : node.op === 'in' || node.op === 'nin'
              ? z.array(scalar).min(1)
              : node.op === 'between'
                ? z.tuple([scalar, scalar])
                : scalar;
    const parsed = schema.safeParse(node.value);
    if (!parsed.success) {
        throw new BadRequestException(`filter: ${node.field} ${node.op} needs ${describe(field.kind, node.op)}`);
    }
    return parsed.data;
}

function describe(kind: FieldKind, op: FilterOperator): string {
    if (op === 'is_null' || op === 'not_null') return 'no value';
    if (op === 'in' || op === 'nin') return `a list of ${kind} values`;
    if (op === 'between') return `two ${kind} values`;
    return `a ${kind} value`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Columns.
// ─────────────────────────────────────────────────────────────────────────────

/** A stored value as Prisma compares it: minor units are `BigInt`, calendar dates and instants are `Date`. */
function stored(kind: FieldKind, value: unknown): unknown {
    if (kind === 'money') return BigInt(value as number);
    if (kind === 'date' || kind === 'datetime') return new Date(value as string);
    return value;
}

function columnCondition(column: string, kind: FieldKind, op: FilterOperator, value: unknown): CompiledWhere {
    const v = (x: unknown) => stored(kind, x);
    const text = kind === 'text' ? { mode: 'insensitive' } : {};
    switch (op) {
        case 'eq':
            return { [column]: { equals: v(value), ...text } };
        case 'neq':
            // `not` alone misses NULL rows in SQL; "not equal" includes "has no value".
            return { OR: [{ [column]: { not: v(value), ...text } }, { [column]: null }] };
        case 'in':
            return { [column]: { in: (value as unknown[]).map(v), ...text } };
        case 'nin':
            return { OR: [{ [column]: { notIn: (value as unknown[]).map(v), ...text } }, { [column]: null }] };
        case 'contains':
            return { [column]: { contains: value, ...text } };
        case 'starts':
            return { [column]: { startsWith: value, ...text } };
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte':
            return { [column]: { [op]: v(value) } };
        case 'between': {
            const [low, high] = value as [unknown, unknown];
            return { [column]: { gte: v(low), lte: v(high) } };
        }
        case 'is_null':
            return { [column]: null };
        case 'not_null':
            return { [column]: { not: null } };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom fields: JSON path operators on the `custom` column. A key that is absent and a key
// set to JSON null both read as "no value" (`AnyNull`). Text comparisons on JSON are
// case-sensitive — Prisma's JSON filters take no `mode` — and the design note says so.
// ─────────────────────────────────────────────────────────────────────────────

function customCondition(key: string, kind: FieldKind, op: FilterOperator, value: unknown): CompiledWhere {
    const at = (filter: Record<string, unknown>) => ({ custom: { path: [key], ...filter } });
    const notNull = at({ not: Prisma.AnyNull });
    switch (op) {
        case 'eq':
            return at({ equals: value });
        case 'neq':
            return { OR: [at({ not: value }), at({ equals: Prisma.AnyNull })] };
        case 'in':
            return kind === 'multiselect'
                ? { OR: (value as string[]).map((one) => at({ array_contains: [one] })) }
                : { OR: (value as unknown[]).map((one) => at({ equals: one })) };
        case 'nin':
            return { NOT: { OR: (value as unknown[]).map((one) => at({ equals: one })) } };
        case 'contains':
            return kind === 'multiselect' ? at({ array_contains: [value] }) : at({ string_contains: value });
        case 'starts':
            return at({ string_starts_with: value });
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte':
            return at({ [op]: value });
        case 'between': {
            const [low, high] = value as [unknown, unknown];
            return { AND: [at({ gte: low }), at({ lte: high })] };
        }
        case 'is_null':
            return at({ equals: Prisma.AnyNull });
        case 'not_null':
            return notNull;
    }
}
