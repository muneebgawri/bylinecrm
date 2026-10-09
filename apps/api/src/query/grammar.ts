import {
    FIELD_NAME_PATTERN,
    FILTER_OPERATORS,
    type FilterGroup,
    type FilterNode,
    VIEW_COLUMN_WIDTH_MAX,
    VIEW_COLUMN_WIDTH_MIN,
} from '@bylinecrm/shared';
import { z } from 'zod';

/**
 * The filter grammar's shape, as zod: groups of `and`/`or` over conditions, each condition a
 * field name (standard or `custom.<key>`), an operator from the shared list, and an optional
 * value. Built here from the shared types and constants rather than shipped from the shared
 * package, so the web app's bundle carries the types and not a schema library. Depth and node
 * limits are `filterProblem`'s (shared); semantics are the compiler's.
 */
const filterCondition = z
    .object({
        field: z.string().regex(FIELD_NAME_PATTERN, 'a field is a standard name or custom.<key>'),
        op: z.enum(FILTER_OPERATORS),
        value: z.unknown().optional(),
    })
    .strict();

export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
    z.union([
        z.object({ and: z.array(filterNodeSchema) }).strict(),
        z.object({ or: z.array(filterNodeSchema) }).strict(),
    ]),
);
const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() => z.union([filterGroupSchema, filterCondition]));

export const viewSortSchema = z
    .object({ field: z.string().regex(FIELD_NAME_PATTERN), direction: z.enum(['asc', 'desc']) })
    .strict();

export const viewColumnSchema = z
    .object({
        field: z.string().regex(FIELD_NAME_PATTERN),
        width: z.number().int().min(VIEW_COLUMN_WIDTH_MIN).max(VIEW_COLUMN_WIDTH_MAX).optional(),
    })
    .strict();
