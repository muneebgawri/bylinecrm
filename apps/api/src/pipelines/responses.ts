import {
    ACTOR_KINDS,
    STAGE_COLOURS,
    STAGE_HISTORY_REASONS,
    STAGE_KINDS,
    STAGE_RULE_EVENTS,
    type EventActor,
} from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named } from '../openapi/responses';
import { opportunityView } from '../records/responses';

/** Pipelines, stages, rules, history and the board (P1-2), as the API returns them. */

export const stageView = named(
    'Stage',
    z.object({
        id,
        pipelineId: id,
        name: z.string(),
        position: z.number().int(),
        probability: z.number().int(),
        kind: z.enum(STAGE_KINDS),
        daysThreshold: z.number().int().nullable(),
        cadenceDays: z.number().int().nullable().meta({
            description:
                'CADENCE-1: an open deal here is due a touch this many days after its last; null (every closed stage): none.',
        }),
        colour: z.enum(STAGE_COLOURS),
    }),
);

export const pipelineView = named(
    'Pipeline',
    z.object({
        id,
        name: z.string(),
        isDefault: z.boolean(),
        position: z.number().int(),
        stages: z.array(stageView),
        createdAt: dateTime,
        updatedAt: dateTime,
    }),
);

export const ruleView = named(
    'StageRule',
    z.object({
        id,
        pipelineId: id,
        event: z.enum(STAGE_RULE_EVENTS),
        toStageId: id,
        allowBackward: z.boolean(),
        enabled: z.boolean(),
    }),
);

/** Who moved a deal: a record actor, or the rule that did it. */
const eventActor: z.ZodType<EventActor> = z.union([
    z.object({ kind: z.enum(ACTOR_KINDS), id: id.nullable() }),
    z.object({ kind: z.literal('rule'), id }),
]);

export const historyEntry = named(
    'StageHistoryEntry',
    z.object({
        id,
        fromStageId: id.nullable(),
        fromStageName: z.string().nullable().meta({
            description: 'The stage’s name when the move happened; it may since have been renamed or deleted.',
        }),
        toStageId: id,
        toStageName: z.string().meta({
            description: 'The stage’s name when the move happened; it may since have been renamed or deleted.',
        }),
        enteredAt: dateTime,
        actor: named('EventActor', eventActor),
        reason: z.enum(STAGE_HISTORY_REASONS),
    }),
);

export const moveResult = named(
    'MoveResult',
    z.object({
        deal: opportunityView,
        rulesThatMayMoveItForward: z.array(ruleView).meta({
            description: 'On a backward move: the enabled rules of the pipeline that could move it forward again.',
        }),
    }),
);

export const boardColumn = named(
    'BoardColumn',
    z.object({
        stage: stageView,
        count: z.number().int().meta({ description: "Deals in the stage under the filter and the caller's scope." }),
        amountMinorByCurrency: z.record(z.string(), z.number().int()),
        deals: z.array(opportunityView),
        hasMore: z.boolean(),
    }),
);

export const boardView = named('Board', z.object({ pipeline: pipelineView, columns: z.array(boardColumn) }));

export type StageView = z.output<typeof stageView>;
export type PipelineView = z.output<typeof pipelineView>;
export type RuleView = z.output<typeof ruleView>;
export type HistoryEntry = z.output<typeof historyEntry>;
export type MoveResult = z.output<typeof moveResult>;
export type BoardColumn = z.output<typeof boardColumn>;
export type BoardView = z.output<typeof boardView>;
