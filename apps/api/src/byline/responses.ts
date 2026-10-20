import { z } from 'zod';
import { id, named } from '../openapi/responses';

const dateTime = z.iso.datetime();

/** The workspace's BylineAI link as an admin sees it. Never the secret. */
export const bylineSettingsView = named(
    'BylineSettings',
    z.object({
        configured: z.boolean(),
        webhookUrl: z.url().meta({
            description: 'Point BylineAI’s `BYLINE_WEBHOOK_URL` here, with the same secret as `BYLINE_WEBHOOK_SECRET`.',
        }),
        roundRobinMemberIds: z.array(id).meta({
            description:
                'A lead at a company nobody owns is dealt to these members in turn; empty, it waits unowned in the Leads queue.',
        }),
        lastDeliveryAt: dateTime.nullable(),
        lastDeliveryResult: z.string().nullable().meta({
            description: '`ingested`, `duplicate`, `rejected` or `bad_signature`.',
        }),
    }),
);

/** The answer in BylineAI's shape: it reads `status` from the body, not the HTTP code. */
export const bylineLeadResult = named(
    'BylineLeadResult',
    z.object({
        status: z.enum(['ingested', 'duplicate', 'rejected']),
        personId: id
            .nullable()
            .optional()
            .meta({ description: 'The person the lead is; with `ingested`/`duplicate`.' }),
        reason: z.string().optional().meta({ description: 'Why, with `rejected`.' }),
    }),
);

export type BylineSettingsView = z.output<typeof bylineSettingsView>;
export type BylineLeadResult = z.output<typeof bylineLeadResult>;
