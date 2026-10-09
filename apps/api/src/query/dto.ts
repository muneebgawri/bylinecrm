import {
    BULK_ACTIONS,
    FIELD_NAME_PATTERN,
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
    RECORD_OBJECTS,
    SEARCH_GROUP_LIMIT_DEFAULT,
    SEARCH_GROUP_LIMIT_MAX,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { filterGroupSchema } from './grammar';

const text = (max: number) => z.string().trim().max(max);

/** `field:asc,field2:desc`; the fields are checked against the object by the planner. */
export const sortParam = z
    .string()
    .regex(
        /^[a-zA-Z0-9_.]+:(asc|desc)(,[a-zA-Z0-9_.]+:(asc|desc))*$/,
        'sort is field:asc or field:desc, comma-separated',
    );
/** A filter in a query string: base64url of its JSON; decoded and checked by the planner. */
export const filterParam = z.string().min(1).max(20_000);
const viewParam = z.uuid();
const q = text(200).min(1);

/** What every record list, export and group-by accepts over the query string. */
export const queryParams = {
    filter: filterParam.optional(),
    sort: sortParam.optional(),
    view: viewParam.optional(),
    q: q.optional(),
};

/** `POST …/query`: the list's parameters in a body, with the filter as JSON rather than base64url. */
export class QueryBodyDto extends createZodDto(
    z.object({
        filter: filterGroupSchema.optional(),
        sort: sortParam.optional(),
        view: viewParam.optional(),
        q: q.optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
    }),
) {}

const columnsParam = z
    .string()
    .regex(/^[a-zA-Z0-9_.]+(,[a-zA-Z0-9_.]+)*$/, 'columns is a comma-separated list of field names');

export class ExportQueryDto extends createZodDto(z.object({ ...queryParams, columns: columnsParam.optional() })) {}

/**
 * The export's twin for a filter too long for a query string — a selection of up to
 * `FILTER_MAX_IDS` ids, typically (`{ field: 'id', op: 'in', value: [...] }`). The same
 * parameters, the filter as JSON; the same CSV back.
 */
export class ExportBodyDto extends createZodDto(
    z.object({
        filter: filterGroupSchema.optional(),
        sort: sortParam.optional(),
        view: viewParam.optional(),
        q: q.optional(),
        columns: columnsParam.optional(),
    }),
) {}

/**
 * A bulk request (P1-4a): an action over named `ids`, or over the records a list request selects
 * (`filter` / `view` / `q`, as the list takes them) — one or the other. `ownerId` goes with
 * `assign_owner` and nothing else; `null` leaves the records with no owner.
 */
export class BulkBodyDto extends createZodDto(
    z
        .object({
            action: z.enum(BULK_ACTIONS),
            ids: z
                .array(z.uuid())
                .min(1)
                .optional()
                .meta({ description: 'At most BULK_MAX_IDS (500) distinct ids; more is 413.' }),
            filter: filterGroupSchema.optional(),
            view: viewParam.optional(),
            q: q.optional(),
            ownerId: z.uuid().nullable().optional(),
        })
        .refine(
            (b) => (b.ids !== undefined) !== (b.filter !== undefined || b.view !== undefined || b.q !== undefined),
            {
                message: 'name the records by ids, or select them by filter / view / q — one or the other',
                path: ['ids'],
            },
        )
        .refine((b) => (b.action === 'assign_owner') === (b.ownerId !== undefined), {
            message: 'ownerId goes with assign_owner, and only with it',
            path: ['ownerId'],
        }),
) {}

export class GroupByQueryDto extends createZodDto(
    z.object({ ...queryParams, field: z.string().regex(FIELD_NAME_PATTERN) }),
) {}

const objectList = z
    .string()
    .transform((s) => s.split(','))
    .pipe(z.array(z.enum(RECORD_OBJECTS)).min(1));

export class SearchQueryDto extends createZodDto(
    z.object({
        q,
        limit: z.coerce.number().int().min(1).max(SEARCH_GROUP_LIMIT_MAX).default(SEARCH_GROUP_LIMIT_DEFAULT),
        /** Which objects to search, comma-separated; all three when absent. */
        objects: objectList.optional(),
    }),
) {}
