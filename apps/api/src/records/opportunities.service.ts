import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Actor, DomainEvent } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { StageMoveService } from '../pipelines/stage-move.service';
import { daysInStage } from '../pipelines/stage-moves';
import { actorOf } from './actor';
import type { BulkRecords } from './bulk/bulk.service';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { diffOf, isEmpty, projectedChanges } from './diff';
import { type CountedPage, countTotal, EMPTY_COUNTED_PAGE, paginate } from './list-query';
import type { ListQuery } from './people.service';
import { listScope } from '../query/query.service';
import { countRows } from '../query/rows';
import { recordWhere, resolveOwner } from './record-scope';
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
import { type OpportunityView } from './responses';
import {
    COMPANY_SUMMARY_SELECT,
    companySummary,
    MEMBER_SUMMARY_SELECT,
    memberSummary,
    PERSON_SUMMARY_SELECT,
    personSummary,
} from './summaries';
export type { OpportunityView } from './responses';

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

/**
 * What every deal read loads beside the row: its current stage and latest history row (where it
 * is and since when), and its company, point of contact and owner by name (P1-4a). The board
 * reads deals with it too, so a card and a list row are the same view.
 */
export const opportunityInclude = {
    stage: true,
    stageHistory: { orderBy: { enteredAt: 'desc' as const }, take: 1 },
    company: { select: COMPANY_SUMMARY_SELECT },
    pointOfContact: { select: PERSON_SUMMARY_SELECT },
    owner: { select: MEMBER_SUMMARY_SELECT },
} as const;
type OpportunityRow = Prisma.OpportunityGetPayload<{ include: typeof opportunityInclude }>;

@Injectable()
export class OpportunitiesService implements BulkRecords {
    readonly object = 'opportunity' as const;

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
        private readonly events: DomainEvents,
        private readonly moves: StageMoveService,
    ) {}

    /** Live deals, or the trash when `deleted`; the page and its total read one `where`. */
    list(query: ListQuery, deleted = false): Promise<CountedPage<OpportunityView>> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const scope = await listScope(tx, context, this.customFields, 'opportunity', query, deleted);
            if (scope.empty) return EMPTY_COUNTED_PAGE;
            const where = scope.where as Prisma.OpportunityWhereInput;
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.opportunity.findMany({
                    where,
                    include: opportunityInclude,
                    orderBy: scope.plan.orderBy as Prisma.OpportunityOrderByWithRelationInput[],
                    ...args,
                }),
            );
            const totals = await countTotal(
                (take) => countRows(tx, 'opportunity', where, take),
                scope.candidatesCapped,
            );
            return { items: page.items.map(view), nextCursor: page.nextCursor, ...totals };
        });
    }

    get(id: string): Promise<OpportunityView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => view(await find(tx, context, id)));
    }

    async create(input: OpportunityInput & { name: string }): Promise<OpportunityView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const created = await this.createIn(tx, context, input);
            await this.events.record(tx, created.event);
            return created.row;
        });
        return view(row);
    }

    /** Creates a deal in its starting stage, with its first history row (placed by hand, or by an import). */
    async createIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        input: OpportunityInput & { name: string },
    ): Promise<{ row: OpportunityRow; event: DomainEvent }> {
        const actor = actorOf(context);
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
        await this.moves.place(tx, created, actor, actor.kind === 'import' ? 'import' : 'manual');
        return { row: await find(tx, context, created.id), event: event(context, 'opportunity.created', created.id) };
    }

    /** Partial. `amount: null` clears the amount and keeps the currency; `custom` is merged key by key. */
    async update(id: string, patch: OpportunityInput): Promise<OpportunityView> {
        const context = this.current();
        const { after } = await this.rls.withWorkspace(async (tx) => {
            const result = await this.updateIn(tx, context, id, patch);
            if (result.event) await this.events.record(tx, result.event);
            return result;
        });
        return view(after);
    }

    async remove(id: string): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const { event } = await this.removeIn(tx, context, id);
            await this.events.record(tx, event);
        });
    }

    async restore(id: string): Promise<OpportunityView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const restored = await this.restoreIn(tx, context, id);
            await this.events.record(tx, restored.event);
            return restored.row;
        });
        return view(row);
    }

    // The writes inside a caller's transaction — the single routes and the bulk service (P1-4a)
    // both run these; each returns the event for the caller to record in the same transaction (P1-6).

    async updateIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        id: string,
        patch: OpportunityInput,
    ): Promise<{ after: OpportunityRow; event: DomainEvent | null }> {
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
        const data = { ...compact(fields(patch)), ...money, ownerId, ...(custom ? { custom } : {}) };
        // Nothing would change: no write, no `updated` event, the record as it was.
        if (isEmpty(projectedChanges(current, data, view, DIFF_FIELDS))) return { after: current, event: null };
        const after = await tx.opportunity.update({ where: { id }, data, include: opportunityInclude });
        return {
            after,
            event: event(context, 'opportunity.updated', id, diffOf(view(current), view(after), DIFF_FIELDS)),
        };
    }

    async removeIn(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<{ event: DomainEvent }> {
        const result = await tx.opportunity.updateMany({
            where: { id, ...recordWhere(context, false) },
            data: { deletedAt: new Date() },
        });
        if (result.count === 0) throw notFound();
        return { event: event(context, 'opportunity.deleted', id) };
    }

    async restoreIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        id: string,
    ): Promise<{ row: OpportunityRow; event: DomainEvent }> {
        const result = await tx.opportunity.updateMany({
            where: { id, ...recordWhere(context, true) },
            data: { deletedAt: null },
        });
        if (result.count === 0) throw notFound();
        return { row: await find(tx, context, id), event: event(context, 'opportunity.restored', id) };
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

async function find(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<OpportunityRow> {
    const row = await tx.opportunity.findFirst({
        where: { id, ...recordWhere(context, false) },
        include: opportunityInclude,
    });
    if (!row) throw notFound();
    return row;
}

function event(
    context: WorkspaceRunContext,
    type: 'opportunity.created' | 'opportunity.updated' | 'opportunity.deleted' | 'opportunity.restored',
    recordId: string,
    diff?: DomainEvent['diff'],
): DomainEvent {
    return {
        type,
        object: 'opportunity',
        workspaceId: context.workspaceId,
        actor: actorOf(context),
        occurredAt: new Date().toISOString(),
        recordId,
        ...(diff ? { diff } : {}),
    };
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
        owner: memberSummary(row.owner),
        pointOfContact: personSummary(row.pointOfContact),
        company: companySummary(row.company),
        createdBy: stored<Actor>(row.createdBy),
        custom: stored<Record<string, unknown>>(row.custom),
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
