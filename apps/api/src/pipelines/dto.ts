import {
    CADENCE_DAYS_MAX,
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
    LOST_REASONS,
    STAGE_COLOURS,
    STAGE_KINDS,
    STAGE_RULE_EVENTS,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { queryParams } from '../query/dto';

const uuid = z.uuid();
const text = (max: number) => z.string().trim().max(max);
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217, upper case');
const money = z.object({
    amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: currency.optional(),
});

const stageFields = {
    name: text(120).min(1),
    probability: z.number().int().min(0).max(100),
    kind: z.enum(STAGE_KINDS),
    daysThreshold: z.number().int().min(1).nullable(),
    colour: z.enum(STAGE_COLOURS),
};
const newStage = z.object(stageFields).partial().required({ name: true, probability: true, colour: true });

export class SetCadenceDto extends createZodDto(
    z.object({
        stages: z
            .array(
                z.object({
                    stageId: uuid,
                    cadenceDays: z.number().int().min(1).max(CADENCE_DAYS_MAX).nullable().meta({
                        description: 'Days after a deal’s last touch it is due another; null: no cadence.',
                    }),
                }),
            )
            .min(1)
            .max(50),
    }),
) {}

export class CreatePipelineDto extends createZodDto(
    z.object({
        name: text(120).min(1),
        isDefault: z.boolean().optional(),
        /** The stages in order; omitted means a copy of the default list. The first must be open. */
        stages: z.array(newStage).min(1).max(50).optional(),
    }),
) {}

export class UpdatePipelineDto extends createZodDto(
    z.object({ name: text(120).min(1).optional(), isDefault: z.literal(true).optional() }),
) {}

export class CreateStageDto extends createZodDto(newStage) {}
export class UpdateStageDto extends createZodDto(z.object(stageFields).partial()) {}

export class OrderStagesDto extends createZodDto(z.object({ stageIds: z.array(uuid).min(1).max(50) })) {}

const ruleFields = {
    event: z.enum(STAGE_RULE_EVENTS),
    toStageId: uuid,
    allowBackward: z.boolean(),
    enabled: z.boolean(),
};
export class CreateRuleDto extends createZodDto(
    z.object(ruleFields).partial().required({ event: true, toStageId: true }),
) {}
export class UpdateRuleDto extends createZodDto(z.object(ruleFields).partial().omit({ event: true })) {}

/** A member's move. Closing (a won or lost stage) carries what the close records. */
export class MoveDealDto extends createZodDto(
    z.object({
        stageId: uuid,
        close: z
            .object({
                wonAmount: money.optional(),
                lostReason: text(500).optional(),
                lostReasonCode: z.enum(LOST_REASONS).optional().meta({
                    description:
                        'Why the deal was lost (#242). Required when `stageId` is a lost stage; `400` without it.',
                }),
            })
            .optional(),
    }),
) {}

/** The board takes the same filter, sort, view and search as the deal list; the per-stage page is fixed. */
export class BoardQueryDto extends createZodDto(z.object(queryParams)) {}

export class HistoryQueryDto extends createZodDto(
    z.object({
        limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
    }),
) {}

/** `DELETE …/stages/:stageId?moveDealsTo=<id>`: where the stage's deals go before it does (P1-2b). */
export class DeleteStageQueryDto extends createZodDto(
    z.object({
        moveDealsTo: uuid.optional().meta({
            description:
                'The stage of the same pipeline to move the deals to; required when the stage holds deals. An open stage (won or lost deals reopen there), or — when the deleted stage is won or lost — another stage of that same kind, where the deals stay closed with their won amount, lost reason and closed date. A closed stage of another kind is refused (422).',
        }),
    }),
) {}
