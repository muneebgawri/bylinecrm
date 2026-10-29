import { BIGIN_IMPORT_SOURCE, plainBiginId, type BiginImportObject, type RecordTarget } from '@bylinecrm/shared';
import type { Phone } from '@bylinecrm/shared';
import type { CompanyInput } from '../records/companies.service';
import { companyDomain } from '../records/company-domain';
import type { NoteInput } from '../records/notes.service';
import type { OpportunityInput } from '../records/opportunities.service';
import type { PersonInput } from '../records/people.service';
import type { InferredCustom } from '../twenty-import/custom-fields-sync';
import { markdownToRichText } from '../twenty-import/markdown';
import { domainOf, emailOf, isObject, isoDate, num, phoneOf, text, urlOf } from '../twenty-import/twenty-records';
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

export function mapAccount(record: BiginRecord): Mapped<CompanyInput & { name: string }> | Skip {
    const name = text(record.Account_Name);
    if (!name) return { skip: 'no name' };
    return {
        input: {
            name,
            domain: registrable(domainOf(record.Website)),
            address: addressFrom(record, 'Billing', 'Code'),
        },
        custom: {},
        ownerEmail: ownerEmailOf(record),
    };
}

/**
 * A Bigin phone is free text. With an international prefix (`+44 20 …`) it is kept with the country its
 * calling code implies; without one there is no country to give it, and it is left out.
 */
export function phoneFrom(value: unknown): Phone | null {
    const raw = text(value);
    if (!raw || !raw.startsWith('+')) return null;
    const digits = raw.replace(/[^\d]/g, '');
    for (const length of [1, 2, 3]) {
        const phone = phoneOf(digits.slice(length), null, `+${digits.slice(0, length)}`);
        if (phone && phone.number) return phone;
    }
    return null;
}

export function mapContact(record: BiginRecord, links: BiginLinkIndex): Mapped<PersonInput> | Skip {
    const first = text(record.First_Name) ?? '';
    const last = text(record.Last_Name) ?? '';
    const primary = emailOf(record.Email);
    if (!first && !last && !primary) return { skip: 'no name and no email' };
    const secondary = emailOf(record.Secondary_Email);
    const phones = [phoneFrom(record.Phone), phoneFrom(record.Mobile)].filter((p): p is Phone => p !== null);
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
        custom: prLink ? { pr_link: { type: 'url', value: prLink } } : {},
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
        custom: {},
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
};

/**
 * The modules a note's parent may be in. `$se_module` says so on v1; v2 (a pass paged by token) never
 * returns `$` fields, so its `Parent_Id.module` is read, and without either every module a note sits on is
 * tried — Bigin's record ids are unique across modules, so at most one resolves.
 */
function parentModulesOf(record: BiginRecord): BiginImportObject[] {
    const named = text(record.$se_module);
    if (named) return PARENT_MODULE[named] ? [PARENT_MODULE[named]] : [];
    const parent = record.Parent_Id;
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
    if (!target) return { skip: 'its record is not in BylineCRM' };
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
        default:
            break;
    }
    return refs;
}
