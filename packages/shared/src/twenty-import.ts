/**
 * The Twenty importer (P4-4, doc 48 §11): what the API, the web app and the tests share. A
 * workspace that moves off Twenty points the importer at its Twenty workspace's REST API; the
 * importer reads every object below, maps each record by its Twenty id (so a run can be repeated
 * and only writes what changed) and reports, per object, what Twenty holds and what the run did.
 * Why each mapping is what it is: docs/design-notes/P4-4.md.
 */

/**
 * The Twenty objects the importer reads, in the order it reads them (a later one refers to earlier
 * ones). Not read, by ruling (D-252): `journalists` — journalist outreach is a different activity from
 * customer outreach and is deferred, so Twenty keeps that data — and `leadLookupRequests`, Lead Engine's
 * audit log, which is not CRM history.
 */
export const TWENTY_IMPORT_OBJECTS = [
    'workspaceMembers',
    'companies',
    'people',
    'opportunities',
    'notes',
    'tasks',
    'leadLookups',
    'leadViews',
    'messageLists',
    'messageListMembers',
    'messageCampaigns',
] as const;
export type TwentyImportObject = (typeof TWENTY_IMPORT_OBJECTS)[number];

export function isTwentyImportObject(value: unknown): value is TwentyImportObject {
    return typeof value === 'string' && (TWENTY_IMPORT_OBJECTS as readonly string[]).includes(value);
}

/** How the importer screen names each object, and where its records land in BylineCRM. */
export const TWENTY_IMPORT_OBJECT_LABELS: Readonly<Record<TwentyImportObject, { label: string; lands: string }>> = {
    workspaceMembers: { label: 'Owners', lands: 'Members, matched by email' },
    companies: { label: 'Companies', lands: 'Companies' },
    people: { label: 'People', lands: 'People' },
    opportunities: { label: 'Opportunities', lands: 'Deals in the default pipeline' },
    notes: { label: 'Notes', lands: 'Notes on their records' },
    tasks: { label: 'Tasks', lands: 'Tasks on their records' },
    leadLookups: { label: 'Lead lookups', lands: 'Outreach exclusions (account-managed)' },
    leadViews: { label: 'Lead views', lands: 'People (lead fields)' },
    messageLists: { label: 'Message lists', lands: 'The "Lists" field on people, and a shared view each' },
    messageListMembers: { label: 'List members', lands: 'People (list membership)' },
    messageCampaigns: { label: 'Campaigns', lands: 'Outreach templates' },
};

export const TWENTY_IMPORT_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type TwentyImportRunStatus = (typeof TWENTY_IMPORT_RUN_STATUSES)[number];

/** A run reads everything (`full`), or only what Twenty changed since the last successful run (`changes`). */
/**
 * `full` reads everything; `changes` what Twenty updated since the last successful run; `reconcile`
 * (#156, D-252) writes no record — it reads every id Twenty still returns and flags the mapped records
 * it no longer does as *missing in source*, for a person to review. Nothing is ever deleted on its own.
 */
export const TWENTY_IMPORT_MODES = ['full', 'changes', 'reconcile'] as const;
export type TwentyImportMode = (typeof TWENTY_IMPORT_MODES)[number];

/** `people.source` of an imported person, and `outreach_exclusions.source` of an imported lead lookup. */
export const TWENTY_IMPORT_SOURCE = 'twenty';
/** The person custom field that carries message-list membership, and the name a list's shared view takes. */
export const TWENTY_LISTS_FIELD_KEY = 'lists';
export const TWENTY_LIST_VIEW_PREFIX = 'List: ';
/** How many per-record errors a run keeps per object; the count keeps counting. */
export const TWENTY_IMPORT_ERRORS_KEPT = 25;
/** The longest a thrown error's line is kept in a report entry (#168): a client's message quotes the whole call. */
export const TWENTY_IMPORT_ERROR_MESSAGE_MAX = 300;
/** Twenty's REST page ceiling. */
export const TWENTY_PAGE_SIZE = 60;

export interface TwentyImportRecordError {
    externalId: string;
    message: string;
}

/**
 * What one run did with one object. `before` and `after` count the Twenty records of this object
 * that are mapped to something in BylineCRM (the links) when the object's pass started and ended;
 * `remote` is Twenty's own count at the start of the pass. The outcomes sum to the records read:
 * `created` + `updated` + `unchanged` + `merged` + `skipped` + `failed`.
 */
export interface TwentyImportObjectReport {
    object: TwentyImportObject;
    remote: number | null;
    before: number;
    read: number;
    created: number;
    updated: number;
    unchanged: number;
    /** Matched an existing record by its unique key (a person's email, a company's domain) and linked to it. */
    merged: number;
    /** Nothing in BylineCRM to hold it (a note on a lead lookup, an owner with no member): counted, not written. */
    skipped: number;
    failed: number;
    after: number | null;
    /** A `reconcile` pass: mapped records of this object Twenty no longer returns; null for any other pass. */
    missingInSource: number | null;
    errors: TwentyImportRecordError[];
}

export interface TwentyImportRunView {
    id: string;
    status: TwentyImportRunStatus;
    mode: TwentyImportMode;
    /** `changes` mode: records Twenty updated at or after this instant were read. */
    since: string | null;
    /** The object being read now, while running. */
    phase: TwentyImportObject | null;
    report: TwentyImportObjectReport[];
    error: string | null;
    cancelRequested: boolean;
    startedBy: string | null;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

export interface TwentyImportSettingsView {
    configured: boolean;
    baseUrl: string | null;
    apiKeyLast4: string | null;
    configuredBy: string | null;
    updatedAt: string | null;
}

/** What the importer screen opens on: the connection, the latest run, and what is mapped so far. */
export interface TwentyImportOverview {
    settings: TwentyImportSettingsView;
    latestRun: TwentyImportRunView | null;
    linked: { object: TwentyImportObject; count: number }[];
}

/** Twenty's counts per object, read now, beside what is mapped already: the "before" of a run. */
export interface TwentyImportPreview {
    checkedAt: string;
    objects: { object: TwentyImportObject; remote: number | null; linked: number; error: string | null }[];
}

export function emptyObjectReport(object: TwentyImportObject): TwentyImportObjectReport {
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
        missingInSource: null,
        errors: [],
    };
}

/** A mapped record Twenty no longer returns (#156): which link, what it maps to here, since when. */
export interface TwentyImportMissingView {
    object: TwentyImportObject;
    externalId: string;
    localType: string;
    localId: string;
    /** The local record's name (or the link's label), for the review list. */
    name: string | null;
    missingSince: string;
}
