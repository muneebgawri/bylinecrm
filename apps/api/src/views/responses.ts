import { RECORD_OBJECTS, type SavedView } from '@bylinecrm/shared';
import { z } from 'zod';
import { EXAMPLE_TIME, id, named } from '../openapi/responses';
import { filterGroupSchema, viewColumnSchema, viewSortSchema } from '../query/grammar';

/**
 * A saved view (PAR-056). Its type lives in @bylinecrm/shared because the web app builds views;
 * the annotation below holds this schema to it, so the two cannot drift.
 */
export const savedViewSchema: z.ZodType<SavedView> = named(
    'SavedView',
    z.object({
        id,
        object: z.enum(RECORD_OBJECTS),
        name: z.string(),
        icon: z.string().nullable(),
        ownerMemberId: id.nullable(),
        isShared: z.boolean(),
        filter: named('FilterGroup', filterGroupSchema).nullable(),
        sorts: z.array(viewSortSchema),
        columns: z.array(viewColumnSchema),
        groupBy: z.string().nullable(),
        position: z.number(),
        createdAt: z.iso.datetime().meta({ example: EXAMPLE_TIME }),
        updatedAt: z.iso.datetime().meta({ example: EXAMPLE_TIME }),
    }),
);
