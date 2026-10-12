import {
    EXCLUSION_REASONS,
    REGION_CODES,
    REGION_LAWFUL_BASIS_MAX,
    SEQUENCE_LIMITS,
    SEQUENCE_STEP_KINDS,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const L = SEQUENCE_LIMITS;
const uuid = z.uuid();

const window = z
    .object({
        startMinute: z.number().int().min(0).max(1439),
        endMinute: z.number().int().min(1).max(1440),
        days: z.number().int().min(1).max(127),
    })
    .refine((w) => w.startMinute < w.endMinute, { path: ['endMinute'], message: 'after the start' });

const sequenceFields = {
    name: z.string().trim().min(1).max(L.name),
    timeZone: z.string().trim().min(1).max(64),
    pipelineId: uuid.nullable(),
    stopOnPipelineExit: z.boolean(),
    window,
};

/** `POST /sequences` — a draft. `timeZone` is the one used when a recipient's cannot be inferred. */
export class CreateSequenceDto extends createZodDto(
    z.object({
        name: sequenceFields.name,
        timeZone: sequenceFields.timeZone.optional(),
        pipelineId: sequenceFields.pipelineId.optional(),
        stopOnPipelineExit: sequenceFields.stopOnPipelineExit.optional(),
        window: window.optional(),
    }),
) {}

export class UpdateSequenceDto extends createZodDto(z.object(sequenceFields).partial()) {}

const stepInput = z.discriminatedUnion('kind', [
    z.object({
        id: uuid.optional(),
        kind: z.literal(SEQUENCE_STEP_KINDS[0]),
        templateId: uuid,
        replyInThread: z.boolean().default(false),
    }),
    z.object({
        id: uuid.optional(),
        kind: z.literal(SEQUENCE_STEP_KINDS[1]),
        waitDays: z.number().int().min(L.waitDays.min).max(L.waitDays.max),
        businessDays: z.boolean().default(true),
    }),
    z.object({
        id: uuid.optional(),
        kind: z.literal(SEQUENCE_STEP_KINDS[2]),
        taskTitle: z.string().trim().min(1).max(L.taskTitle),
    }),
]);

/** `PUT /sequences/:id/steps` — the whole ordered list. */
export class PutSequenceStepsDto extends createZodDto(z.object({ steps: z.array(stepInput).min(1).max(L.steps) })) {}
export type StepInput = z.output<typeof stepInput>;

export class EnrolDto extends createZodDto(
    z.object({ personIds: z.array(uuid).min(1).max(L.enrolBatch), dealId: uuid.optional() }),
) {}

export class PreviewEnrolDto extends createZodDto(z.object({ personIds: z.array(uuid).min(1).max(L.enrolBatch) })) {}

export class StopEnrolmentDto extends createZodDto(z.object({ note: z.string().trim().max(L.stopNote).optional() })) {}

export class SetRegionPolicyDto extends createZodDto(
    z.object({
        region: z.enum(REGION_CODES),
        allowed: z.boolean(),
        lawfulBasis: z.string().trim().max(REGION_LAWFUL_BASIS_MAX).nullable().optional(),
    }),
) {}

export class CreateExclusionDto extends createZodDto(
    z
        .object({
            address: z.string().trim().email().max(320).optional(),
            domain: z
                .string()
                .trim()
                .toLowerCase()
                .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a domain, e.g. acme.com')
                .optional(),
            reason: z.enum(EXCLUSION_REASONS),
            accountManagerName: z.string().trim().max(200).nullable().optional(),
            source: z.string().trim().min(1).max(64).optional(),
            externalRef: z.string().trim().max(200).nullable().optional(),
            note: z.string().trim().max(1000).nullable().optional(),
        })
        .refine((v) => (v.address === undefined) !== (v.domain === undefined), {
            path: ['address'],
            message: 'an address or a domain, not both',
        }),
) {}

export class RemoveExclusionDto extends createZodDto(z.object({ note: z.string().trim().min(1).max(1000) })) {}
