import {
    BIGIN_IMPORT_MODES,
    BIGIN_IMPORT_OBJECTS,
    BIGIN_IMPORT_RUN_STATUSES,
    BIGIN_STAGE_APPLY_STATUSES,
    BIGIN_STAGE_MATCHES,
    BIGIN_STAGE_SOURCES,
    STAGE_KINDS,
} from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named, page } from '../openapi/responses';
import { twentyImportSync } from '../twenty-import/responses';

/** The Bigin importer (BIGIN-1), as the API returns it. */
const isoTime = z.iso.datetime();
const object = z.enum(BIGIN_IMPORT_OBJECTS);

export const biginImportSettings = named(
    'BiginImportSettings',
    z.object({
        configured: z.boolean(),
        accountsUrl: z.string().nullable(),
        apiUrl: z.string().nullable(),
        clientId: z.string().nullable(),
        refreshTokenLast4: z
            .string()
            .nullable()
            .meta({ description: 'The refresh token and client secret themselves are never returned.' }),
        configuredBy: id.nullable(),
        updatedAt: isoTime.nullable(),
        createMembers: z.object({ roleId: id }).nullable(),
    }),
);

export const biginImportObjectReport = named(
    'BiginImportObjectReport',
    z.object({
        object,
        remote: z.number().int().nullable(),
        before: z.number().int(),
        read: z.number().int(),
        created: z.number().int(),
        updated: z.number().int(),
        unchanged: z.number().int(),
        merged: z.number().int().meta({
            description:
                'Linked to a record BylineCRM had: the same Bigin record imported from Twenty, a person by address, a company by domain.',
        }),
        skipped: z.number().int(),
        failed: z.number().int().meta({ description: 'Always present, zero included.' }),
        after: z.number().int().nullable(),
        missingInSource: z
            .number()
            .int()
            .meta({ description: 'Mapped records Bigin deleted, flagged by this run for review; never deleted here.' }),
        errors: z.array(z.object({ externalId: z.string(), message: z.string() })),
        conflicts: z.number().int(),
        kept: z.array(z.object({ externalId: z.string(), fields: z.array(z.string()) })),
        unknownStages: z
            .array(z.object({ externalId: z.string(), stage: z.string() }))
            .meta({ description: 'Deals whose Bigin stage has no stage here: placed in the first open stage.' }),
        reused: z.number().int().meta({
            description:
                'Contacts edited in Bigin to hold a different person: the earlier person kept, a new one made, the link moved.',
        }),
        ownersFilled: z.number().int().meta({
            description:
                "Matched records with no owner given Bigin's owner (a deal without one: its point of contact's). Existing owners are never changed.",
        }),
    }),
);

export const biginImportRun = named(
    'BiginImportRun',
    z.object({
        id,
        status: z.enum(BIGIN_IMPORT_RUN_STATUSES),
        mode: z.enum(BIGIN_IMPORT_MODES),
        phase: object.nullable(),
        report: z.array(biginImportObjectReport),
        error: z.string().nullable(),
        failedRecords: z.number().int().meta({ description: 'Records that failed across every module.' }),
        cancelRequested: z.boolean(),
        scheduled: z.boolean(),
        startedBy: id.nullable(),
        createMembers: z.object({ roleId: id }).nullable(),
        accountsCreated: z.number().int(),
        queuedAt: isoTime,
        startedAt: isoTime.nullable(),
        finishedAt: isoTime.nullable(),
    }),
);

export const biginImportSync = twentyImportSync;

export const biginImportOverview = named(
    'BiginImportOverview',
    z.object({
        settings: biginImportSettings,
        latestRun: biginImportRun.nullable(),
        linked: z.array(z.object({ object, count: z.number().int() })),
        cursors: z.array(z.object({ object, since: isoTime.nullable() })),
        sync: biginImportSync,
    }),
);

export const biginImportPreview = named(
    'BiginImportPreview',
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

export const biginImportMissing = named(
    'BiginImportMissing',
    z.object({
        object,
        externalId: z.string(),
        localType: z.string(),
        localId: id,
        name: z.string().nullable(),
        missingSince: isoTime,
    }),
);
export const biginImportMissingPage = named('BiginImportMissingPage', page(biginImportMissing));

const identity = z.object({ name: z.string(), email: z.string().nullable() });

export const biginContactReuse = named(
    'BiginContactReuse',
    z.object({
        id,
        biginId: z.string(),
        previousPersonId: id,
        newPersonId: id,
        detectedAt: isoTime,
        before: identity,
        after: identity,
    }),
);
export const biginContactReusePage = named('BiginContactReusePage', page(biginContactReuse));

export const biginStageApply = named(
    'BiginStageApply',
    z.object({
        status: z.enum(BIGIN_STAGE_APPLY_STATUSES),
        requestedAt: isoTime,
        finishedAt: isoTime.nullable(),
        moved: z.number().int(),
        skipped: z
            .number()
            .int()
            .meta({ description: 'Deals left in place: someone moved them by hand after Bigin last changed them.' }),
        error: z.string().nullable(),
    }),
);

export const biginStageMap = named(
    'BiginStageMap',
    z.object({
        source: z.enum(BIGIN_STAGE_SOURCES).meta({
            description:
                "`bigin`: Bigin's Deals Stage picklist; `imported`: Bigin unreadable, the stages imported deals carry.",
        }),
        error: z.string().nullable(),
        pipelineId: id,
        stages: z.array(z.object({ id, name: z.string(), kind: z.enum(STAGE_KINDS) })),
        rows: z.array(
            z.object({
                biginStage: z.string(),
                deals: z.number().int(),
                stageId: id.nullable().meta({ description: 'The explicit mapping; null when left to the name match.' }),
                targetStageId: id,
                match: z.enum(BIGIN_STAGE_MATCHES),
            }),
        ),
        unread: z
            .number()
            .int()
            .meta({ description: 'Imported deals whose link has no Bigin stage yet; a full run fills them.' }),
        apply: biginStageApply.nullable(),
    }),
);
