import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Actor, Money } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { StageMoveService } from '../pipelines/stage-move.service';
import { daysInStage } from '../pipelines/stage-moves';
import { actorOf } from './actor';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { diffOf } from './diff';
import { type Page, paginate } from './list-query';
import type { ListQuery } from './people.service';
import { resolvePlan } from '../query/query.service';
import { ownerWhere, resolveOwner } from './record-scope';
import {
    assertCompanyExists,
    assertOwnerIsMember,
    assertPersonExists,
    compact,
    defaultCurrency,
    moneyColumns,
    type MoneyInput,
    stored,
} from './references';
import { searchCandidates } from './search';

/** A deal as the API returns it (PAR-007), with its place in its pipeline (P1-2). */
export interface OpportunityView {
    id: string;
    name: string;
    pipelineId: string;
    stageId: string;
    /** When the deal entered its current stage: the latest history row, never a column. */
    stageEnteredAt: Date;
    /** Whole days since `stageEnteredAt`, computed at read time. */
    daysInStage: number;
    /** Set while the deal is in a won or lost stage. */
    closedAt: Date | null;
    lostReason: string | null;
    /** `null` until an amount is known; the currency is always the deal's. */
    amount: Money | null;
    currency: string;
    /** A calendar date, `YYYY-MM-DD`, or `null`. */
    closeDate: string | null;
    probability: number | null;
    position: number;
    ownerId: string | null;
    pointOfContactId: string | null;
    companyId: string | null;
    createdBy: Actor;
    custom: Record<string, unknown>;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface OpportunityInput {
    name?: string | undefined;
    /** Create only: where the deal starts. Defaults to the default pipeline's first stage. */
    pipelineId?: string | undefined;
    stageId?: string | undefined;
    amount?: MoneyInput | null | undefined;
    closeDate?: string | null | undefined;
    probability?: number | null | undefined;
    position?: number | undefined;
    ownerId?: string | null | undefined;
    pointOfContactId?: string | null | undefined;
    companyId?: string | null | undefined;
    custom?: Record<string, unknown> | undefined;
}

const DIFF_FIELDS = [
    'name',
    'closedAt',
    'lostReason',
    'amount',
    'currency',
    'closeDate',
    'probability',
    'position',
    'ownerId',
    'pointOfContactId',
    'companyId',
    'custom',
] as const;

/** The deal's current stage and its latest history row, which say where it is and since when. */
export const withStageInclude = {
    stage: true,
    stageHistory: { orderBy: { enteredAt: 'desc' as const }, take: 1 },
} as const;
type OpportunityRow = Prisma.OpportunityGetPayload<{ include: typeof withStageInclude }>;

@Injectable()
export class OpportunitiesService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
        private readonly events: DomainEvents,
        private readonly moves: StageMoveService,
    ) {}

    list(query: ListQuery, deleted = false): Promise<Page<OpportunityView>> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const plan = await resolvePlan(tx, context, this.customFields, 'opportunity', query);
            const ids = query.q ? await searchCandidates(tx, 'opportunities', query.q, deleted) : undefined;
            if (ids && ids.length === 0) return { items: [], nextCursor: null };
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.opportunity.findMany({
                    where: {
                        ...where(context, deleted),
                        ...(plan.where as Prisma.OpportunityWhereInput),
                        ...(ids ? { id: { in: ids } } : {}),
                    },
                    include: withStageInclude,
                    orderBy: plan.orderBy as Prisma.OpportunityOrderByWithRelationInput[],
                    ...args,
                }),
            );
            return { items: page.items.map(view), nextCursor: page.nextCursor };
        });
    }

    get(id: string): Promise<OpportunityView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => view(await find(tx, context, id)));
    }

    async create(input: OpportunityInput & { name: string }): Promise<OpportunityView> {
        const context = this.current();
        const actor = actorOf(context);
        const row = await this.rls.withWorkspace(async (tx) => {
            const ownerId = resolveOwner(context, input.ownerId, undefined);
            await assertOwnerIsMember(tx, ownerId);
            await assertCompanyExists(tx, input.companyId ?? null);
            await assertPersonExists(tx, input.pointOfContactId ?? null);
            const custom = await this.customFields.validated(tx, 'opportunity', input.custom ?? {}, 'create');
            // A deal always has a currency, amount or not: the workspace's unless the caller named one.
            const money = await moneyColumns(tx, context.workspaceId, input.amount ?? null);
            const currency = input.amount?.currency ?? (await defaultCurrency(tx, context.workspaceId));
            const placement = await startingStage(tx, input.pipelineId, input.stageId);
            const created = await tx.opportunity.create({
                data: {
                    ...compact(fields(input)),
                    name: input.name,
                    amountMinor: money.amountMinor ?? null,
                    currency,
                    workspaceId: context.workspaceId,
                    ownerId,
                    createdBy: actor,
                    custom,
                    ...placement,
                },
            });
            await this.moves.place(tx, created, actor, 'manual');
            return find(tx, context, created.id);
        });
        this.events.publish({
            type: 'opportunity.created',
            object: 'opportunity',
            workspaceId: context.workspaceId,
            actor,
            occurredAt: new Date().toISOString(),
            recordId: row.id,
        });
        return view(row);
    }

    /** Partial. `amount: null` clears the amount and keeps the currency; `custom` is merged key by key. */
    async update(id: string, patch: OpportunityInput): Promise<OpportunityView> {
        const context = this.current();
        const { before, after } = await this.rls.withWorkspace(async (tx) => {
            const current = await find(tx, context, id);
            const ownerId = resolveOwner(context, patch.ownerId, current.ownerId);
            if (ownerId !== current.ownerId) await assertOwnerIsMember(tx, ownerId);
            if (patch.companyId != null && patch.companyId !== current.companyId) {
                await assertCompanyExists(tx, patch.companyId);
            }
            if (patch.pointOfContactId != null && patch.pointOfContactId !== current.pointOfContactId) {
                await assertPersonExists(tx, patch.pointOfContactId);
            }
            const custom = patch.custom
                ? await this.customFields.validated(
                      tx,
                      'opportunity',
                      patch.custom,
                      'patch',
                      stored<Record<string, unknown>>(current.custom),
                  )
                : undefined;
            // `amount: null` clears the amount and keeps the deal's currency; a value may change it.
            const resolved = await moneyColumns(tx, context.workspaceId, patch.amount);
            const money =
                patch.amount === undefined
                    ? {}
                    : patch.amount === null
                      ? { amountMinor: null }
                      : {
                            amountMinor: resolved.amountMinor,
                            ...(patch.amount.currency ? { currency: patch.amount.currency } : {}),
                        };
            const updated = await tx.opportunity.update({
                where: { id },
                data: { ...compact(fields(patch)), ...money, ownerId, ...(custom ? { custom } : {}) },
                include: withStageInclude,
            });
            return { before: current, after: updated };
        });
        this.events.publish({
            type: 'opportunity.updated',
            object: 'opportunity',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
            diff: diffOf(view(before), view(after), DIFF_FIELDS),
        });
        return view(after);
    }

    async remove(id: string): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const result = await tx.opportunity.updateMany({
                where: { id, ...where(context, false) },
                data: { deletedAt: new Date() },
            });
            if (result.count === 0) throw notFound();
        });
        this.events.publish({
            type: 'opportunity.deleted',
            object: 'opportunity',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
        });
    }

    async restore(id: string): Promise<OpportunityView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const result = await tx.opportunity.updateMany({
                where: { id, ...where(context, true) },
                data: { deletedAt: null },
            });
            if (result.count === 0) throw notFound();
            return find(tx, context, id);
        });
        this.events.publish({
            type: 'opportunity.restored',
            object: 'opportunity',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
        });
        return view(row);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('OpportunitiesService is used inside a workspace scope');
        return context;
    }
}

/** The plain columns a caller may set; the amount, owner and bookkeeping are added by the service. */
function fields(input: OpportunityInput) {
    return {
        name: input.name,
        // pipelineId / stageId are placement (create) and moves (P1-2); never plain columns here.
        closeDate:
            input.closeDate === undefined ? undefined : input.closeDate === null ? null : dateOnly(input.closeDate),
        probability: input.probability,
        position: input.position,
        pointOfContactId: input.pointOfContactId,
        companyId: input.companyId,
    };
}

function where(context: WorkspaceRunContext, deleted: boolean): Prisma.OpportunityWhereInput {
    return { deletedAt: deleted ? { not: null } : null, ...ownerWhere(context) };
}

async function find(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<OpportunityRow> {
    const row = await tx.opportunity.findFirst({ where: { id, ...where(context, false) }, include: withStageInclude });
    if (!row) throw notFound();
    return row;
}

/**
 * Where a new deal starts: the stage named (which must belong to the pipeline named or, with no
 * pipeline, to the default one), else the first stage of the pipeline named or of the default.
 * The stage must be open — a deal is not born closed.
 */
async function startingStage(
    tx: WorkspaceClient,
    pipelineId: string | undefined,
    stageId: string | undefined,
): Promise<{ pipelineId: string; stageId: string }> {
    const pipeline = pipelineId
        ? await tx.pipeline.findUnique({ where: { id: pipelineId }, select: { id: true } })
        : await tx.pipeline.findFirst({ where: { isDefault: true }, select: { id: true } });
    if (!pipeline)
        throw new UnprocessableEntityException(
            pipelineId ? 'pipeline not found' : 'this workspace has no default pipeline',
        );
    const stage = stageId
        ? await tx.pipelineStage.findFirst({ where: { id: stageId, pipelineId: pipeline.id } })
        : await tx.pipelineStage.findFirst({ where: { pipelineId: pipeline.id }, orderBy: { position: 'asc' } });
    if (!stage)
        throw new UnprocessableEntityException(stageId ? 'stage is not in that pipeline' : 'pipeline has no stages');
    if (stage.kind !== 'open') throw new UnprocessableEntityException('a deal starts in an open stage');
    return { pipelineId: pipeline.id, stageId: stage.id };
}

function notFound(): NotFoundException {
    return new NotFoundException('opportunity not found');
}

/** A `YYYY-MM-DD` string as the UTC midnight the `DATE` column stores it from. */
function dateOnly(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
}

/** The view of a row loaded with `withStageInclude`. */
export function withStage(row: OpportunityRow): OpportunityView {
    return view(row);
}

export function view(row: OpportunityRow): OpportunityView {
    const entered = row.stageHistory[0]?.enteredAt ?? row.createdAt;
    return {
        id: row.id,
        name: row.name,
        pipelineId: row.pipelineId,
        stageId: row.stageId,
        stageEnteredAt: entered,
        daysInStage: daysInStage(entered),
        closedAt: row.closedAt,
        lostReason: row.lostReason,
        amount: row.amountMinor === null ? null : { amountMinor: Number(row.amountMinor), currency: row.currency },
        currency: row.currency,
        closeDate: row.closeDate ? row.closeDate.toISOString().slice(0, 10) : null,
        probability: row.probability,
        position: row.position,
        ownerId: row.ownerId,
        pointOfContactId: row.pointOfContactId,
        companyId: row.companyId,
        createdBy: stored<Actor>(row.createdBy),
        custom: stored<Record<string, unknown>>(row.custom),
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
