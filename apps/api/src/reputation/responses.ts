import { z } from 'zod';
import { named } from '../openapi/responses';

/** The workspace's sender-reputation thresholds (REP-1, FR-CRMS-23). */
export const reputationSettings = named(
    'ReputationSettings',
    z.object({
        dailyNewRecipients: z.number().int().meta({
            description: 'New-recipient messages a personal mailbox may send in a rolling 24 hours (replies exempt).',
        }),
        hourlyNewRecipients: z.number().int().meta({ description: 'The same, in a rolling hour.' }),
        poolHourlyCap: z.number().int().meta({ description: 'A pool mailbox’s sends in a rolling hour.' }),
        nearDuplicateThreshold: z.number().int().meta({
            description: 'Distinct recipients of near-identical 1:1 bodies in 24 hours before the next is refused.',
        }),
        nearDuplicateDistance: z.number().int().meta({ description: 'Simhash bits at or under which bodies match.' }),
        subjectRepeatThreshold: z.number().int().meta({
            description: 'Distinct new recipients of one normalised subject in 24 hours before the next is refused.',
        }),
        primaryDomain: z.string().nullable().meta({
            description:
                'An admin’s override of the primary domain; null to derive it from the members’ sign-in addresses.',
        }),
        effectivePrimaryDomain: z.string().nullable().meta({
            description:
                'The primary domain in force (no sequence sends from it): the override, else the domain most members sign in with.',
        }),
    }),
);
