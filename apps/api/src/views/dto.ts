import { FIELD_NAME_PATTERN, RECORD_OBJECTS, SORT_MAX_FIELDS } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { filterGroupSchema, viewColumnSchema, viewSortSchema } from '../query/grammar';

const text = (max: number) => z.string().trim().max(max);

/** The shape of a view's parts; the fields they name are checked against the object by the service. */
const viewFields = {
    name: text(120).min(1),
    icon: text(64).nullable(),
    filter: filterGroupSchema.nullable(),
    sorts: z.array(viewSortSchema).max(SORT_MAX_FIELDS),
    columns: z.array(viewColumnSchema).max(100),
    groupBy: z.string().regex(FIELD_NAME_PATTERN).nullable(),
    position: z.number().finite(),
    isShared: z.boolean(),
};

export class CreateViewDto extends createZodDto(
    z
        .object({ object: z.enum(RECORD_OBJECTS), ...viewFields })
        .partial()
        .required({ object: true, name: true }),
) {}
export class UpdateViewDto extends createZodDto(z.object(viewFields).partial()) {}
export class ListViewsQueryDto extends createZodDto(z.object({ object: z.enum(RECORD_OBJECTS).optional() })) {}
