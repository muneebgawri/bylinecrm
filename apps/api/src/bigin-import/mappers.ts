import { BIGIN_IMPORT_SOURCE, plainBiginId, type BiginImportObject, type RecordTarget } from '@bylinecrm/shared';
import type { Phone } from '@bylinecrm/shared';
import type { CompanyInput } from '../records/companies.service';
import { companyDomain } from '../records/company-domain';
import { CUSTOM_TEXT_MAX } from '../records/custom-fields/custom-values';
import type { NoteInput } from '../records/notes.service';
import type { OpportunityInput } from '../records/opportunities.service';
import type { PersonInput } from '../records/people.service';
import type { TaskInput } from '../records/tasks.service';
import type { InferredCustom } from '../twenty-import/custom-fields-sync';
import { markdownToRichText } from '../twenty-import/markdown';
import {
    domainOf,
    emailOf,
    isObject,
    isoDate,
    isoDateTime,
    num,
    phoneOf,
    text,
    urlOf,
} from '../twenty-import/twenty-records';
import type { BiginRecord } from './bigin.port';

/**
 * From a Bigin record to the input one of BylineCRM's own services takes (BIGIN-1). Pure: a mapper
 * reads the record and the link index — what earlier modules of this run became — and returns the
 * input, or why the record has no place here (`skip`). The owner rides beside the input as Bigin's
 * `Owner.email`: the runner resolves it to a member and sets it on a record it creates, or on one it
 * updates that has no owner (never changing one). The services then validate and write it the way they write anything.
 */
export interface BiginLinkIndex {
    /**
     * The local record a Bigin id maps to. For a Contact Bigin reused for another person, `at` (when the
     * referring record was made in Bigin) picks the person the Contact held then.
     */
    resolve(object: BiginImportObject, biginId: unknown, at?: Date | null): string | null;
}

export interface Mapped<I> {
    input: I;
    custom: InferredCustom;
    /** Bigin's `Owner.email`, lower-cased; null when the record has none. */
    ownerEmail: string | null;
}
export interface Skip {
    skip: string;
}

export function isSkip<I>(mapped: Mapped<I> | Skip): mapped is Skip {
    return 'skip' in mapped;
}

/** The id of a polymorphic lookup (`Account_Name`, `Contact_Name`, `Parent_Id`): null, a bare id, or `{ id, name }`. */
export function lookupId(value: unknown): string | null {
    if (isObject(value)) return plainBiginId(value.id);
    return typeof value === 'string' || typeof value === 'number' ? plainBiginId(value) : null;
}

/** When Bigin made the record (`Created_Time`), or null. */
function createdAt(record: BiginRecord): Date | null {
    const raw = text(record.Created_Time);
    const at = raw ? new Date(raw) : null;
    return at && !Number.isNaN(at.getTime()) ? at : null;
}

/** Bigin's `Owner` is `{ name, id, email }`: the address, lower-cased, is how the owner is matched to a member. */
export function ownerEmailOf(record: BiginRecord): string | null {
    return isObject(record.Owner) ? emailOf(record.Owner.email) : null;
}

/** The owner's display name, as an account made for them starts with it. */
export function ownerNameOf(record: BiginRecord): string | null {
    return isObject(record.Owner) ? text(record.Owner.name) : null;
}

/** OWN-2c: a company's domain is its registrable one, the form every writer stores and matches on. */
function registrable(host: string | null): string | null {
    return host ? (companyDomain(host) ?? host) : null;
}

const EMPTY_ADDRESS = { street: null, city: null, state: null, country: null, postalCode: null };

function addressFrom(record: BiginRecord, prefix: 'Billing' | 'Mailing', postal: 'Code' | 'Zip') {
    const address = {
        street: text(record[`${prefix}_Street`]),
        city: text(record[`${prefix}_City`]),
        state: text(record[`${prefix}_State`]),
        country: text(record[`${prefix}_Country`]),
        postalCode: text(record[`${prefix}_${postal}`]),
    };
    return Object.values(address).every((v) => v === null) ? EMPTY_ADDRESS : address;
}

/**
 * Bigin's free text for a custom text field: trimmed, and cut to what a custom text value may hold
 * (`CUSTOM_TEXT_MAX`) with an ellipsis, never through a surrogate pair. Null when there is none.
 */
export function customText(value: unknown): string | null {
    const raw = text(value);
    if (!raw || raw.length <= CUSTOM_TEXT_MAX) return raw;
    let cut = raw.slice(0, CUSTOM_TEXT_MAX - 1);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return `${cut}…`;
}

/**
 * Bigin's fields that BylineCRM keeps as custom text fields, through the importer's one inference path
 * (`InferredCustom`, as `pr_link` is): an empty one is left out, so it never clears a value written here.
 */
function texts(entries: Record<string, { value: unknown; label?: string }>): InferredCustom {
    const out: InferredCustom = {};
    for (const [key, { value, label }] of Object.entries(entries)) {
        const s = customText(value);
        if (s) out[key] = { type: 'text', value: s, ...(label ? { label } : {}) };
    }
    return out;
}

export function mapAccount(record: BiginRecord): Mapped<CompanyInput & { name: string }> | Skip {
    const name = text(record.Account_Name);
    if (!name) return { skip: 'no name' };
    // A company has no phone column here: Bigin's is a custom text field, normalised when it can be read.
    const phone = readPhone(record.Phone);
    return {
        input: {
            name,
            domain: registrable(domainOf(record.Website)),
            address: addressFrom(record, 'Billing', 'Code'),
        },
        custom: texts({
            phone: { value: phone === null ? null : 'phone' in phone ? phoneText(phone) : phone.unparsed },
            description: { value: record.Description },
        }),
        ownerEmail: ownerEmailOf(record),
    };
}

/** `ext 9`, `ext. 9`, `extension 9`, `x9` at the end of a number: the digits dialled once connected. */
const EXTENSION = /\s*(?:ext\.?|extension|x)\s*(\d{1,10})\s*$/i;
/** What a number may hold besides its digits (and a leading `+`). */
const PUNCTUATION_ONLY = /^[\d\s().\-/]+$/;
/** The number part of a `Phone`, as the people API takes it. */
const PHONE_DIGITS = /^\d{3,15}$/;

/** A Bigin phone read: the `Phone` and the calling code it was written with, or the text as Bigin had it. */
export type ReadPhone = { phone: Phone; callingCode: string } | { unparsed: string };

/**
 * A Bigin phone is free text. With an international prefix (`+44 20 …`) it is kept with the country its
 * calling code implies. Without one, a number shaped like the North American plan — ten digits, or eleven
 * starting with 1, once the punctuation is gone (`(999) 999-9999`, `999.999.9999`) — is +1: the team's
 * numbers are, and the workspace has no default country to say otherwise. An extension (`ext 9`, `x9`)
 * is kept as the phone's extension. Anything else is `unparsed`: kept as Bigin wrote it, never dropped.
 */
export function readPhone(value: unknown): ReadPhone | null {
    const raw = text(value);
    if (!raw) return null;
    const ext = EXTENSION.exec(raw);
    const main = (ext ? raw.slice(0, ext.index) : raw).trim();
    const extension = ext ? { extension: ext[1]! } : {};
    const digits = main.replace(/\D/g, '');
    if (main.startsWith('+') && PUNCTUATION_ONLY.test(main.slice(1))) {
        for (const length of [1, 2, 3]) {
            const callingCode = `+${digits.slice(0, length)}`;
            const phone = phoneOf(digits.slice(length), null, callingCode);
            if (phone && PHONE_DIGITS.test(phone.number)) return { phone: { ...phone, ...extension }, callingCode };
        }
    } else if (PUNCTUATION_ONLY.test(main) && (digits.length === 10 || (digits.length === 11 && digits[0] === '1'))) {
        return { phone: { number: digits.slice(-10), countryCode: 'US', ...extension }, callingCode: '+1' };
    }
    return { unparsed: raw };
}

/** A Bigin phone as a person's `Phone`, or null when it has none or it cannot be read (`readPhone`). */
export function phoneFrom(value: unknown): Phone | null {
    const read = readPhone(value);
    return read && 'phone' in read ? read.phone : null;
}

/** A read phone as text, for a company's custom field: `+1 9999999999 ext 9`. */
function phoneText(read: Extract<ReadPhone, { phone: Phone }>): string {
    const { phone, callingCode } = read;
    return `${callingCode} ${phone.number}${phone.extension ? ` ext ${phone.extension}` : ''}`;
}

/** The label of the person custom field that keeps a phone Bigin had that could not be read. */
export const PHONE_UNPARSED_LABEL = 'Phone (as in Bigin)';

export function mapContact(record: BiginRecord, links: BiginLinkIndex): Mapped<PersonInput> | Skip {
    const first = text(record.First_Name) ?? '';
    const last = text(record.Last_Name) ?? '';
    const primary = emailOf(record.Email);
    if (!first && !last && !primary) return { skip: 'no name and no email' };
    const secondary = emailOf(record.Secondary_Email);
    const read = { Phone: readPhone(record.Phone), Mobile: readPhone(record.Mobile) };
    const phones = Object.values(read).flatMap((r) => (r && 'phone' in r ? [r.phone] : []));
    // A number that cannot be read is kept as Bigin wrote it; none (any more) clears that copy.
    const unparsed = Object.entries(read).flatMap(([field, r]) =>
        r && 'unparsed' in r ? [`${field}: ${r.unparsed}`] : [],
    );
    const prLink = urlOf(record.PR_LINK);
    return {
        input: {
            nameFirst: first,
            nameLast: last,
            emails: { primary, additional: secondary && secondary !== primary ? [secondary] : [] },
            phones: { primary: phones[0] ?? null, additional: phones.slice(1) },
            jobTitle: text(record.Title),
            city: text(record.Mailing_City),
            companyId: links.resolve('Accounts', lookupId(record.Account_Name)),
            source: BIGIN_IMPORT_SOURCE,
        },
        custom: {
            ...(prLink ? { pr_link: { type: 'url', value: prLink } } : {}),
            ...texts({ description: { value: record.Description } }),
            phone_unparsed:
                unparsed.length > 0
                    ? { type: 'text', value: customText(unparsed.join('; '))!, label: PHONE_UNPARSED_LABEL }
                    : null,
        },
        ownerEmail: ownerEmailOf(record),
    };
}

export interface MappedDeal extends Mapped<OpportunityInput & { name: string }> {
    /** Bigin's `Stage`, as written; the runner places it in the pipeline by name. */
    stage: string | null;
}

export function mapDeal(record: BiginRecord, links: BiginLinkIndex, currency: string): MappedDeal | Skip {
    const name = text(record.Deal_Name);
    if (!name) return { skip: 'no name' };
    const amount = num(record.Amount);
    return {
        input: {
            name,
            amount: amount === null ? null : { amountMinor: Math.round(amount * 100), currency },
            closeDate: isoDate(record.Closing_Date),
            companyId: links.resolve('Accounts', lookupId(record.Account_Name)),
            pointOfContactId: links.resolve('Contacts', lookupId(record.Contact_Name), createdAt(record)),
        },
        custom: texts({
            description: { value: record.Description },
            press_release_title: { value: record.Title_of_Press_Release, label: 'Press release title' },
        }),
        ownerEmail: ownerEmailOf(record),
        stage: text(record.Stage),
    };
}

/** Bigin's `$se_module` of a note's parent, to the module its id is linked under. */
const PARENT_MODULE: Readonly<Record<string, BiginImportObject>> = {
    Contacts: 'Contacts',
    Accounts: 'Accounts',
    Deals: 'Deals',
    Potentials: 'Deals',
    Pipelines: 'Deals',
};
const TARGET_TYPE: Readonly<Record<BiginImportObject, RecordTarget['type'] | null>> = {
    Accounts: 'company',
    Contacts: 'person',
    Deals: 'opportunity',
    Notes: null,
    Tasks: null,
    Events: null,
    Calls: null,
};

/**
 * The modules a note's parent (or an activity's related record) may be in. `$se_module` says so on v1 — a
 * task's `Related_To` says it as `$related_module` — v2 (a pass paged by token) never returns `$` fields, so
 * the lookup's own `module` is read, and without either every module a record sits on is tried — Bigin's
 * record ids are unique across modules, so at most one resolves.
 */
function parentModulesOf(record: BiginRecord, field = 'Parent_Id'): BiginImportObject[] {
    const named = (field === 'Related_To' ? text(record.$related_module) : null) ?? text(record.$se_module);
    if (named) return PARENT_MODULE[named] ? [PARENT_MODULE[named]] : [];
    const parent = record[field];
    const module = isObject(parent) ? parent.module : undefined;
    const apiName = isObject(module) ? text(module.api_name) : text(module);
    if (apiName) return PARENT_MODULE[apiName] ? [PARENT_MODULE[apiName]] : [];
    return ['Contacts', 'Accounts', 'Deals'];
}

export function mapNote(
    record: BiginRecord,
    links: BiginLinkIndex,
): Mapped<NoteInput & { targets: RecordTarget[] }> | Skip {
    const body = text(record.Note_Content);
    if (!body) return { skip: 'no content' };
    let target: RecordTarget | null = null;
    for (const module of parentModulesOf(record)) {
        const type = TARGET_TYPE[module];
        const id = links.resolve(module, lookupId(record.Parent_Id), createdAt(record));
        if (type && id) {
            target = { type, id } as RecordTarget;
            break;
        }
    }
    if (!target) return { skip: SKIP_NO_RECORD };
    return {
        input: {
            title: text(record.Note_Title) ?? '',
            body: markdownToRichText(body),
            targets: [target],
        },
        custom: {},
        ownerEmail: ownerEmailOf(record),
    };
}

const SKIP_NO_RECORD = 'its record is not in BylineCRM';

/**
 * Bigin's lookups from an activity (a task, event or call) to its record: `What_Id`, or `Related_To` — how a
 * task answers the `What_Id` it was asked for (with `$related_module`), and how an event names its record.
 */
const RELATED_FIELDS = ['What_Id', 'Related_To'] as const;

/**
 * The records a Bigin activity is about, as the links resolve them: its related record (`Related_To` in the
 * module `$related_module` names, or `What_Id` in the module `$se_module` names) and its contact (`Who_Id`).
 * None when none is here.
 */
function activityTargets(record: BiginRecord, links: BiginLinkIndex): RecordTarget[] {
    const targets: RecordTarget[] = [];
    const add = (module: BiginImportObject, value: unknown): boolean => {
        const type = TARGET_TYPE[module];
        const id = links.resolve(module, lookupId(value), createdAt(record));
        if (!type || !id) return false;
        if (!targets.some((t) => t.type === type && t.id === id)) targets.push({ type, id } as RecordTarget);
        return true;
    };
    for (const field of RELATED_FIELDS) {
        if (!lookupId(record[field])) continue;
        for (const module of parentModulesOf(record, field)) if (add(module, record[field])) break;
    }
    add('Contacts', record.Who_Id);
    return targets;
}

/** The ids an activity refers to: what the links must hold before its page is mapped. */
function activityReferences(record: BiginRecord): { object: BiginImportObject; id: string }[] {
    const refs: { object: BiginImportObject; id: string }[] = [];
    for (const field of RELATED_FIELDS) {
        const id = lookupId(record[field]);
        if (id) for (const module of parentModulesOf(record, field)) refs.push({ object: module, id });
    }
    const who = lookupId(record.Who_Id);
    if (who) refs.push({ object: 'Contacts', id: who });
    return refs;
}

/** What a Bigin task, event or call becomes: a task, on the records it is about. */
export type BiginTaskInput = TaskInput & { title: string; targets: RecordTarget[] };

/** A task's title holds at most this much (the tasks API's limit). */
const TITLE_MAX = 300;

function titled(title: string): string {
    return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1)}…`;
}

/** A body from Bigin's description and the details a task here has no field for, a paragraph each. */
function bodyFrom(description: unknown, details: Record<string, unknown>) {
    const lines = Object.entries(details).flatMap(([label, value]) => {
        const s = typeof value === 'number' ? String(value) : text(value);
        return s ? [`${label}: ${s}`] : [];
    });
    const parts = [text(description), ...lines].filter((p): p is string => p !== null);
    return markdownToRichText(parts.join('\n\n'));
}

/** A Bigin due date (`YYYY-MM-DD`) as the instant a task is due: midnight UTC, as a deal's follow-up date is. */
function dueOf(value: unknown): string | null {
    const instant = isoDateTime(value);
    if (instant) return instant;
    const date = isoDate(value);
    return date ? `${date}T00:00:00.000Z` : null;
}

/** Bigin's task `Status`: Completed is done, In Progress (either spelling) in progress, anything else to do. */
export function taskStatusOf(value: unknown): NonNullable<TaskInput['status']> {
    const status = (text(value) ?? '').toLowerCase().replace(/[\s_-]+/g, ' ');
    if (status === 'completed') return 'done';
    if (status === 'in progress') return 'in_progress';
    return 'todo';
}

/**
 * A Bigin Task: `Subject` its title, `Description` (and `Priority`, which tasks here do not have) its body,
 * `Status` (`taskStatusOf`) — done at `Closed_Time` — and `Due_Date`. The owner is its assignee. A task about
 * no record here is skipped, as a note is: a task here is always on a record.
 */
export function mapTask(record: BiginRecord, links: BiginLinkIndex): Mapped<BiginTaskInput> | Skip {
    const targets = activityTargets(record, links);
    if (targets.length === 0) return { skip: SKIP_NO_RECORD };
    const status = taskStatusOf(record.Status);
    return {
        input: {
            title: titled(text(record.Subject) ?? '(untitled)'),
            body: bodyFrom(record.Description, { Priority: record.Priority }),
            status,
            dueAt: dueOf(record.Due_Date),
            completedAt: status === 'done' ? isoDateTime(record.Closed_Time) : null,
            targets,
        },
        custom: {},
        ownerEmail: ownerEmailOf(record),
    };
}

/**
 * A Bigin Event: a task `Meeting: <Event_Title>` due at its start, done (at its end) once it has ended,
 * `Description` and `Venue` its body. On the record it is related to (`Related_To`/`What_Id`, `Who_Id`).
 */
export function mapEvent(record: BiginRecord, links: BiginLinkIndex, now = new Date()): Mapped<BiginTaskInput> | Skip {
    const targets = activityTargets(record, links);
    if (targets.length === 0) return { skip: SKIP_NO_RECORD };
    const end = isoDateTime(record.End_DateTime);
    const ended = end !== null && new Date(end) < now;
    return {
        input: {
            title: titled(`Meeting: ${text(record.Event_Title) ?? '(untitled)'}`),
            body: bodyFrom(record.Description, { Venue: record.Venue }),
            status: ended ? 'done' : 'todo',
            dueAt: dueOf(record.Start_DateTime),
            completedAt: ended ? end : null,
            targets,
        },
        custom: {},
        ownerEmail: ownerEmailOf(record),
    };
}

/**
 * A Bigin Call: a done task `Call: <Subject>` at its start time, its `Description` and what a task here has
 * no field for — type, purpose, result, duration — its body. On the record it is about (`What_Id`, `Who_Id`).
 */
export function mapCall(record: BiginRecord, links: BiginLinkIndex): Mapped<BiginTaskInput> | Skip {
    const targets = activityTargets(record, links);
    if (targets.length === 0) return { skip: SKIP_NO_RECORD };
    const start = isoDateTime(record.Call_Start_Time);
    return {
        input: {
            title: titled(`Call: ${text(record.Subject) ?? '(untitled)'}`),
            body: bodyFrom(record.Description, {
                Type: record.Call_Type,
                Purpose: record.Call_Purpose,
                Result: record.Call_Result,
                Duration: record.Call_Duration,
            }),
            status: 'done',
            dueAt: start,
            completedAt: start,
            targets,
        },
        custom: {},
        ownerEmail: ownerEmailOf(record),
    };
}

/** The Bigin ids a record refers to, by module: what the links must hold before the page is mapped. */
export function referencesOf(
    object: BiginImportObject,
    record: BiginRecord,
): { object: BiginImportObject; id: string }[] {
    const refs: { object: BiginImportObject; id: string }[] = [];
    const own = plainBiginId(record.id);
    if (own) refs.push({ object, id: own });
    const add = (target: BiginImportObject, value: unknown) => {
        const id = lookupId(value);
        if (id) refs.push({ object: target, id });
    };
    switch (object) {
        case 'Contacts':
            add('Accounts', record.Account_Name);
            break;
        case 'Deals':
            add('Accounts', record.Account_Name);
            add('Contacts', record.Contact_Name);
            break;
        case 'Notes': {
            for (const module of parentModulesOf(record)) add(module, record.Parent_Id);
            break;
        }
        case 'Tasks':
        case 'Events':
        case 'Calls':
            refs.push(...activityReferences(record));
            break;
        default:
            break;
    }
    return refs;
}
