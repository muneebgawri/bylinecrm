import { RECORD_OBJECTS, type SearchResults } from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named } from '../openapi/responses';
import { memberSummaryView } from '../workspace/responses';

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
        owner: memberSummaryView
            .nullable()
            .meta({ description: "The record's current owner, by name; null when it has none." }),
        canOpen: z.boolean().meta({
            description:
                "False for a record outside the caller's owner scope: listed by name and owner only (subtitle null) so they can see it is taken.",
        }),
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
