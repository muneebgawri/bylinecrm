import {
    CUSTOM_FIELD_KEY_PATTERN,
    CUSTOM_FIELD_TYPES,
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
    RECORD_OBJECTS,
    TASK_STATUSES,
    type RichTextNode,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { optionsProblem } from './custom-fields/custom-values';
import { filterParam, sortParam } from '../query/dto';

const uuid = z.uuid();
const text = (max: number) => z.string().trim().max(max);
const nullableText = (max: number) => text(max).nullable();
const emailAddress = z.email().max(254);
const url = z.url().max(2048);

/** A registrable host name, lower-cased on the way in; the database checks it stayed that way. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const domain = z.string().trim().toLowerCase().regex(HOSTNAME, 'domain must be a host name like example.com');

/**
 * Composite fields: `additional` may be left out and means none (P1-UI-10). The whole object is
 * still replaced on update (P1-1a), so leaving it out of a PATCH clears it, as it always did.
 */
const emails = z.object({ primary: emailAddress.nullable(), additional: z.array(emailAddress).max(20).default([]) });
const phone = z.object({
    number: z.string().regex(/^[0-9]{3,15}$/, 'digits only, without the country code'),
    countryCode: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, upper case'),
});
const phones = z.object({ primary: phone.nullable(), additional: z.array(phone).max(20).default([]) });
const link = z.object({ url, label: nullableText(120) });
const links = z.object({ linkedin: link.nullable(), x: link.nullable() });
const address = z.object({
    street: nullableText(200),
    city: nullableText(120),
    state: nullableText(120),
    country: nullableText(120),
    postalCode: nullableText(20),
});
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217, upper case');
/** An amount: exact minor units; the currency defaults to the workspace's. One shape for every amount. */
const money = z.object({
    amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: currency.optional(),
});
/** Shape only; the keys and types are checked against the workspace's definitions by the service. */
const custom = z.record(z.string().regex(CUSTOM_FIELD_KEY_PATTERN), z.unknown());
const position = z.number().finite();

const personFields = {
    nameFirst: text(120),
    nameLast: text(120),
    emails,
    phones,
    jobTitle: nullableText(120),
    city: nullableText(120),
    /** FR-CRMS-11: where the person came from; required to enrol in outreach. */
    source: nullableText(200),
    /** FR-CRMS-11: ISO 3166-1 alpha-2; stored upper case. */
    country: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{2}$/, 'a two-letter ISO country code, e.g. DE')
        .transform((v) => v.toUpperCase())
        .nullable(),
    links,
    avatarUrl: url.nullable(),
    position,
    companyId: uuid.nullable(),
    ownerId: uuid.nullable(),
    custom,
};
export class CreatePersonDto extends createZodDto(z.object(personFields).partial()) {}
export class UpdatePersonDto extends createZodDto(z.object(personFields).partial()) {}

const companyFields = {
    name: text(200).min(1),
    domain: domain.nullable(),
    employeeCount: z.number().int().min(0).nullable(),
    arr: money.nullable(),
    address,
    links,
    icp: z.boolean(),
    position,
    ownerId: uuid.nullable(),
    custom,
};
export class CreateCompanyDto extends createZodDto(z.object(companyFields).partial().required({ name: true })) {}
export class UpdateCompanyDto extends createZodDto(z.object(companyFields).partial()) {}

/**
 * Query string of every record list. `filter` is base64url JSON of the grammar, `sort` is
 * `field:asc,field2:desc`, `view` a saved view whose filter and sorts apply as defaults; the
 * planner (P1-4) checks the fields they name against the object.
 */
export class ListQueryDto extends createZodDto(
    z.object({
        cursor: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
        sort: sortParam.optional(),
        filter: filterParam.optional(),
        view: z.uuid().optional(),
        q: text(200).min(1).optional(),
    }),
) {}

const customFieldOptions = z.array(text(120).min(1)).max(200);

export class CreateCustomFieldDto extends createZodDto(
    z
        .object({
            object: z.enum(RECORD_OBJECTS),
            key: z.string().regex(CUSTOM_FIELD_KEY_PATTERN, 'a key is a-z, 0-9 and _, starting with a letter'),
            label: text(120).min(1),
            type: z.enum(CUSTOM_FIELD_TYPES),
            options: customFieldOptions.optional(),
            required: z.boolean().optional(),
            position: position.optional(),
        })
        .superRefine((value, ctx) => {
            const problem = optionsProblem(value.type, value.options ?? []);
            if (problem) ctx.addIssue({ code: 'custom', path: ['options'], message: problem });
        }),
) {}

export class UpdateCustomFieldDto extends createZodDto(
    z.object({
        label: text(120).min(1).optional(),
        options: customFieldOptions.optional(),
        required: z.boolean().optional(),
        position: position.optional(),
    }),
) {}

const queryFlag = z.enum(['true', 'false']).transform((v) => v === 'true');

export class ListCustomFieldsQueryDto extends createZodDto(
    z.object({ object: z.enum(RECORD_OBJECTS).optional(), archived: queryFlag.optional() }),
) {}

// ─────────────────────────────────────────────────────────────────────────────
// Deals, notes, tasks, attachments (P1-1b).
// ─────────────────────────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar date, YYYY-MM-DD');

const opportunityFields = {
    name: text(200).min(1),
    amount: money.nullable(),
    closeDate: isoDate.nullable(),
    probability: z.number().int().min(0).max(100).nullable(),
    position,
    ownerId: uuid.nullable(),
    pointOfContactId: uuid.nullable(),
    companyId: uuid.nullable(),
    custom,
};
/** Where a new deal starts (P1-2): the default pipeline's first stage unless the caller names one. A move is a route of its own. */
const placement = { pipelineId: uuid, stageId: uuid };
export class CreateOpportunityDto extends createZodDto(
    z
        .object({ ...opportunityFields, ...placement })
        .partial()
        .required({ name: true }),
) {}
export class UpdateOpportunityDto extends createZodDto(z.object(opportunityFields).partial()) {}

/** A record a note, task or file is attached to. */
const target = z.object({ type: z.enum(RECORD_OBJECTS), id: uuid });
const targets = z.array(target).min(1).max(50);

/** The editor's document. Only the root is checked here; nodes are stored as given. */
const richTextNode: z.ZodType<RichTextNode> = z.lazy(() =>
    z
        .object({
            type: z.string().min(1).max(64),
            text: z.string().optional(),
            content: z.array(richTextNode).optional(),
        })
        .passthrough(),
);
const richText = z.object({ type: z.literal('doc'), content: z.array(richTextNode).optional() });

const noteFields = { title: text(300), body: richText, targets };
export class CreateNoteDto extends createZodDto(z.object(noteFields).partial().required({ targets: true })) {}
export class UpdateNoteDto extends createZodDto(z.object(noteFields).partial()) {}

const taskFields = {
    title: text(300).min(1),
    body: richText,
    status: z.enum(TASK_STATUSES),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    assigneeId: uuid.nullable(),
    targets,
};
export class CreateTaskDto extends createZodDto(
    z.object(taskFields).partial().required({ title: true, targets: true }),
) {}
export class UpdateTaskDto extends createZodDto(z.object(taskFields).partial()) {}

/** `target=<object>:<uuid>`; parsed and checked by the service. */
const targetParam = z.string().regex(/^[a-z]+:[0-9a-fA-F-]{36}$/, 'target is <object>:<uuid>');

/** Notes are listed by the record they are on. */
export class ListNotesQueryDto extends createZodDto(
    z.object({
        target: targetParam,
        cursor: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
    }),
) {}

/** Tasks are listed by the record they are on, or by whom they are assigned to — one or the other. */
export class ListTasksQueryDto extends createZodDto(
    z
        .object({
            target: targetParam.optional(),
            assigneeId: uuid.optional(),
            status: z.enum(TASK_STATUSES).optional(),
            cursor: z.string().min(1).optional(),
            limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
        })
        .refine((q) => Boolean(q.target) !== Boolean(q.assigneeId), {
            message: 'list tasks by target or by assigneeId, not both and not neither',
            path: ['target'],
        }),
) {}

export class ListAttachmentsQueryDto extends createZodDto(z.object({ target: targetParam })) {}

/** The upload's target travels in the query string; the file is the multipart body. */
export class UploadAttachmentQueryDto extends createZodDto(z.object({ target: targetParam })) {}
