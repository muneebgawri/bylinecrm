import { CUSTOM_FIELD_TYPES, RECORD_OBJECTS, TASK_STATUSES } from '@bylinecrm/shared';
import { z } from 'zod';
import {
    actor,
    address,
    customValues,
    dateTime,
    emails,
    id,
    links,
    money,
    named,
    page,
    phones,
    recordTarget,
    richText,
} from '../openapi/responses';

/**
 * The record objects as the API returns them. Each service's `…View` type is `z.output` of the
 * schema here, so what a service builds, what the route promises and what the document says are
 * one definition (P1-1c).
 */

const trash = { deletedAt: dateTime.nullable(), createdAt: dateTime, updatedAt: dateTime };

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
        links,
        avatarUrl: z.string().nullable(),
        position: z.number(),
        companyId: id.nullable(),
        ownerId: id.nullable(),
        createdBy: actor,
        custom: customValues,
        ...trash,
    }),
);
export const personPage = named('PersonPage', page(personView));

/** A company (PAR-005). */
export const companyView = named(
    'Company',
    z.object({
        id,
        name: z.string(),
        domain: z.string().nullable(),
        employeeCount: z.number().int().nullable(),
        arr: money.nullable(),
        address,
        links,
        icp: z.boolean(),
        position: z.number(),
        ownerId: id.nullable(),
        createdBy: actor,
        custom: customValues,
        ...trash,
    }),
);
export const companyPage = named('CompanyPage', page(companyView));

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
        lostReason: z.string().nullable(),
        amount: money.nullable(),
        currency: z.string(),
        closeDate: z.string().nullable().meta({ description: 'A calendar date, `YYYY-MM-DD`.', example: '2026-10-31' }),
        probability: z.number().nullable(),
        position: z.number(),
        ownerId: id.nullable(),
        pointOfContactId: id.nullable(),
        companyId: id.nullable(),
        createdBy: actor,
        custom: customValues,
        ...trash,
    }),
);
export const opportunityPage = named('OpportunityPage', page(opportunityView));

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
        position: z.number(),
        archivedAt: dateTime.nullable(),
        createdAt: dateTime,
        updatedAt: dateTime,
    }),
);

export type PersonView = z.output<typeof personView>;
export type CompanyView = z.output<typeof companyView>;
export type OpportunityView = z.output<typeof opportunityView>;
export type NoteView = z.output<typeof noteView>;
export type TaskView = z.output<typeof taskView>;
export type AttachmentView = z.output<typeof attachmentView>;
export type CustomFieldView = z.output<typeof customFieldView>;
