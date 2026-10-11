import { SUPPRESSION_REASONS, SUPPRESSION_SOURCES } from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named, page } from '../openapi/responses';

/** The suppression list (P3-1) and the public unsubscribe routes, as the API returns them. */

export const suppressionView = named(
    'Suppression',
    z.object({
        id,
        address: z.string().meta({ description: 'Lower case.' }),
        reason: z.enum(SUPPRESSION_REASONS),
        source: z.enum(SUPPRESSION_SOURCES).meta({
            description:
                '`recipient`: the person used an unsubscribe link; `member`: added in the CRM; `provider`: a bounce or complaint report.',
        }),
        personId: id.nullable().meta({ description: 'The person the address belonged to, when known.' }),
        note: z.string().nullable(),
        createdByMemberId: id.nullable(),
        createdAt: dateTime,
        liftable: z.boolean().meta({
            description:
                'Whether an admin may lift it: a hard bounce or a manual entry. An unsubscribe or a complaint is never lifted in the CRM.',
        }),
    }),
);

export const suppressionPage = named('SuppressionPage', page(suppressionView));

export const unsubscribeStatus = named(
    'UnsubscribeStatus',
    z.object({
        recipient: z.string().meta({
            description: 'The address the link was sent to, masked (`d•••@acme.example`).',
            example: 'd•••@acme.example',
        }),
        unsubscribed: z.boolean(),
    }),
);

export type SuppressionView = z.output<typeof suppressionView>;
export type UnsubscribeStatusView = z.output<typeof unsubscribeStatus>;
