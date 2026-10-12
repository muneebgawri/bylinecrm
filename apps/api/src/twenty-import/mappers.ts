import { TWENTY_IMPORT_SOURCE, type RecordTarget, type StageKind, type TwentyImportObject } from '@bylinecrm/shared';
import type { CompanyInput } from '../records/companies.service';
import type { NoteInput } from '../records/notes.service';
import type { OpportunityInput } from '../records/opportunities.service';
import type { PersonInput } from '../records/people.service';
import type { TaskInput } from '../records/tasks.service';
import type { TemplateInput } from '../templates/templates.service';
import { inferCustomValues, type InferredCustom } from './custom-fields-sync';
import type { LinkIndex } from './links';
import { markdownToRichText } from './markdown';
import {
    addressOf,
    emailOf,
    emailsOf,
    humanise,
    idOf,
    isObject,
    isoDate,
    isoDateTime,
    linkOf,
    moneyOf,
    nameOf,
    phoneOf,
    phonesOf,
    text,
} from './twenty-records';
import type { TwentyRecord } from './twenty.port';

export type { LinkIndex } from './links';

/**
 * From a Twenty record to the input one of BylineCRM's own services takes (doc 48 §11). Pure: a
 * mapper reads the record and the link index — what earlier objects of this run became — and
 * returns the input, the custom values Twenty's extra fields become, or why the record has no
 * place here (`skip`). The services then validate and write it the way they write anything.
 */
export interface Mapped<I> {
    input: I;
    custom: InferredCustom;
}
export interface Skip {
    skip: string;
}

export function isSkip<I>(mapped: Mapped<I> | Skip): mapped is Skip {
    return 'skip' in mapped;
}

const COMPANY_FIELDS = new Set([
    'name',
    'domainName',
    'employees',
    'idealCustomerProfile',
    'annualRecurringRevenue',
    'address',
    'linkedinLink',
    'xLink',
    'accountOwnerId',
    'accountOwner',
]);

export function mapCompany(record: TwentyRecord, links: LinkIndex): Mapped<CompanyInput & { name: string }> | Skip {
    const name = text(record.name);
    if (!name) return { skip: 'no name' };
    const arr = moneyOf(record.annualRecurringRevenue, 'USD');
    return {
        input: {
            name,
            domain: domainOfRecord(record.domainName),
            employeeCount: numberOrNull(record.employees),
            arr: arr ?? null,
            address: addressOf(record.address) ?? EMPTY_ADDRESS,
            links: { linkedin: linkOf(record.linkedinLink), x: linkOf(record.xLink) },
            icp: record.idealCustomerProfile === true,
            ownerId: links.resolve('workspaceMembers', record.accountOwnerId),
        },
        custom: inferCustomValues(record, COMPANY_FIELDS),
    };
}

const PERSON_FIELDS = new Set([
    'name',
    'emails',
    'phones',
    'jobTitle',
    'city',
    'linkedinLink',
    'xLink',
    'avatarUrl',
    'avatarFile',
    'companyId',
    'company',
    'personOwnerId',
    'personOwner',
]);

export function mapPerson(record: TwentyRecord, links: LinkIndex): Mapped<PersonInput> | Skip {
    const name = nameOf(record.name);
    const emails = emailsOf(record.emails);
    if (!name.first && !name.last && !emails.primary) return { skip: 'no name and no email' };
    const leadSource = text(record.inboundLeadSource);
    return {
        input: {
            nameFirst: name.first,
            nameLast: name.last,
            emails,
            phones: phonesOf(record.phones),
            jobTitle: text(record.jobTitle),
            city: text(record.city),
            links: { linkedin: linkOf(record.linkedinLink), x: linkOf(record.xLink) },
            companyId: links.resolve('companies', record.companyId),
            ownerId: links.resolve('workspaceMembers', record.personOwnerId),
            source: leadSource ? `${TWENTY_IMPORT_SOURCE}:${leadSource.toLowerCase()}` : TWENTY_IMPORT_SOURCE,
        },
        custom: inferCustomValues(record, PERSON_FIELDS),
    };
}

const OPPORTUNITY_FIELDS = new Set([
    'name',
    'amount',
    'closeDate',
    'stage',
    'lostReason',
    'companyId',
    'company',
    'pointOfContactId',
    'pointOfContact',
    'ownerId',
    'owner',
]);

export interface MappedOpportunity extends Mapped<OpportunityInput & { name: string }> {
    /** The stage Twenty has the deal in, by name, with the kind its name implies; null when Twenty names none. */
    stage: { name: string; kind: StageKind } | null;
    lostReason: string | null;
}

export function mapOpportunity(
    record: TwentyRecord,
    links: LinkIndex,
    defaultCurrency: string,
): MappedOpportunity | Skip {
    const name = text(record.name);
    if (!name) return { skip: 'no name' };
    const stage = text(record.stage);
    const lostReason = text(record.lostReason);
    return {
        input: {
            name,
            amount: moneyOf(record.amount, defaultCurrency),
            closeDate: isoDate(record.closeDate),
            companyId: links.resolve('companies', record.companyId),
            pointOfContactId: links.resolve('people', record.pointOfContactId),
            ownerId: links.resolve('workspaceMembers', record.ownerId),
        },
        custom: inferCustomValues(record, OPPORTUNITY_FIELDS),
        stage: stage ? { name: humanise(stage), kind: stageKindOf(stage) } : null,
        lostReason: lostReason ? humanise(lostReason) : null,
    };
}

/** What a stage's name says about it: a closed-won or customer stage is `won`, a lost one `lost`, the rest open. */
export function stageKindOf(stage: string): StageKind {
    const upper = stage.toUpperCase();
    if (/LOST/.test(upper)) return 'lost';
    if (/WON|CUSTOMER/.test(upper)) return 'won';
    return 'open';
}

/** The target columns a Twenty note or task target names, and the object each resolves through. */
const TARGET_COLUMNS: readonly { column: string; object: TwentyImportObject; type: RecordTarget['type'] }[] = [
    { column: 'targetPersonId', object: 'people', type: 'person' },
    { column: 'targetCompanyId', object: 'companies', type: 'company' },
    { column: 'targetOpportunityId', object: 'opportunities', type: 'opportunity' },
];

/** The records here that a note's or task's targets point at; a target on an object with no home is left out. */
function targetsOf(value: unknown, links: LinkIndex): RecordTarget[] {
    const targets: RecordTarget[] = [];
    for (const raw of Array.isArray(value) ? value : []) {
        if (!isObject(raw)) continue;
        for (const { column, object, type } of TARGET_COLUMNS) {
            const id = links.resolve(object, raw[column]);
            if (id && !targets.some((t) => t.type === type && t.id === id)) targets.push({ type, id });
        }
    }
    return targets;
}

/** The member who made a Twenty record, when Twenty says one did and they are a member here. */
function authorOf(record: TwentyRecord, links: LinkIndex): string | null {
    return isObject(record.createdBy) ? links.resolve('workspaceMembers', record.createdBy.workspaceMemberId) : null;
}

function bodyOf(value: unknown) {
    return markdownToRichText(isObject(value) ? (text(value.markdown) ?? '') : '');
}

export function mapNote(
    record: TwentyRecord,
    links: LinkIndex,
): Mapped<NoteInput & { targets: RecordTarget[]; authorId: string | null }> | Skip {
    const targets = targetsOf(record.noteTargets, links);
    if (targets.length === 0) return { skip: 'no target in BylineCRM' };
    return {
        input: {
            title: text(record.title) ?? '',
            body: bodyOf(record.bodyV2),
            targets,
            authorId: authorOf(record, links),
        },
        custom: {},
    };
}

const TASK_STATUS: Readonly<Record<string, TaskInput['status']>> = {
    TODO: 'todo',
    IN_PROGRESS: 'in_progress',
    DONE: 'done',
};

export function mapTask(
    record: TwentyRecord,
    links: LinkIndex,
): Mapped<TaskInput & { title: string; targets: RecordTarget[] }> | Skip {
    const targets = targetsOf(record.taskTargets, links);
    if (targets.length === 0) return { skip: 'no target in BylineCRM' };
    return {
        input: {
            title: text(record.title) ?? '(untitled)',
            body: bodyOf(record.bodyV2),
            status: TASK_STATUS[text(record.status)?.toUpperCase() ?? ''] ?? 'todo',
            dueAt: isoDateTime(record.dueAt),
            assigneeId: links.resolve('workspaceMembers', record.assigneeId),
            targets,
        },
        custom: {},
    };
}

export type MappedLeadLookup =
    | { action: 'exclude'; address: string; accountManagerName: string | null }
    | { action: 'release'; address: string }
    | Skip;

/** FR-CRMS-10: a lead lookup says an account manager works an address — or no longer does. */
export function mapLeadLookup(record: TwentyRecord): MappedLeadLookup {
    const address = emailOf(record.email);
    if (!address) return { skip: 'no address' };
    const status = text(record.status)?.toLowerCase();
    if (status === 'assigned') return { action: 'exclude', address, accountManagerName: text(record.assignedToName) };
    return { action: 'release', address };
}

const LEAD_VIEW_FIELDS = new Set([
    'name',
    'firstName',
    'lastName',
    'email',
    'phone',
    'personId',
    'person',
    'assignedAmMemberId',
    'assignedAmMember',
    'lastSyncedAt',
]);

export interface MappedLeadView extends Mapped<PersonInput> {
    /** The person this lead is, when Twenty links one and it is mapped here. */
    personId: string | null;
    email: string | null;
}

/** A Lead Engine lead: the Twenty person it names, else whoever has its address, else a new person. */
export function mapLeadView(record: TwentyRecord, links: LinkIndex): MappedLeadView | Skip {
    const first = text(record.firstName) ?? '';
    const last = text(record.lastName) ?? '';
    const email = emailOf(record.email);
    const personId = links.resolve('people', record.personId);
    if (!personId && !first && !last && !email) return { skip: 'no person, no name and no email' };
    const phone = phoneOf(record.phone, null, text(record.phone)?.startsWith('+1') ? '+1' : null);
    return {
        personId,
        email,
        input: {
            nameFirst: first,
            nameLast: last,
            emails: { primary: email, additional: [] },
            ...(phone ? { phones: { primary: phone, additional: [] } } : {}),
            source: `${TWENTY_IMPORT_SOURCE}:lead`,
        },
        custom: inferCustomValues(record, LEAD_VIEW_FIELDS, 'lead_'),
    };
}

export function mapMessageCampaign(record: TwentyRecord): Mapped<TemplateInput> | Skip {
    const name = text(record.name);
    if (!name) return { skip: 'no name' };
    return {
        input: {
            name,
            kind: 'outreach',
            subject: text(record.subject) ?? '',
            body: markdownToRichText(text(record.bodyTemplate) ?? ''),
        },
        custom: {},
    };
}

export function mapMessageList(record: TwentyRecord): { name: string } | Skip {
    const name = text(record.name);
    return name ? { name } : { skip: 'no name' };
}

export function mapMessageListMember(
    record: TwentyRecord,
    links: LinkIndex,
): { personId: string; listName: string } | Skip {
    const personId = links.resolve('people', record.personId);
    if (!personId) return { skip: 'person not in BylineCRM' };
    const list = links.link('messageLists', record.listId);
    if (!list?.label) return { skip: 'list not in BylineCRM' };
    return { personId, listName: list.label };
}

/** A Twenty member → the member here with the same sign-in address. */
export function memberEmailOf(record: TwentyRecord): string | null {
    return emailOf(record.userEmail);
}

const EMPTY_ADDRESS = { street: null, city: null, state: null, country: null, postalCode: null };

function domainOfRecord(value: unknown): string | null {
    return isObject(value) ? domainOfLink(value.primaryLinkUrl) : null;
}

function domainOfLink(value: unknown): string | null {
    const url = text(value);
    if (!url) return null;
    const host = idOf(url) ? new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname : '';
    const cleaned = host.toLowerCase().replace(/^www\./, '');
    return cleaned.includes('.') ? cleaned : null;
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}
