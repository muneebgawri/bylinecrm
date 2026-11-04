import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BIGIN_PAGE_SIZE, plainBiginId, type BiginHistoryPhase, type BiginImportObject } from '@bylinecrm/shared';
import { BIGIN_MAPPED_FIELDS } from './bigin-import.constants';
import { readCsvFile } from './csv';
import type {
    BiginApi,
    BiginConnection,
    BiginDeletedPage,
    BiginField,
    BiginHistorySource,
    BiginListOptions,
    BiginModule,
    BiginPage,
    BiginRecord,
} from './bigin.port';

/**
 * A Bigin backup export (Bigin's Data Backup: a zip of `Data/*.csv` and `Metadata/*`) read as the REST API would
 * answer (BIGIN-1). Each CSV row becomes the record the API returns for it — Bigin's API field names, lookups as
 * `{ id }`, the owner as `{ id, name, email }` from the export's users, timestamps as ISO instants with their
 * offset — so the importer's runner, mappers and links take an export exactly as they take the API: one importer,
 * two sources. A module is read whole (from its files in order), sorted oldest modification first as the API pages
 * it, and paged the way the runner asks. The export also carries what the API never served — each deal's stage
 * history and the emails logged on records — read as history (`BiginHistorySource`) after the modules.
 */

/** Each module's files in `Data/`: `<prefix>_001.csv`, `<prefix>_002.csv`, … read in that order. */
const FILE_PREFIX: Readonly<Record<BiginImportObject | BiginHistoryPhase, string>> = {
    Accounts: 'Companies',
    Contacts: 'Contacts',
    Deals: 'Pipelines',
    Notes: 'Notes',
    Tasks: 'Tasks',
    Events: 'Events',
    Calls: 'Calls',
    StageHistory: 'Stage History',
    Emails: 'Emails',
};

/**
 * The export's column labels whose API name is not the label with its spaces as underscores. Bigin's screens (and
 * so its export) name Accounts "Companies" and Deals "Pipelines"; the API keeps Zoho CRM's names. A lookup column
 * is labelled `<label>.id`; an owner column `<Module> Owner.id` (Events: `Host.id`) is the API's `Owner`. Tasks,
 * Events and Calls name their record `Related To` without its module: as `What_Id` with no `$se_module`, the
 * mappers try each module (Bigin's ids are unique across modules).
 */
export const BIGIN_EXPORT_RENAMES: Readonly<Record<BiginImportObject | BiginHistoryPhase, Record<string, string>>> = {
    Accounts: { 'Company Name': 'Account_Name', 'Parent Company.id': 'Parent_Account' },
    Contacts: { 'Company Name.id': 'Account_Name', 'PR LINK': 'PR_LINK' },
    Deals: { 'Pipeline Name': 'Deal_Name', 'Company Name.id': 'Account_Name' },
    Notes: { 'Parent.id': 'Parent_Id', 'Parent Id.Module': '$se_module' },
    Tasks: { 'Contact Name.id': 'Who_Id', 'Related To.id': 'What_Id' },
    Events: {
        'Host.id': 'Owner',
        Title: 'Event_Title',
        Location: 'Venue',
        From: 'Start_DateTime',
        To: 'End_DateTime',
        'Contact Name.id': 'Who_Id',
        'Related To.id': 'What_Id',
    },
    Calls: { 'Contact Name.id': 'Who_Id', 'Related To.id': 'What_Id' },
    StageHistory: { 'Pipeline Name.id': 'Deal' },
    Emails: { 'Record Name.id': 'Record' },
};

/**
 * The fields a record keeps: what the importer reads, as it asks the API's v2 for them (`BIGIN_MAPPED_FIELDS`), and
 * the times every pass reads. An export row holds every column of the module (Contacts: 72): kept whole, a module
 * of 100,000 rows would not fit a container's memory.
 */
const KEPT_FIELDS: Readonly<Record<BiginImportObject | BiginHistoryPhase, ReadonlySet<string>>> = (() => {
    const common = ['Created_Time', 'Modified_Time', '$se_module'];
    const history: Record<BiginHistoryPhase, string[]> = {
        StageHistory: ['Deal', 'Stage', 'Moved_To'],
        Emails: [
            'Sent_By',
            'Subject',
            'Record',
            'Module',
            'Sent_To',
            'Sent_On',
            'Status',
            'Cc',
            'Sender',
            'No_of_Opens',
            'No_of_Clicks',
        ],
    };
    return Object.fromEntries(
        (Object.keys(FILE_PREFIX) as (BiginImportObject | BiginHistoryPhase)[]).map((module) => [
            module,
            new Set([
                ...common,
                ...(BIGIN_MAPPED_FIELDS[module] ?? []),
                ...(history[module as BiginHistoryPhase] ?? []),
            ]),
        ]),
    ) as unknown as Record<BiginImportObject | BiginHistoryPhase, ReadonlySet<string>>;
})();

/** Lookups to a user: read as the API gives an owner, `{ id, name, email }`. */
const USER_FIELDS = new Set(['Owner', 'Created_By', 'Modified_By', 'Sent_By']);
/** Number fields: the export writes `650.0`, the API a number. */
const NUMBER_FIELDS = new Set(['Amount', 'No_of_Opens', 'No_of_Clicks']);
/** The export's timestamp: local time in the backup's time zone, no offset. */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

export interface BiginExportUser {
    name: string | null;
    email: string | null;
}

export interface ExportRowContext {
    users: ReadonlyMap<string, BiginExportUser>;
    timeZone: string;
}

/** A label as its API name: `Call Duration (in seconds)` → `Call_Duration_in_seconds`, `No. of Opens` → `No_of_Opens`. */
export function apiNameOf(module: BiginImportObject | BiginHistoryPhase, label: string): string {
    const renamed = BIGIN_EXPORT_RENAMES[module][label];
    if (renamed) return renamed;
    const bare = label.endsWith('.id') ? label.slice(0, -3) : label;
    if (label.endsWith('.id') && / Owner$/.test(bare)) return 'Owner';
    return bare
        .replace(/[^A-Za-z0-9$]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
}

/**
 * One export row as the record the API returns, with the fields the importer reads (`KEPT_FIELDS`): empty cells left
 * out, as a field the API returns empty reads.
 */
export function recordFromRow(
    module: BiginImportObject | BiginHistoryPhase,
    row: Readonly<Record<string, string>>,
    context: ExportRowContext,
): BiginRecord {
    const record: BiginRecord = { id: plainBiginId(row['Record Id']) ?? '' };
    for (const [label, raw] of Object.entries(row)) {
        if (label === 'Record Id' || raw === '') continue;
        const field = apiNameOf(module, label);
        if (!KEPT_FIELDS[module].has(field)) continue;
        if (label.endsWith('.id')) {
            const id = plainBiginId(raw);
            if (!id) continue;
            const user = USER_FIELDS.has(field) ? context.users.get(id) : undefined;
            record[field] = user ? { id, name: user.name, email: user.email } : { id };
            continue;
        }
        record[field] = valueOf(field, raw, context.timeZone);
    }
    return record;
}

function valueOf(field: string, raw: string, timeZone: string): unknown {
    if (LOCAL_DATE_TIME.test(raw)) return zonedIso(raw, timeZone);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (NUMBER_FIELDS.has(field)) {
        const n = Number(raw);
        return Number.isFinite(n) ? n : raw;
    }
    return raw;
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();
/** Offsets already worked out, by zone and local hour: a zone's offset changes on the hour, never inside one. */
const offsetsByHour = new Map<string, number>();

/** The zone's offset from UTC at an instant, in minutes. */
function offsetAt(instant: number, timeZone: string): number {
    let format = offsetFormats.get(timeZone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        offsetFormats.set(timeZone, format);
    }
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
    const local = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
    );
    return Math.round((local - Math.floor(instant / 1000) * 1000) / 60_000);
}

/**
 * `2026-05-02 22:54:16`, local time in `timeZone`, as the API writes an instant: `2026-05-02T22:54:16+05:00`. A
 * local time a change of clocks skipped takes the offset after it; one it repeated, the earlier.
 */
export function zonedIso(local: string, timeZone: string): string {
    const m = LOCAL_DATE_TIME.exec(local);
    if (!m) throw new Error(`not a Bigin export timestamp: ${local}`);
    const key = `${timeZone} ${local.slice(0, 13)}`;
    let offset = offsetsByHour.get(key);
    if (offset === undefined) {
        const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
        offset = offsetAt(asUtc - offsetAt(asUtc, timeZone) * 60_000, timeZone);
        offsetsByHour.set(key, offset);
    }
    const sign = offset < 0 ? '-' : '+';
    const abs = Math.abs(offset);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `${local.slice(0, 10)}T${local.slice(11)}${sign}${hh}:${mm}`;
}

/** The instant of a record's timestamp, for sorting; 0 when it has none. */
function at(value: unknown): number {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isNaN(ms) ? 0 : ms;
}

/** Sorts by a time field, then id — each time parsed once, not once per comparison. */
function sortByTime(records: BiginRecord[], field: string): void {
    const keys = new Map(records.map((r) => [r, at(r[field])]));
    records.sort((a, b) => keys.get(a)! - keys.get(b)! || compareIds(a, b));
}

/** The backup's own settings (`Metadata/BackupDetails.properties`): `TIMEZONE` is the zone its times are in. */
function backupTimeZone(root: string): string | null {
    const file = join(root, 'Metadata', 'BackupDetails.properties');
    if (!existsSync(file)) return null;
    const line = readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .find((l) => l.startsWith('TIMEZONE='));
    return line ? line.slice('TIMEZONE='.length).trim() || null : null;
}

export interface BiginExportOptions {
    /** The zone the export's times are in; by default the backup's own (`BackupDetails.properties`). */
    timeZone?: string | undefined;
}

export class BiginExport implements BiginApi, BiginHistorySource {
    /** The one module held in memory: the runner reads a module through before the next. */
    private loaded: { module: BiginImportObject | BiginHistoryPhase; records: BiginRecord[] } | null = null;

    private constructor(
        private readonly data: string,
        readonly timeZone: string,
        private readonly users: ReadonlyMap<string, BiginExportUser>,
    ) {}

    /**
     * Opens an extracted export: the directory holding `Data/` (and `Metadata/`), or `Data/` itself. Fails here —
     * before any run starts — when it is not one, or its time zone is unknown.
     */
    static async open(dir: string, options: BiginExportOptions = {}): Promise<BiginExport> {
        const root = existsSync(join(dir, 'Data')) ? dir : join(dir, '..');
        const data = join(root, 'Data');
        if (!existsSync(data) || !statSync(data).isDirectory()) throw new Error(`${dir} holds no Bigin export (Data/)`);
        const timeZone = options.timeZone ?? backupTimeZone(root);
        if (!timeZone) throw new Error('the export names no time zone (Metadata/BackupDetails.properties): pass one');
        // Throws a RangeError for a zone the runtime does not know.
        new Intl.DateTimeFormat('en-US', { timeZone });
        const users = new Map<string, BiginExportUser>();
        for (const file of filesOf(data, 'Users')) {
            for await (const row of readCsvFile(file)) {
                const id = plainBiginId(row['Record Id']);
                if (!id) continue;
                const name = [row['First Name'], row['Last Name']].filter((p) => p && p.trim()).join(' ');
                users.set(id, { name: name || null, email: row.Email?.trim() || null });
            }
        }
        return new BiginExport(data, timeZone, users);
    }

    /** Bigin's `If-Modified-Since` and its pages, over the module sorted as the API sorts it. */
    async list(_connection: BiginConnection, module: BiginImportObject, options: BiginListOptions): Promise<BiginPage> {
        const records = await this.load(module);
        let start: number;
        if (options.byToken) {
            // v2's tokens page from the oldest record, whatever the window (the runner passes over what is older).
            start = options.pageToken ? Number(options.pageToken) : 0;
        } else {
            const since = options.since ? Date.parse(options.since) : null;
            start = since === null ? 0 : firstAtOrAfter(records, since);
            start += (options.page - 1) * BIGIN_PAGE_SIZE;
        }
        const end = Math.min(start + BIGIN_PAGE_SIZE, records.length);
        const more = end < records.length;
        return {
            records: records.slice(start, end),
            moreRecords: more,
            nextPageToken: options.byToken && more ? String(end) : null,
        };
    }

    /** An export is a snapshot: what Bigin deleted is simply not in it, so nothing is listed as deleted. */
    deleted(): Promise<BiginDeletedPage> {
        return Promise.resolve({ records: [], moreRecords: false });
    }

    async count(_connection: BiginConnection, module: BiginImportObject | string): Promise<number | null> {
        if (!(module in FILE_PREFIX)) return null;
        return (await this.load(module as BiginImportObject)).length;
    }

    /**
     * A page of history, in a fixed order. Stage history is grouped by deal, oldest move first, and each row carries
     * the stage the deal left (`Previous_Stage`, null for the stage it started in): a row says only the stage it
     * entered (`Stage`) and, once it moved on, where to (`Moved_To`).
     */
    async history(phase: BiginHistoryPhase, page: number): Promise<BiginPage & { total: number }> {
        const records = await this.load(phase);
        const start = (page - 1) * BIGIN_PAGE_SIZE;
        const end = Math.min(start + BIGIN_PAGE_SIZE, records.length);
        return { records: records.slice(start, end), moreRecords: end < records.length, total: records.length };
    }

    search(): Promise<BiginPage> {
        return notInExport('search');
    }
    modules(): Promise<BiginModule[]> {
        return notInExport('modules');
    }
    fieldDefinitions(): Promise<BiginField[]> {
        return notInExport('field definitions');
    }
    dealStages(): Promise<string[] | null> {
        return notInExport('the stage picklist');
    }
    exchangeGrantCode(): Promise<string> {
        return notInExport('OAuth');
    }

    private async load(module: BiginImportObject | BiginHistoryPhase): Promise<BiginRecord[]> {
        if (this.loaded?.module === module) return this.loaded.records;
        this.loaded = null;
        const context = { users: this.users, timeZone: this.timeZone };
        const records: BiginRecord[] = [];
        for (const file of filesOf(this.data, FILE_PREFIX[module])) {
            for await (const row of readCsvFile(file)) {
                const record = recordFromRow(module, row, context);
                if (record.id) records.push(record);
            }
        }
        if (module === 'StageHistory') withPreviousStages(records);
        else sortByTime(records, module === 'Emails' ? 'Sent_On' : 'Modified_Time');
        this.loaded = { module, records };
        return records;
    }
}

const compareIds = (a: BiginRecord, b: BiginRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Sorts stage history by deal then time, and gives each row the stage its deal was in before it. */
export function withPreviousStages(records: BiginRecord[]): void {
    const dealOf = (r: BiginRecord) => (r.Deal as { id?: string } | undefined)?.id ?? '';
    sortByTime(records, 'Modified_Time');
    // Stable: within a deal, the rows stay in time order.
    records.sort((a, b) => (dealOf(a) < dealOf(b) ? -1 : dealOf(a) > dealOf(b) ? 1 : 0));
    let previous: BiginRecord | null = null;
    for (const record of records) {
        const same = previous !== null && dealOf(previous) === dealOf(record);
        record.Previous_Stage = same ? (previous!.Stage ?? null) : null;
        previous = record;
    }
}

/** The first record modified at or after `since` (the list is sorted by modification). */
function firstAtOrAfter(records: readonly BiginRecord[], since: number): number {
    let lo = 0;
    let hi = records.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (at(records[mid]!.Modified_Time) < since) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** `<prefix>_001.csv`, `<prefix>_002.csv`, … in `Data/`, in order. */
function filesOf(data: string, prefix: string): string[] {
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)\\.csv$`);
    return readdirSync(data)
        .map((name) => ({ name, n: pattern.exec(name)?.[1] }))
        .filter((f): f is { name: string; n: string } => f.n !== undefined)
        .sort((a, b) => Number(a.n) - Number(b.n))
        .map((f) => join(data, f.name));
}

function notInExport(what: string): Promise<never> {
    return Promise.reject(new Error(`${what} is not available from a Bigin export`));
}
