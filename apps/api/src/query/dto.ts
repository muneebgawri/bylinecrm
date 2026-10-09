import {
    FIELD_NAME_PATTERN,
    filterGroupSchema,
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
    RECORD_OBJECTS,
    SEARCH_GROUP_LIMIT_DEFAULT,
    SEARCH_GROUP_LIMIT_MAX,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

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

export class ExportQueryDto extends createZodDto(
    z.object({
        ...queryParams,
        columns: z
            .string()
            .regex(/^[a-zA-Z0-9_.]+(,[a-zA-Z0-9_.]+)*$/, 'columns is a comma-separated list of field names')
            .optional(),
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
