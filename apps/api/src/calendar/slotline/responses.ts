import { z } from 'zod';
import { dateTime, named } from '../../openapi/responses';

/** The workspace's Slotline hook (CAL-2) as an admin sees it. Never the secret. */
export const slotlineSettingsView = named(
    'SlotlineSettings',
    z.object({
        configured: z.boolean(),
        baseUrl: z.string().nullable().meta({ description: 'The booking site, for links to a booking.' }),
        hookUrl: z.url().nullable().meta({
            description: 'Paste this as the subscriber URL of the webhook in Slotline, with the same secret.',
        }),
        triggers: z.array(z.string()).meta({ description: 'The booking events to subscribe the webhook to.' }),
        lastDeliveryAt: dateTime.nullable(),
        lastDeliveryResult: z.string().nullable().meta({
            description:
                '`stored`, `cancelled`, `ignored`, `unmatched` (no member organised it), `ping` or `bad_signature`.',
        }),
        unmatchedOrganizers: z.number().int().meta({
            description: 'Bookings whose organiser is no member, by sign-in address or personal mailbox.',
        }),
        lastUnmatchedOrganizer: z.string().nullable(),
    }),
);

/** What the hook answers Slotline: what it did with the delivery. */
export const slotlineHookResult = named(
    'SlotlineHookResult',
    z.object({
        result: z.enum(['stored', 'cancelled', 'ignored', 'unmatched', 'ping']),
    }),
);

export type SlotlineSettingsView = z.output<typeof slotlineSettingsView>;
export type SlotlineHookResult = z.output<typeof slotlineHookResult>;
