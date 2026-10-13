import { TWENTY_IMPORT_MODES, TWENTY_IMPORT_OBJECTS, TWENTY_IMPORT_RUN_STATUSES } from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named, page } from '../openapi/responses';

/** The Twenty importer (P4-4), as the API returns it. Moments are ISO 8601 text: the rows hold them as JSON already. */
const isoTime = z.iso.datetime();
const object = z.enum(TWENTY_IMPORT_OBJECTS);

export const twentyImportSettings = named(
    'TwentyImportSettings',
    z.object({
        configured: z.boolean(),
        baseUrl: z.string().nullable(),
        apiKeyLast4: z.string().nullable().meta({ description: 'The key itself is never returned.' }),
        configuredBy: id.nullable(),
        updatedAt: isoTime.nullable(),
    }),
);

export const twentyImportObjectReport = named(
    'TwentyImportObjectReport',
    z.object({
        object,
        remote: z.number().int().nullable().meta({ description: 'Twenty’s own count when the pass started.' }),
        before: z.number().int().meta({ description: 'Records of this object mapped here when the pass started.' }),
        read: z.number().int(),
        created: z.number().int(),
        updated: z.number().int(),
        unchanged: z.number().int(),
        merged: z.number().int(),
        skipped: z.number().int(),
        failed: z.number().int(),
        after: z.number().int().nullable(),
        missingInSource: z.number().int().nullable().meta({
            description:
                'A reconcile pass (#156): mapped records of this object Twenty no longer returns, flagged for review; null for any other pass.',
        }),
        errors: z.array(z.object({ externalId: z.string(), message: z.string() })),
    }),
);

export const twentyImportMissing = named(
    'TwentyImportMissing',
    z.object({
        object,
        externalId: z.string().meta({ description: 'The Twenty id the record was mapped from.' }),
        localType: z.string(),
        localId: id,
        name: z.string().nullable().meta({ description: 'The local record’s name, or the link’s label.' }),
        missingSince: isoTime,
    }),
);
export const twentyImportMissingPage = named('TwentyImportMissingPage', page(twentyImportMissing));

export const twentyImportRun = named(
    'TwentyImportRun',
    z.object({
        id,
        status: z.enum(TWENTY_IMPORT_RUN_STATUSES),
        mode: z.enum(TWENTY_IMPORT_MODES),
        since: isoTime.nullable(),
        phase: object.nullable(),
        report: z.array(twentyImportObjectReport),
        error: z.string().nullable(),
        cancelRequested: z.boolean(),
        startedBy: id.nullable(),
        queuedAt: isoTime,
        startedAt: isoTime.nullable(),
        finishedAt: isoTime.nullable(),
    }),
);

export const twentyImportOverview = named(
    'TwentyImportOverview',
    z.object({
        settings: twentyImportSettings,
        latestRun: twentyImportRun.nullable(),
        linked: z.array(z.object({ object, count: z.number().int() })),
    }),
);

export const twentyImportPreview = named(
    'TwentyImportPreview',
    z.object({
        checkedAt: isoTime,
        objects: z.array(
            z.object({
                object,
                remote: z.number().int().nullable(),
                linked: z.number().int(),
                error: z.string().nullable(),
            }),
        ),
    }),
);
