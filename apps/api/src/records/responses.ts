import {
    CONTACT_STATUSES,
    LOST_REASONS,
    OWNERSHIP_CONFLICT_KINDS,
    BULK_ROW_ERRORS,
    CUSTOM_FIELD_TYPES,
    RECORD_OBJECTS,
    TASK_STATUSES,
} from '@bylinecrm/shared';
import { z } from 'zod';
import {
    actor,
    address,
    customValues,
    dateTime,
    emails,
    id,
    links,
    countedPage,
    money,
    named,
    page,
    phones,
    recordTarget,
    richText,
} from '../openapi/responses';
import { memberSummaryView } from '../workspace/responses';

/**
 * The record objects as the API returns them. Each service's `…View` type is `z.output` of the
 * schema here, so what a service builds, what the route promises and what the document says are
 * one definition (P1-1c).
 */

const trash = { deletedAt: dateTime.nullable(), createdAt: dateTime, updatedAt: dateTime };

/**
 * A related record by name, on a row (P1-4a). `null` when there is none, when it is in the
 * trash, or when the caller cannot see it — the id column beside it still says which it is.
 */
export const recordSummaryView = named('RecordSummary', z.object({ id, name: z.string() }));
const related = (what: string) =>
    recordSummaryView
        .nullable()
        .meta({ description: `The ${what}, by name; null when none, trashed or not visible to the caller.` });
const owner = memberSummaryView.nullable().meta({ description: 'The owner, by name; null when the record has none.' });

/** A person (PAR-001). */
export const personView = named(
    'Person',
    z.object({
        id,
        nameFirst: z.string(),
        nameLast: z.string(),
        emails,
        phones,
        jobTitle: z.string().nullable(),
        city: z.string().nullable(),
        source: z.string().nullable(),
        country: z.string().nullable(),
        contactStatus: z.enum(CONTACT_STATUSES).meta({
            description:
                'Derived (#242) from mail sent and received, meetings, won deals and the suppression list, unless `contactStatusOverride` is set; `do_not_contact` whenever the primary address is suppressed.',
        }),
        contactStatusOverride: z
            .enum(CONTACT_STATUSES)
            .nullable()
            .meta({ description: 'A member’s choice, which outranks everything but `do_not_contact`.' }),
        contactAttempts: z.number().int().meta({ description: 'Derived: messages sent to them.' }),
        lastContactedAt: dateTime.nullable().meta({ description: 'Derived: when the last message was sent to them.' }),
        cadenceOverdue: z.boolean().meta({
            description: 'Derived (CADENCE-1): the point of contact of an open deal whose follow-up cadence lapsed.',
        }),
        newswireosCustomerId: z.string().nullable().meta({
            description: 'Read-only (PNW-766): their NewswireOS client, from its answer to the latest won-deal push.',
        }),
        links,
        avatarUrl: z.string().nullable(),
        position: z.number(),
        companyId: id.nullable(),
        ownerId: id.nullable(),
        company: related('company'),
        owner,
        createdBy: actor,
        custom: customValues,
        ...trash,
    }),
);
/** Whether a primary address is free; when not, whose person holds it — by name only (OWN-2's rule). */
export const addressCheckView = named(
    'AddressCheck',
    z.object({
        available: z.boolean(),
        holder: z
            .object({
                ownerName: z.string().nullable().meta({ description: 'Null when the person has no owner.' }),
                trashed: z
                    .boolean()
                    .meta({ description: 'The person is in the trash, where it still holds the address.' }),
                workspaceName: z.string().nullable().meta({
                    description:
                        "Set when a workspace sharing this one's lead pool has the person as a customer or prospect (then nothing else is told); null for this workspace.",
                }),
            })
            .nullable(),
    }),
);
export type AddressCheckView = z.output<typeof addressCheckView>;

export const personPage = named('PersonPage', countedPage(personView));

/** A company (PAR-005). */
export const companyView = named(
    'Company',
    z.object({
        id,
        name: z.string(),
        domain: z.string().nullable(),
        logoUrl: z.string().nullable(),
        employeeCount: z.number().int().nullable(),
        arr: money.nullable(),
        address,
        links,
        icp: z.boolean(),
        newswireosCustomerId: z.string().nullable().meta({
            description: 'Read-only (PNW-766): its NewswireOS client, the first a won-deal push gave it.',
        }),
        position: z.number(),
        ownerId: id.nullable(),
        owner,
        createdBy: actor,
        custom: customValues,
        ...trash,
    }),
);
export const companyPage = named('CompanyPage', countedPage(companyView));

/** A deal (PAR-007), with the stage fields P1-2 computes from its history. */
export const opportunityView = named(
    'Opportunity',
    z.object({
        id,
        name: z.string(),
        pipelineId: id,
        stageId: id,
        stageEnteredAt: dateTime.meta({ description: 'When the deal entered its current stage.' }),
        daysInStage: z.number().int().meta({ description: 'Whole days since `stageEnteredAt`, at read time.' }),
        closedAt: dateTime.nullable(),
        lostReason: z.string().nullable().meta({ description: 'Free text beside `lostReasonCode`, when given.' }),
        lostReasonCode: z
            .enum(LOST_REASONS)
            .nullable()
            .meta({ description: 'Why the deal was lost (#242): set on every close into a lost stage.' }),
        nextFollowUpDate: z
            .string()
            .nullable()
            .meta({ description: 'A calendar date, `YYYY-MM-DD`; keeps one open follow-up task due that day.' }),
        followUpTaskId: id.nullable().meta({ description: 'The follow-up task `nextFollowUpDate` keeps, when any.' }),
        nextActivity: z.string().nullable(),
        serviceInterest: z.string().nullable().meta({ description: 'The package or service the deal is about.' }),
        leadSource: z.string().nullable(),
        lastContactedAt: dateTime
            .nullable()
            .meta({ description: 'Derived: when mail was last sent to the point of contact.' }),
        contactAttempts: z
            .number()
            .int()
            .meta({ description: 'Derived: messages sent to the point of contact; 0 when the deal has none.' }),
        cadenceDueAt: dateTime.nullable().meta({
            description:
                'Derived (CADENCE-1): when the next touch is due under its stage’s cadence; null when no cadence applies (closed, unowned, a customer, excluded or suppressed contact).',
        }),
        cadenceOverdue: z.boolean().meta({ description: 'Derived (CADENCE-1): the cadence lapsed.' }),
        amount: money.nullable(),
        currency: z.string(),
        closeDate: z.string().nullable().meta({ description: 'A calendar date, `YYYY-MM-DD`.', example: '2026-10-31' }),
        probability: z.number().nullable(),
        position: z.number(),
        ownerId: id.nullable(),
        pointOfContactId: id.nullable(),
        companyId: id.nullable(),
        owner,
        pointOfContact: related('point of contact'),
        company: related('company'),
        createdBy: actor,
        custom: customValues,
        ...trash,
    }),
);
export const opportunityPage = named('OpportunityPage', countedPage(opportunityView));

/** A note and the records it is attached to (PAR-010). */
export const noteView = named(
    'Note',
    z.object({
        id,
        title: z.string(),
        body: richText,
        bodyText: z.string(),
        targets: z.array(recordTarget),
        authorId: id.nullable(),
        createdBy: actor,
        ...trash,
    }),
);
export const notePage = named('NotePage', page(noteView));

/** A task (PAR-011). */
export const taskView = named(
    'Task',
    z.object({
        id,
        title: z.string(),
        body: richText,
        bodyText: z.string(),
        status: z.enum(TASK_STATUSES),
        dueAt: dateTime.nullable(),
        assigneeId: id.nullable(),
        completedAt: dateTime.nullable(),
        targets: z.array(recordTarget),
        createdBy: actor,
        ...trash,
    }),
);
export const taskPage = named('TaskPage', page(taskView));

/** An attachment's metadata; the bytes are `GET …/content` (PAR-016). */
export const attachmentView = named(
    'Attachment',
    z.object({
        id,
        name: z.string(),
        mime: z.string(),
        sizeBytes: z.number().int(),
        target: recordTarget,
        authorId: id.nullable(),
        createdBy: actor,
        ...trash,
    }),
);

/** A custom-field definition (PAR-073). */
export const customFieldView = named(
    'CustomField',
    z.object({
        id,
        object: z.enum(RECORD_OBJECTS),
        key: z.string(),
        label: z.string(),
        type: z.enum(CUSTOM_FIELD_TYPES),
        options: z.array(z.string()),
        required: z.boolean(),
        adminOnly: z
            .boolean()
            .meta({ description: 'Seen and written only by callers with workspace:admin; hidden from everyone else.' }),
        position: z.number(),
        archivedAt: dateTime.nullable(),
        createdAt: dateTime,
        updatedAt: dateTime,
    }),
);

/** One bulk request's outcome, per record, in the order the request named them (P1-4a). */
export const bulkResultView = named(
    'BulkResult',
    z.object({
        results: z.array(
            z.union([
                z.object({
                    id,
                    ok: z.literal(true),
                    unchanged: z
                        .literal(true)
                        .optional()
                        .meta({ description: 'Already as asked: nothing written, no event.' }),
                }),
                z.object({
                    id,
                    ok: z.literal(false),
                    error: z.enum(BULK_ROW_ERRORS).meta({
                        description:
                            'not_found: not visible to the caller in this state — whether or not it exists elsewhere.',
                    }),
                }),
            ]),
        ),
        succeeded: z.number().int(),
        failed: z.number().int(),
    }),
);

export type RecordSummaryView = z.output<typeof recordSummaryView>;
export type BulkResultView = z.output<typeof bulkResultView>;
export type PersonView = z.output<typeof personView>;
export type CompanyView = z.output<typeof companyView>;
export type OpportunityView = z.output<typeof opportunityView>;
export type NoteView = z.output<typeof noteView>;
export type TaskView = z.output<typeof taskView>;
export type AttachmentView = z.output<typeof attachmentView>;
export type CustomFieldView = z.output<typeof customFieldView>;

/** A company's other domain (OWN-2). */
export const companyDomainView = named('CompanyDomain', z.object({ domain: z.string(), createdAt: z.iso.datetime() }));

/** One record the company-ownership rule disagrees with (OWN-2's backfill report). */
export const ownershipConflictView = named(
    'OwnershipConflict',
    z.object({
        kind: z.enum(OWNERSHIP_CONFLICT_KINDS).meta({
            description:
                '`domain_owned_by_other`: the person’s address is at a company another member owns. `company_owner_differs`: the person or open deal is linked to a company another member owns. `duplicate_domain`: a company saved as `www.<domain>` beside the company with that domain; merge or delete it by hand.',
        }),
        object: z.enum(['person', 'opportunity', 'company']),
        recordId: id,
        recordLabel: z.string(),
        recordOwnerMemberId: id.nullable(),
        recordOwnerName: z.string().nullable(),
        companyId: id,
        companyName: z.string(),
        companyOwnerMemberId: id,
        companyOwnerName: z.string().nullable(),
    }),
);
