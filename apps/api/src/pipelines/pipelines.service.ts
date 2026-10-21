import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import {
    BOARD_STAGE_LIMIT,
    DEFAULT_STAGES,
    STAGE_DELETE_MOVE_LIMIT,
    type EventActor,
    type StageColour,
    type StageKind,
    type StageRuleEvent,
    type ViewSort,
} from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { Forbidden, StateConflict, TooLarge, UniqueConflict, ValidationFailed } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from '../records/actor';
import { opportunityInclude, view as dealView } from '../records/opportunities.service';
import { CustomFieldsService } from '../records/custom-fields/custom-fields.service';
import { type RawQuery, resolvePlan } from '../query/query.service';
import { ownerWhere } from '../records/record-scope';
import { stored } from '../records/references';
import { searchCandidates } from '../records/search';
import { ruleEventOf, storedRuleEvent } from './rule-events';
import { planStageDelete, type StageDeletePlan } from './stage-delete';
import { StageMoveService, type ClosePayload } from './stage-move.service';
import type { StageView, PipelineView, RuleView, HistoryEntry, MoveResult, BoardColumn, BoardView } from './responses';
export type { StageView, PipelineView, RuleView, HistoryEntry, MoveResult, BoardColumn, BoardView } from './responses';

export interface StageInput {
    name: string;
    probability: number;
    kind?: StageKind | undefined;
    daysThreshold?: number | null | undefined;
    colour: StageColour;
}

/** A stage patch: any field, or none. */
export type StagePatch = { [K in keyof StageInput]?: StageInput[K] | undefined };

type StageRow = Prisma.PipelineStageGetPayload<Record<string, never>>;
type PipelineRow = Prisma.PipelineGetPayload<{ include: { stages: true } }>;
type RuleRow = Prisma.StageRuleGetPayload<Record<string, never>>;

/** A board's columns read top-down in manual order unless the request or a view says otherwise. */
const BOARD_SORT: ViewSort = { field: 'position', direction: 'asc' };

@Injectable()
export class PipelinesService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly moves: StageMoveService,
        private readonly customFields: CustomFieldsService,
    ) {}

    // ── Pipelines ────────────────────────────────────────────────────────────

    list(): Promise<PipelineView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.pipeline.findMany({
                include: stagesInOrder,
                orderBy: [{ position: 'asc' }, { id: 'asc' }],
            });
            return rows.map(pipelineView);
        });
    }

    get(id: string): Promise<PipelineView> {
        return this.rls.withWorkspace(async (tx) => pipelineView(await findPipeline(tx, id)));
    }

    /** A new pipeline with its stages (a copy of the default list when none are given). */
    create(input: {
        name: string;
        isDefault?: boolean | undefined;
        stages?: StageInput[] | undefined;
    }): Promise<PipelineView> {
        const context = this.current();
        const stages = input.stages ?? DEFAULT_STAGES.map((s) => ({ ...s }));
        if (stages[0]?.kind !== undefined && stages[0].kind !== 'open') {
            throw new BadRequestException('the first stage must be open: new deals are placed there');
        }
        return this.rls.withWorkspace(async (tx) => {
            if (input.isDefault)
                await tx.pipeline.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
            const pipeline = await tx.pipeline
                .create({
                    data: { workspaceId: context.workspaceId, name: input.name, isDefault: input.isDefault ?? false },
                })
                .catch(conflict('a pipeline with that name exists', 'name'));
            for (const [index, stage] of stages.entries()) {
                await tx.pipelineStage.create({ data: stageData(context.workspaceId, pipeline.id, index + 1, stage) });
            }
            return pipelineView(await findPipeline(tx, pipeline.id));
        });
    }

    update(id: string, patch: { name?: string | undefined; isDefault?: true | undefined }): Promise<PipelineView> {
        return this.rls.withWorkspace(async (tx) => {
            await findPipeline(tx, id);
            if (patch.isDefault)
                await tx.pipeline.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
            await tx.pipeline
                .update({
                    where: { id },
                    data: {
                        ...(patch.name !== undefined ? { name: patch.name } : {}),
                        ...(patch.isDefault ? { isDefault: true } : {}),
                    },
                })
                .catch(conflict('a pipeline with that name exists', 'name'));
            return pipelineView(await findPipeline(tx, id));
        });
    }

    /** Only an empty, non-default pipeline can go; deals in the trash still count. */
    remove(id: string): Promise<void> {
        return this.rls.withWorkspace(async (tx) => {
            const pipeline = await findPipeline(tx, id);
            if (pipeline.isDefault)
                throw new ConflictException('the default pipeline cannot be deleted; make another the default first');
            const deals = await tx.opportunity.count({ where: { pipelineId: id } });
            if (deals > 0)
                throw new ConflictException(
                    `${deals} deal(s) are in this pipeline (including the trash); move them first`,
                );
            await tx.pipeline.delete({ where: { id } });
        });
    }

    // ── Stages ───────────────────────────────────────────────────────────────

    addStage(pipelineId: string, input: StageInput): Promise<StageView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const pipeline = await findPipeline(tx, pipelineId);
            const position = Math.max(0, ...pipeline.stages.map((s) => s.position)) + 1;
            return stageView(
                await tx.pipelineStage.create({ data: stageData(context.workspaceId, pipelineId, position, input) }),
            );
        });
    }

    updateStage(pipelineId: string, stageId: string, patch: StagePatch): Promise<StageView> {
        return this.rls.withWorkspace(async (tx) => {
            const stage = await findStage(tx, pipelineId, stageId);
            if (patch.kind !== undefined && patch.kind !== 'open' && stage.position === 1) {
                throw new BadRequestException('the first stage must stay open: new deals are placed there');
            }
            const data: Prisma.PipelineStageUpdateInput = {};
            if (patch.name !== undefined) data.name = patch.name;
            if (patch.probability !== undefined) data.probability = patch.probability;
            if (patch.kind !== undefined) data.kind = patch.kind;
            if (patch.daysThreshold !== undefined) data.daysThreshold = patch.daysThreshold;
            if (patch.colour !== undefined) data.colour = patch.colour;
            return stageView(await tx.pipelineStage.update({ where: { id: stageId }, data }));
        });
    }

    /**
     * Deletes a stage (P1-2b). A rule pointing at it, or being the pipeline's last stage, refuses.
     * A stage with deals — trashed ones count — goes only when `moveDealsTo` names an open stage of
     * the same pipeline: every deal moves there through the one move service (one history row and,
     * after commit, one `deal.stage_changed` each — a won or lost stage's deals may go to another stage of that kind and stay closed, attributed to the caller), then the stage is
     * deleted and positions close the gap, all in one transaction. This is a configuration change
     * over every deal in the stage, so an own-scoped caller — who sees only their own deals — is
     * refused outright rather than half-served; owner scope does not narrow it for anyone else.
     */
    async removeStage(pipelineId: string, stageId: string, moveDealsTo?: string): Promise<void> {
        const context = this.current();
        if (context.ownerScopeMemberId) {
            throw new Forbidden(
                'deleting a stage moves every deal in it, not only your own; it needs a role that sees all records',
            );
        }
        const actor = actorOf(context);
        await this.rls.withWorkspace(async (tx) => {
            const stage = await findStage(tx, pipelineId, stageId);
            const [liveDeals, trashedDeals, rules, siblings, target] = await Promise.all([
                tx.opportunity.count({ where: { stageId, deletedAt: null } }),
                tx.opportunity.count({ where: { stageId, deletedAt: { not: null } } }),
                tx.stageRule.count({ where: { toStageId: stageId } }),
                tx.pipelineStage.count({ where: { pipelineId } }),
                moveDealsTo === undefined
                    ? Promise.resolve(null)
                    : tx.pipelineStage.findFirst({ where: { id: moveDealsTo, pipelineId } }),
            ]);
            const plan = planStageDelete({
                stageId,
                pipelineId,
                stageKind: stage.kind,
                liveDeals,
                trashedDeals,
                rules,
                siblings,
                moveDealsTo,
                target: target ?? undefined,
                limit: STAGE_DELETE_MOVE_LIMIT,
            });
            const moves = await this.carryOut(tx, context.workspaceId, stage, plan, actor);
            await tx.pipelineStage.delete({ where: { id: stage.id } });
            // Close the gap so positions stay 1..n; the unique constraint is checked at commit.
            await tx.$executeRaw`UPDATE "pipeline_stages" SET "position" = "position" - 1 WHERE "pipeline_id" = ${pipelineId}::uuid AND "position" > ${stage.position}`;
            for (const { dealId, moved: move } of moves) {
                await this.moves.announce(tx, context.workspaceId, dealId, actor, move);
            }
        });
    }

    /** Turns a refusal into its error, or performs the move a plan calls for. */
    private async carryOut(
        tx: WorkspaceClient,
        workspaceId: string,
        stage: StageRow,
        plan: StageDeletePlan,
        actor: EventActor,
    ): Promise<Awaited<ReturnType<StageMoveService['moveAllInStage']>>> {
        switch (plan.kind) {
            case 'delete':
                return [];
            case 'move_then_delete':
                return this.moves.moveAllInStage(
                    tx,
                    workspaceId,
                    { id: stage.id, pipelineId: stage.pipelineId, kind: stage.kind, name: stage.name },
                    plan.target,
                    actor,
                );
            case 'refuse':
                break;
        }
        switch (plan.reason) {
            case 'has_rules':
                throw new StateConflict(`${plan.rules} rule(s) move deals into this stage; change them first`, {
                    rules: plan.rules,
                });
            case 'last_stage':
                throw new StateConflict('a pipeline keeps at least one stage');
            case 'has_deals':
                throw new StateConflict(
                    `${plan.liveDeals + plan.trashedDeals} deal(s) are in this stage (${plan.trashedDeals} in the trash); name a stage to move them to`,
                    { liveDeals: plan.liveDeals, trashedDeals: plan.trashedDeals },
                );
            case 'target_not_found':
                throw new NotFoundException('the stage to move deals to is not in this pipeline');
            case 'target_is_stage':
                throw new ValidationFailed('deals cannot move to the stage being deleted', [
                    { path: 'moveDealsTo', message: 'choose another stage' },
                ]);
            case 'target_not_open':
                throw new ValidationFailed('deals move to an open stage; closing them is a member’s decision', [
                    { path: 'moveDealsTo', message: 'choose an open stage' },
                ]);
            case 'target_other_kind':
                throw new UnprocessableEntityException(
                    `deals of a ${stage.kind} stage move to an open stage or another ${stage.kind} stage`,
                );
            case 'too_many':
                throw new TooLarge(`a stage delete moves at most ${plan.limit} deals; this stage holds ${plan.deals}`, {
                    deals: plan.deals,
                    limit: plan.limit,
                });
        }
    }

    /** `stageIds` is every stage of the pipeline, in the new order. */
    orderStages(pipelineId: string, stageIds: string[]): Promise<PipelineView> {
        return this.rls.withWorkspace(async (tx) => {
            const pipeline = await findPipeline(tx, pipelineId);
            const existing = new Set(pipeline.stages.map((s) => s.id));
            const given = new Set(stageIds);
            if (
                given.size !== stageIds.length ||
                given.size !== existing.size ||
                ![...given].every((id) => existing.has(id))
            ) {
                throw new BadRequestException('stageIds must name every stage of the pipeline exactly once');
            }
            const first = pipeline.stages.find((s) => s.id === stageIds[0]);
            if (first?.kind !== 'open')
                throw new BadRequestException('the first stage must be open: new deals are placed there');
            for (const [index, id] of stageIds.entries()) {
                await tx.pipelineStage.update({ where: { id }, data: { position: index + 1 } });
            }
            return pipelineView(await findPipeline(tx, pipelineId));
        });
    }

    // ── Rules ────────────────────────────────────────────────────────────────

    listRules(pipelineId: string): Promise<RuleView[]> {
        return this.rls.withWorkspace(async (tx) => {
            await findPipeline(tx, pipelineId);
            const rows = await tx.stageRule.findMany({ where: { pipelineId }, orderBy: { createdAt: 'asc' } });
            return rows.map(ruleView);
        });
    }

    createRule(
        pipelineId: string,
        input: {
            event: StageRuleEvent;
            toStageId: string;
            allowBackward?: boolean | undefined;
            enabled?: boolean | undefined;
        },
    ): Promise<RuleView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            await assertRuleTarget(tx, pipelineId, input.toStageId);
            const row = await tx.stageRule
                .create({
                    data: {
                        workspaceId: context.workspaceId,
                        pipelineId,
                        event: storedRuleEvent(input.event),
                        toStageId: input.toStageId,
                        allowBackward: input.allowBackward ?? false,
                        enabled: input.enabled ?? true,
                    },
                })
                .catch(conflict('this pipeline already has a rule for that event', 'event'));
            return ruleView(row);
        });
    }

    updateRule(
        pipelineId: string,
        ruleId: string,
        patch: { toStageId?: string | undefined; allowBackward?: boolean | undefined; enabled?: boolean | undefined },
    ): Promise<RuleView> {
        return this.rls.withWorkspace(async (tx) => {
            const rule = await tx.stageRule.findFirst({ where: { id: ruleId, pipelineId } });
            if (!rule) throw new NotFoundException('rule not found');
            if (patch.toStageId !== undefined) await assertRuleTarget(tx, pipelineId, patch.toStageId);
            const data: Prisma.StageRuleUpdateInput = {};
            if (patch.toStageId !== undefined) data.toStage = { connect: { id: patch.toStageId } };
            if (patch.allowBackward !== undefined) data.allowBackward = patch.allowBackward;
            if (patch.enabled !== undefined) data.enabled = patch.enabled;
            return ruleView(await tx.stageRule.update({ where: { id: ruleId }, data }));
        });
    }

    removeRule(pipelineId: string, ruleId: string): Promise<void> {
        return this.rls.withWorkspace(async (tx) => {
            const result = await tx.stageRule.deleteMany({ where: { id: ruleId, pipelineId } });
            if (result.count === 0) throw new NotFoundException('rule not found');
        });
    }

    // ── Deals in stages ──────────────────────────────────────────────────────

    /**
     * A member's move (`deal:move`). Backward is allowed by hand; the response then names the
     * rules that may move the deal forward again, so nobody wonders why it jumped.
     */
    async move(dealId: string, stageId: string, close: ClosePayload | undefined): Promise<MoveResult> {
        const context = this.current();
        const actor = actorOf(context);
        const { deal, rules } = await this.rls.withWorkspace(async (tx) => {
            const current = await findDeal(tx, context, dealId);
            const outcome = await this.moves.move(tx, current, stageId, actor, {
                reason: 'manual',
                allowBackward: true,
                close,
            });
            const after = await findDeal(tx, context, dealId);
            const wentBackward =
                outcome.outcome === 'moved' &&
                (await tx.pipelineStage.findUnique({ where: { id: outcome.change.toStageId } }))!.position <
                    (await tx.pipelineStage.findUnique({ where: { id: current.stageId } }))!.position;
            const forward = wentBackward
                ? await tx.stageRule.findMany({
                      where: {
                          pipelineId: current.pipelineId,
                          enabled: true,
                          toStage: { position: { gt: after.stage.position } },
                      },
                  })
                : [];
            if (outcome.outcome === 'moved') await this.moves.announce(tx, context.workspaceId, dealId, actor, outcome);
            return { deal: after, rules: forward };
        });
        return { deal: dealView(deal), rulesThatMayMoveItForward: rules.map(ruleView) };
    }

    history(dealId: string, limit: number): Promise<HistoryEntry[]> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            await findDeal(tx, context, dealId);
            const rows = await tx.opportunityStageHistory.findMany({
                where: { opportunityId: dealId },
                orderBy: [{ enteredAt: 'desc' }, { id: 'desc' }],
                take: limit,
            });
            return rows.map((row) => ({
                id: row.id,
                fromStageId: row.fromStageId,
                fromStageName: row.fromStageName,
                toStageId: row.toStageId,
                toStageName: row.toStageName,
                enteredAt: row.enteredAt,
                actor: stored<EventActor>(row.actor),
                reason: row.reason,
            }));
        });
    }

    /**
     * The board: every stage with the deals in it under the caller's scope and the query, and
     * per-stage count and sums over that same set — an own-scoped member's totals are their own.
     * The filter, sort and view parameters are the deal list's, resolved by the same planner
     * (P1-4): one compiler, one call site here.
     */
    board(pipelineId: string, query: RawQuery): Promise<BoardView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const pipeline = await findPipeline(tx, pipelineId);
            const plan = await resolvePlan(tx, context, this.customFields, 'opportunity', query, BOARD_SORT);
            const ids = query.q ? await searchCandidates(tx, 'opportunities', query.q, false) : undefined;
            const where: Prisma.OpportunityWhereInput = {
                pipelineId,
                deletedAt: null,
                ...ownerWhere(context),
                ...(plan.where as Prisma.OpportunityWhereInput),
                ...(ids ? { id: { in: ids } } : {}),
            };
            const columns: BoardColumn[] = [];
            for (const stage of pipeline.stages) {
                const stageWhere = { ...where, stageId: stage.id };
                const [rows, sums] = await Promise.all([
                    tx.opportunity.findMany({
                        where: stageWhere,
                        include: opportunityInclude,
                        orderBy: plan.orderBy as Prisma.OpportunityOrderByWithRelationInput[],
                        take: BOARD_STAGE_LIMIT + 1,
                    }),
                    tx.opportunity.groupBy({
                        by: ['currency'],
                        where: stageWhere,
                        _sum: { amountMinor: true },
                        _count: { _all: true },
                    }),
                ]);
                const amountMinorByCurrency: Record<string, number> = {};
                let count = 0;
                for (const sum of sums) {
                    count += sum._count._all;
                    if (sum._sum.amountMinor !== null)
                        amountMinorByCurrency[sum.currency] = Number(sum._sum.amountMinor);
                }
                columns.push({
                    stage: stageView(stage),
                    count,
                    amountMinorByCurrency,
                    deals: rows.slice(0, BOARD_STAGE_LIMIT).map(dealView),
                    hasMore: rows.length > BOARD_STAGE_LIMIT,
                });
            }
            return { pipeline: pipelineView(pipeline), columns };
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('PipelinesService is used inside a workspace scope');
        return context;
    }
}

const stagesInOrder = { stages: { orderBy: { position: 'asc' as const } } };

async function findPipeline(tx: WorkspaceClient, id: string): Promise<PipelineRow> {
    const row = await tx.pipeline.findUnique({ where: { id }, include: stagesInOrder });
    if (!row) throw new NotFoundException('pipeline not found');
    return row;
}

async function findStage(tx: WorkspaceClient, pipelineId: string, stageId: string): Promise<StageRow> {
    const row = await tx.pipelineStage.findFirst({ where: { id: stageId, pipelineId } });
    if (!row) throw new NotFoundException('stage not found');
    return row;
}

/** A deal the caller can see, with what the move and the view need. */
async function findDeal(tx: WorkspaceClient, context: WorkspaceRunContext, id: string) {
    const row = await tx.opportunity.findFirst({
        where: { id, deletedAt: null, ...ownerWhere(context) },
        include: opportunityInclude,
    });
    if (!row) throw new NotFoundException('opportunity not found');
    return row;
}

/**
 * A rule moves deals only within its pipeline. Its stage may be a won or lost one (INV-1): the rule then closes
 * the deal through the same close path a member's move takes.
 */
async function assertRuleTarget(tx: WorkspaceClient, pipelineId: string, stageId: string): Promise<void> {
    const stage = await findStage(tx, pipelineId, stageId).catch(() => null);
    if (!stage) throw new UnprocessableEntityException('stage is not in this pipeline');
}

export function stageData(
    workspaceId: string,
    pipelineId: string,
    position: number,
    input: StageInput,
): Prisma.PipelineStageUncheckedCreateInput {
    return {
        workspaceId,
        pipelineId,
        name: input.name,
        position,
        probability: input.probability,
        kind: input.kind ?? 'open',
        daysThreshold: input.daysThreshold ?? null,
        colour: input.colour,
    };
}

function conflict(message: string, field: string): (error: unknown) => never {
    return (error: unknown) => {
        throw uniqueViolation(error) ? new UniqueConflict(message, field) : error;
    };
}

export function stageView(row: StageRow): StageView {
    return {
        id: row.id,
        pipelineId: row.pipelineId,
        name: row.name,
        position: row.position,
        probability: row.probability,
        kind: row.kind,
        daysThreshold: row.daysThreshold,
        colour: row.colour as StageColour,
    };
}

function pipelineView(row: PipelineRow): PipelineView {
    return {
        id: row.id,
        name: row.name,
        isDefault: row.isDefault,
        position: row.position,
        stages: row.stages.map(stageView),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function ruleView(row: RuleRow): RuleView {
    return {
        id: row.id,
        pipelineId: row.pipelineId,
        event: ruleEventOf(row.event),
        toStageId: row.toStageId,
        allowBackward: row.allowBackward,
        enabled: row.enabled,
    };
}
