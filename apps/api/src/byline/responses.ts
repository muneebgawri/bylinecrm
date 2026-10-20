import { z } from 'zod';
import { id, named } from '../openapi/responses';

const dateTime = z.iso.datetime();

/** The workspace's BylineAI link as an admin sees it. Never the secret. */
export const bylineSettingsView = named(
    'BylineSettings',
    z.object({
        configured: z.boolean().meta({ description: 'The webhook has a secret: BylineAI’s leads are taken in.' }),
        apiConfigured: z
            .boolean()
            .meta({ description: 'BylineAI’s API is linked (BYL-2): it enriches, and may verify.' }),
        baseUrl: z.string().nullable().meta({ description: 'BylineAI’s address. Never the key.' }),
        verifyWithByline: z.boolean().meta({
            description: 'Email verification asks BylineAI (its Reacher pool), falling back to the free layer.',
        }),
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
