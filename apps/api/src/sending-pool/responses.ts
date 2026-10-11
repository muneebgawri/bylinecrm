import { MAILBOX_PAUSE_CODES, MAILBOX_STATUSES } from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named } from '../openapi/responses';

/** A moment the service already holds as ISO 8601 (it was stored in JSON, or is reported as text). */
const isoTime = z.iso.datetime();

/** The sending pool (P3-2), as the API returns it. */

const step = z.object({ outcome: z.enum(['pass', 'fail']), message: z.string() });

export const sendingDomainView = named(
    'SendingDomain',
    z.object({
        id,
        domain: z.string().meta({ description: 'Lower case: what follows the @ of a pool mailbox.' }),
        dkimSelector: z
            .string()
            .meta({ description: 'Checked at `<selector>._domainkey.<domain>`.', example: 'google' }),
        status: z.enum(['unchecked', 'pass', 'fail']).meta({
            description: 'A pool mailbox sends only while its domain is `pass` (FR-CRMS-13).',
        }),
        lastCheck: z.object({ spf: step, dkim: step, dmarc: step }).nullable(),
        checkedAt: isoTime.nullable(),
        nextCheckAt: isoTime,
    }),
);

export const mailboxPause = named(
    'MailboxPause',
    z.object({
        code: z.enum(MAILBOX_PAUSE_CODES),
        message: z.string(),
        rateBps: z
            .number()
            .int()
            .meta({ description: 'Basis points (1/100 of a percent) when the pause was decided.' }),
        thresholdBps: z.number().int(),
        sends: z.number().int(),
        at: isoTime,
    }),
);

export const sendingPoolSettings = named(
    'SendingPoolSettings',
    z.object({
        dailyCap: z.number().int(),
        warmupStartPerDay: z.number().int(),
        warmupDays: z.number().int(),
        jitterMinSeconds: z.number().int(),
        jitterMaxSeconds: z.number().int(),
        bouncePauseBps: z.number().int(),
        complaintPauseBps: z.number().int(),
        rateMinSample: z.number().int(),
        rateWindowDays: z.number().int(),
    }),
);

export const poolMailboxHealth = named(
    'PoolMailboxHealth',
    z.object({
        mailboxId: id,
        email: z.string(),
        status: z.enum(MAILBOX_STATUSES),
        dailyCapOverride: z.number().int().nullable(),
        dailyCap: z.number().int(),
        warmupDay: z.number().int().nullable(),
        warmupLimit: z.number().int(),
        allowance: z.number().int().meta({ description: 'min(cap, warm-up limit) for the rolling 24 hours.' }),
        used: z.number().int().meta({ description: 'Sends that went or are going in the last 24 hours.' }),
        paused: mailboxPause.nullable(),
        domain: sendingDomainView.nullable(),
        canSend: z.boolean(),
    }),
);

export const sendingPoolView = named(
    'SendingPool',
    z.object({
        settings: sendingPoolSettings,
        mailboxes: z.array(poolMailboxHealth),
        domains: z.array(sendingDomainView),
    }),
);
