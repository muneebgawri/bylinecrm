import {
    ENRICHMENT_ANSWER_STATUSES,
    ENRICHMENT_FACT_KEYS,
    ENRICHMENT_OBJECTS,
    ENRICHMENT_SOURCES,
    type EnrichmentAnswerView,
    type EnrichmentHistoryView,
    type EnrichmentSettingsView,
} from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named } from '../openapi/responses';

/** Enrichment (P4-2), as the API returns it. */

const isoTime = z.iso.datetime();

export const enrichmentAnswerView = named(
    'EnrichmentAnswer',
    z.object({
        id,
        object: z.enum(ENRICHMENT_OBJECTS),
        recordId: id,
        field: z.enum(ENRICHMENT_FACT_KEYS as [string, ...string[]]),
        source: z.enum(ENRICHMENT_SOURCES),
        status: z.enum(ENRICHMENT_ANSWER_STATUSES),
        value: z.string().nullable().meta({ description: 'The fact; null unless answered — never an empty string.' }),
        rank: z.number().int(),
        note: z.string().nullable(),
        applied: z.boolean().meta({ description: 'Whether the answer was written to the record’s field.' }),
        askedAt: isoTime,
    }),
);

export const enrichmentHistoryView = named(
    'EnrichmentHistory',
    z.object({
        object: z.enum(ENRICHMENT_OBJECTS),
        recordId: id,
        lastAskedAt: isoTime.nullable(),
        pending: z.boolean().meta({ description: 'A run for the record is queued or going.' }),
        answers: z.array(enrichmentAnswerView).meta({ description: 'Newest first.' }),
    }),
);

export const enrichmentSettingsView = named(
    'EnrichmentSettings',
    z.object({
        reaskAfterDays: z.number().int(),
        sources: z.object(
            Object.fromEntries(ENRICHMENT_SOURCES.map((s) => [s, z.boolean()])) as Record<
                (typeof ENRICHMENT_SOURCES)[number],
                z.ZodBoolean
            >,
        ),
        isDefault: z.boolean(),
        updatedAt: isoTime.nullable(),
    }),
);

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Loose<T> = { [K in keyof T]: T[K] extends string ? string : T[K] };
export type EnrichmentTypeChecks = [
    Assert<Same<Omit<z.output<typeof enrichmentAnswerView>, 'field'>, Omit<EnrichmentAnswerView, 'field'>>>,
    Assert<Same<z.output<typeof enrichmentAnswerView>['field'], Loose<Pick<EnrichmentAnswerView, 'field'>>['field']>>,
    Assert<Same<Omit<z.output<typeof enrichmentHistoryView>, 'answers'>, Omit<EnrichmentHistoryView, 'answers'>>>,
    Assert<Same<z.output<typeof enrichmentSettingsView>, EnrichmentSettingsView>>,
];
