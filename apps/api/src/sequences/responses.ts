import {
    ENROLMENT_REFUSAL_CODES,
    ENROLMENT_STATUSES,
    ENROLMENT_STOP_REASONS,
    ENROLMENT_WARNING_CODES,
    EXCLUSION_REASONS,
    REGION_CODES,
    SEQUENCE_STATUSES,
    SEQUENCE_VISIBILITIES,
    TASK_STATUSES,
    SEQUENCE_STEP_KINDS,
    type EnrolmentBatchResult,
    type EnrolmentView,
    type OutreachExclusionView,
    type RegionPolicyChange,
    type RegionPolicyEntry,
    type SequenceView,
} from '@bylinecrm/shared';
import { z } from 'zod';
import { actor, id, named } from '../openapi/responses';
import { trackingCounts } from '../tracking/responses';

/** Sequences and outreach compliance (P3-3), as the API returns them. */

const isoTime = z.iso.datetime();

const step = named(
    'SequenceStep',
    z.object({
        id,
        position: z.number().int(),
        kind: z.enum(SEQUENCE_STEP_KINDS),
        templateId: id.nullable().meta({ description: '`email` steps: an outreach template.' }),
        replyInThread: z.boolean(),
        waitDays: z.number().int().nullable().meta({ description: '`wait` steps.' }),
        businessDays: z.boolean(),
        taskTitle: z.string().nullable().meta({
            description:
                '`task` steps: a task on the person for their owner (else the enroller), due when the step runs.',
        }),
        tracking: trackingCounts.meta({
            description: '`email` steps: clicks and indicative opens across its sends (P3-4).',
        }),
    }),
);

export const sequenceView = named(
    'Sequence',
    z.object({
        id,
        name: z.string(),
        status: z.enum(SEQUENCE_STATUSES),
        pipelineId: id.nullable(),
        stopOnPipelineExit: z.boolean(),
        timeZone: z.string().meta({ description: "Used when a recipient's zone cannot be inferred." }),
        window: z.object({
            startMinute: z.number().int(),
            endMinute: z.number().int(),
            days: z.number().int().meta({ description: 'Monday-first bitmask: bit 0 Monday … bit 6 Sunday.' }),
        }),
        steps: z.array(step),
        counts: z.object({
            enrolled: z.number().int(),
            active: z.number().int(),
            held: z.number().int(),
            finished: z.number().int(),
            stopped: z.number().int(),
        }),
        createdBy: actor,
        ownerMemberId: id.nullable().meta({
            description: 'Whose sequence it is (#192): who made it, or whose API key did; null when neither is known.',
        }),
        visibility: z.enum(SEQUENCE_VISIBILITIES).meta({
            description:
                '`shared`: everyone who may enrol sees it. `private`: its owner and admins only; to anyone else it is not found (#192).',
        }),
        createdAt: isoTime,
        updatedAt: isoTime,
    }),
);

const enrolmentTask = named(
    'SequenceEnrolmentTask',
    z.object({
        id,
        stepId: id.meta({ description: 'The task step that made it.' }),
        title: z.string(),
        status: z.enum(TASK_STATUSES),
        dueAt: isoTime.nullable(),
        completedAt: isoTime.nullable(),
        assigneeId: id.nullable(),
    }),
);

export const enrolmentView = named(
    'SequenceEnrolment',
    z.object({
        id,
        sequenceId: id,
        personId: id,
        dealId: id.nullable(),
        status: z.enum(ENROLMENT_STATUSES),
        stepIndex: z.number().int(),
        nextRunAt: isoTime.nullable(),
        waitingOutboundId: id.nullable(),
        heldReason: z.string().nullable(),
        stopReason: z.enum(ENROLMENT_STOP_REASONS).nullable(),
        stopDetail: z.string().nullable(),
        enrolledBy: actor,
        enrolledByMemberId: id.meta({
            description: "The member who enrolled the person: the sender of each step's send (#144).",
        }),
        countryUnknownAtEnrol: z.boolean().meta({
            description: 'No country was known at enrolment (D-251); the region policy applies once one is.',
        }),
        enrolledAt: isoTime,
        finishedAt: isoTime.nullable(),
        stoppedAt: isoTime.nullable(),
        tasks: z.array(enrolmentTask).meta({
            description: 'The tasks its task steps made, in step order (#158). Completing one drives nothing.',
        }),
    }),
);

export const enrolmentBatchResult = named(
    'EnrolmentBatchResult',
    z.object({
        enrolled: z.array(id),
        skipped: z.array(id).meta({ description: 'Already in this sequence: a no-op, never a second enrolment.' }),
        refused: z.array(
            z.object({
                personId: id,
                code: z.enum(ENROLMENT_REFUSAL_CODES),
                message: z.string().meta({ description: "The server's reason, naming the rule." }),
            }),
        ),
        warnings: z
            .array(
                z.object({
                    personId: id,
                    code: z.enum(ENROLMENT_WARNING_CODES),
                    message: z.string(),
                }),
            )
            .meta({ description: 'Enrolled, flagged for review — never blocking (D-251: no known country).' }),
    }),
);

export const regionPolicyEntry = named(
    'RegionPolicyEntry',
    z.object({
        region: z.enum(REGION_CODES),
        allowed: z.boolean(),
        isDefault: z.boolean(),
        lawfulBasis: z.string().nullable(),
        updatedAt: isoTime.nullable(),
    }),
);

export const regionPolicyChange = named(
    'RegionPolicyChange',
    z.object({
        id,
        region: z.enum(REGION_CODES),
        allowed: z.boolean(),
        lawfulBasis: z.string().nullable(),
        changedBy: z.string().nullable().meta({ description: 'The member, by name; null once removed.' }),
        changedAt: isoTime,
    }),
);

export const outreachExclusionView = named(
    'OutreachExclusion',
    z.object({
        id,
        address: z.string().nullable(),
        domain: z.string().nullable(),
        reason: z.enum(EXCLUSION_REASONS),
        accountManagerName: z.string().nullable(),
        source: z.string(),
        externalRef: z.string().nullable(),
        note: z.string().nullable(),
        createdAt: isoTime,
    }),
);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _Checks = [
    Assert<Same<z.output<typeof sequenceView>, SequenceView>>,
    Assert<Same<z.output<typeof enrolmentView>, EnrolmentView>>,
    Assert<Same<z.output<typeof enrolmentBatchResult>, EnrolmentBatchResult>>,
    Assert<Same<z.output<typeof regionPolicyEntry>, RegionPolicyEntry>>,
    Assert<Same<z.output<typeof regionPolicyChange>, RegionPolicyChange>>,
    Assert<Same<z.output<typeof outreachExclusionView>, OutreachExclusionView>>,
];
