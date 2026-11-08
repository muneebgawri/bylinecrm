import { CALL_DIRECTIONS, CALL_DISPOSITIONS, CALL_PROVIDERS, CALL_STATUSES } from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named } from '../openapi/responses';

const dateTime = z.iso.datetime();

export const quoSettingsView = named(
    'QuoSettings',
    z.object({
        configured: z.boolean().meta({ description: 'A Quo API key is saved: calls come in.' }),
        webhookUrl: z.url().meta({ description: 'The receiver the CRM registered at Quo. Nothing to paste anywhere.' }),
        webhookRegistered: z.boolean(),
        matchedMemberIds: z.array(id).meta({ description: 'Members matched to a Quo user by email.' }),
        unmatchedQuoEmails: z.array(z.string()).meta({ description: 'Quo users whose email is no member here.' }),
        lastDeliveryAt: dateTime.nullable(),
        lastDeliveryResult: z
            .string()
            .nullable()
            .meta({ description: '`recorded`, `updated`, `ignored`, `unknown_call` or `bad_signature`.' }),
    }),
);

export const callView = named(
    'Call',
    z.object({
        id,
        provider: z.enum(CALL_PROVIDERS),
        personId: id.nullable(),
        memberId: id.nullable(),
        direction: z.enum(CALL_DIRECTIONS),
        status: z.enum(CALL_STATUSES),
        fromNumber: z.string().nullable(),
        toNumber: z.string().nullable(),
        startedAt: dateTime,
        answeredAt: dateTime.nullable(),
        completedAt: dateTime.nullable(),
        durationSec: z.number().int().nullable(),
        hasVoicemail: z.boolean(),
        recordings: z.array(z.object({ url: z.url(), durationSec: z.number().nullable() })),
        summary: z.object({ summary: z.array(z.string()), nextSteps: z.array(z.string()) }).nullable(),
        transcript: z
            .array(
                z.object({
                    speakerUserId: z.string().nullable(),
                    text: z.string(),
                    start: z.number(),
                    end: z.number(),
                }),
            )
            .nullable(),
        disposition: z.enum(CALL_DISPOSITIONS).nullable(),
        noteId: id.nullable(),
        quoLink: z.string().nullable(),
        createdAt: dateTime,
        updatedAt: dateTime,
    }),
);

export const quoHookResult = named(
    'QuoHookResult',
    z.object({ result: z.enum(['recorded', 'updated', 'ignored', 'unknown_call', 'bad_signature']) }),
);
