import { RECORD_OBJECTS, type SearchResults } from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named } from '../openapi/responses';

/** Group-by and global search (P1-4), as the API returns them. */

export const groupView = named(
    'Group',
    z.object({
        value: z.unknown().meta({ description: "The field's value for this group; `null` groups the unset rows." }),
        count: z.number().int(),
        sum: z
            .object({ amountMinor: z.number().int(), field: z.string() })
            .optional()
            .meta({ description: "The object's money field summed in minor units; absent for people." }),
    }),
);

const searchHit = named(
    'SearchHit',
    z.object({
        object: z.enum(RECORD_OBJECTS),
        id,
        title: z.string(),
        subtitle: z.string().nullable(),
    }),
);

/** Hits per object; an object the caller cannot read, or did not ask for, is an empty list. */
export const searchResults: z.ZodType<SearchResults> = named(
    'SearchResults',
    z.object(
        Object.fromEntries(RECORD_OBJECTS.map((object) => [object, z.array(searchHit)])) as Record<
            (typeof RECORD_OBJECTS)[number],
            z.ZodArray<typeof searchHit>
        >,
    ),
);

export type Group = z.output<typeof groupView>;
