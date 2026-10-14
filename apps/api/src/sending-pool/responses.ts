import {
    MAILBOX_PAUSE_CODES,
    MAILBOX_STATUSES,
    POSTMASTER_CONNECTION_STATUSES,
    POSTMASTER_DOMAIN_STATUSES,
} from '@bylinecrm/shared';
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
        spamRate: z
            .object({
                day: z.iso.date().meta({ description: 'The day the rate is for, UTC.' }),
                rateBps: z.number().int().meta({ description: 'Basis points: 35 = 0.35%.' }),
            })
            .nullable()
            .meta({
                description:
                    'The latest user-reported spam rate Postmaster Tools gave for the domain (#129); a failed lookup keeps the last one.',
            }),
        postmaster: z.object({
            status: z.enum(POSTMASTER_DOMAIN_STATUSES).meta({
                description:
                    'What the last ask of Postmaster Tools came to: nothing connected, the domain not verified there, an answer, a rate limit or no answer (both transient, #183), or a refusal.',
            }),
            message: z.string().nullable(),
            nextReadAt: isoTime.nullable().meta({
                description: 'When the check asks Postmaster Tools again (#183); null while nothing is connected.',
            }),
        }),
    }),
);

export const postmasterConnectionView = named(
    'PostmasterConnection',
    z.object({
        email: z
            .string()
            .meta({ description: 'The Google account that verified the sending domains in Postmaster Tools.' }),
        status: z.enum(POSTMASTER_CONNECTION_STATUSES),
        connectedAt: isoTime,
        lastError: z.string().nullable().meta({ description: 'Why it needs reconnecting, when it does.' }),
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
        sends: z
            .number()
            .int()
            .nullable()
            .meta({ description: 'Sends the rate was measured over; null for a domain rate from Postmaster Tools.' }),
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
        postmaster: postmasterConnectionView
            .nullable()
            .meta({ description: 'The Postmaster Tools account connected (#129), or null while none is.' }),
    }),
);
