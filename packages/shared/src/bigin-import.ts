/**
 * The Bigin importer (BIGIN-1, FR-CRMS-25): what the API, the web app and the tests share. A workspace
 * whose team works in Zoho Bigin connects it (a Zoho OAuth client and a refresh token); the importer
 * reads Bigin's modules below one way, Bigin → BylineCRM, maps every record by its Bigin id (so a run
 * can be repeated and only writes what changed) and reports, per module, what the run did. Why each
 * mapping is what it is: docs/design-notes/BIGIN-1.md.
 */

import type { TwentyImportRecordError, TwentyImportSyncView } from './twenty-import.js';

/** The Bigin modules the importer reads, in the order it reads them (a later one refers to earlier ones). */
export const BIGIN_IMPORT_OBJECTS = ['Accounts', 'Contacts', 'Deals', 'Notes'] as const;
export type BiginImportObject = (typeof BIGIN_IMPORT_OBJECTS)[number];

export function isBiginImportObject(value: unknown): value is BiginImportObject {
    return typeof value === 'string' && (BIGIN_IMPORT_OBJECTS as readonly string[]).includes(value);
}

/** How the importer screen names each module, and where its records land in BylineCRM. */
export const BIGIN_IMPORT_OBJECT_LABELS: Readonly<Record<BiginImportObject, { label: string; lands: string }>> = {
    Accounts: { label: 'Companies', lands: 'Companies' },
    Contacts: { label: 'Contacts', lands: 'People' },
    Deals: { label: 'Deals', lands: 'Deals in the default pipeline' },
    Notes: { label: 'Notes', lands: 'Notes on their records' },
};

export const BIGIN_IMPORT_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type BiginImportRunStatus = (typeof BIGIN_IMPORT_RUN_STATUSES)[number];

/**
 * `full` reads every record; `changes` only what Bigin modified since the module's cursor (all of it
 * while a module has none). Records Bigin deleted are read on every run and flagged as missing in
 * source for review — never deleted here.
 */
export const BIGIN_IMPORT_MODES = ['full', 'changes'] as const;
export type BiginImportMode = (typeof BIGIN_IMPORT_MODES)[number];

/** `people.source` of a person the importer creates. */
export const BIGIN_IMPORT_SOURCE = 'bigin';
/** Bigin's REST page ceiling. */
export const BIGIN_PAGE_SIZE = 200;

/** Zoho's data centres: where a Bigin account's OAuth server and API live. The screen fills the two URLs from one. */
export const BIGIN_DATA_CENTRES = [
    {
        code: 'com',
        label: 'United States (zoho.com)',
        accountsUrl: 'https://accounts.zoho.com',
        apiUrl: 'https://www.zohoapis.com',
    },
    {
        code: 'eu',
        label: 'Europe (zoho.eu)',
        accountsUrl: 'https://accounts.zoho.eu',
        apiUrl: 'https://www.zohoapis.eu',
    },
    {
        code: 'in',
        label: 'India (zoho.in)',
        accountsUrl: 'https://accounts.zoho.in',
        apiUrl: 'https://www.zohoapis.in',
    },
    {
        code: 'com.au',
        label: 'Australia (zoho.com.au)',
        accountsUrl: 'https://accounts.zoho.com.au',
        apiUrl: 'https://www.zohoapis.com.au',
    },
    {
        code: 'jp',
        label: 'Japan (zoho.jp)',
        accountsUrl: 'https://accounts.zoho.jp',
        apiUrl: 'https://www.zohoapis.jp',
    },
    {
        code: 'ca',
        label: 'Canada (zohocloud.ca)',
        accountsUrl: 'https://accounts.zohocloud.ca',
        apiUrl: 'https://www.zohoapis.ca',
    },
] as const;

/**
 * What one run did with one module. The outcomes sum to the records read: `created` + `updated` +
 * `unchanged` + `merged` + `skipped` + `failed` — `failed` is always present, zero included, so a run
 * with errors says so per module.
 */
export interface BiginImportObjectReport {
    object: BiginImportObject;
    /** Bigin's own count when the pass started; null when Bigin would not say. */
    remote: number | null;
    before: number;
    read: number;
    created: number;
    updated: number;
    unchanged: number;
    /**
     * Linked to a record BylineCRM had already: the same record imported from Twenty (its `biginrecordid`),
     * a person with the address, a company with the registrable domain.
     */
    merged: number;
    skipped: number;
    failed: number;
    after: number | null;
    /** Mapped records Bigin deleted, flagged by this run for review (never deleted here). */
    missingInSource: number;
    errors: TwentyImportRecordError[];
    /** Records with a field edited in BylineCRM after Bigin last modified them: BylineCRM's value was kept. */
    conflicts: number;
    kept: { externalId: string; fields: string[] }[];
    /**
     * Contacts edited in Bigin to hold a different person: the earlier person was left as it was (with a
     * note), a new person made for the new identity, and the link moved to them. Zero included.
     */
    reused: number;
    /** Deals whose Bigin stage the pipeline has no stage for: placed in the first open stage, the raw stage kept here. */
    unknownStages: { externalId: string; stage: string }[];
}

export interface BiginImportCreateMembers {
    roleId: string;
}

export interface BiginImportRunView {
    id: string;
    status: BiginImportRunStatus;
    mode: BiginImportMode;
    phase: BiginImportObject | null;
    report: BiginImportObjectReport[];
    error: string | null;
    /** Records that failed across every module: a run that finished with any says so. */
    failedRecords: number;
    cancelRequested: boolean;
    scheduled: boolean;
    startedBy: string | null;
    createMembers: BiginImportCreateMembers | null;
    accountsCreated: number;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

export interface BiginImportSettingsView {
    configured: boolean;
    accountsUrl: string | null;
    apiUrl: string | null;
    clientId: string | null;
    /** The refresh token's last characters, to tell tokens apart; the token and client secret are never returned. */
    refreshTokenLast4: string | null;
    configuredBy: string | null;
    updatedAt: string | null;
    createMembers: BiginImportCreateMembers | null;
}

/** The automatic sync, the same as the Twenty importer's (#185). */
export type BiginImportSyncView = TwentyImportSyncView;

export interface BiginImportOverview {
    settings: BiginImportSettingsView;
    latestRun: BiginImportRunView | null;
    linked: { object: BiginImportObject; count: number }[];
    /** Per module, the instant a `changes` run reads from; null before the module was first read through. */
    cursors: { object: BiginImportObject; since: string | null }[];
    sync: BiginImportSyncView;
}

export interface BiginImportPreview {
    checkedAt: string;
    objects: { object: BiginImportObject; remote: number | null; linked: number; error: string | null }[];
}

export interface BiginImportMissingView {
    object: BiginImportObject;
    externalId: string;
    localType: string;
    localId: string;
    name: string | null;
    missingSince: string;
}

/** A Bigin Contact reused for another person, as admins review it: who it held before and after, and when. */
export interface BiginContactReuseView {
    id: string;
    biginId: string;
    previousPersonId: string;
    newPersonId: string;
    detectedAt: string;
    before: { name: string; email: string | null };
    after: { name: string; email: string | null };
}

export function emptyBiginObjectReport(object: BiginImportObject): BiginImportObjectReport {
    return {
        object,
        remote: null,
        before: 0,
        read: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        merged: 0,
        skipped: 0,
        failed: 0,
        after: null,
        missingInSource: 0,
        errors: [],
        conflicts: 0,
        kept: [],
        unknownStages: [],
        reused: 0,
    };
}

/**
 * A Bigin record id as the links hold it: the bare number. Bigin's CSV export (and so a Twenty record
 * migrated from it, in `biginrecordid`) prefixes it with `zcrm_`; the REST API does not.
 */
export function plainBiginId(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const raw = String(value)
        .trim()
        .replace(/^zcrm_/i, '');
    return raw === '' ? null : raw;
}
