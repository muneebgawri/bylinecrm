import { MAILBOX_PAUSE_CODES } from '@bylinecrm/shared';
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
            description: 'The primary domain no sequence may send from; null when not set.',
        }),
        replyRateFloorBps: z.number().int().meta({
            description:
                'REP-2: reply-rate floor in basis points (100 = 1%) under which a mailbox is paused for new recipients.',
        }),
        replyRateMinSends: z
            .number()
            .int()
            .meta({ description: 'REP-2: new-thread sends needed before the floor is judged.' }),
        replyRateWindowDays: z
            .number()
            .int()
            .meta({ description: 'REP-2: the window the reply rate is measured over.' }),
        spamPauseBps: z.number().int().meta({
            description:
                'REP-2: Postmaster spam rate (basis points; 30 = 0.3%) that pauses every mailbox on the domain.',
        }),
        spamWarnBps: z.number().int().meta({ description: 'REP-2: Postmaster spam rate that warns admins.' }),
    }),
);

/** REP-2: the paused mailboxes, oldest pause first. */
export const pausedMailboxList = named(
    'PausedMailboxList',
    z.array(
        z.object({
            mailboxId: z.uuid(),
            email: z.string(),
            purpose: z.enum(['personal', 'pool']),
            pausedAt: z.iso.datetime(),
            pause: z.object({
                code: z.enum(MAILBOX_PAUSE_CODES),
                message: z.string(),
                rateBps: z.number().int(),
                thresholdBps: z.number().int(),
                sends: z.number().int().nullable(),
                at: z.iso.datetime(),
            }),
        }),
    ),
);
