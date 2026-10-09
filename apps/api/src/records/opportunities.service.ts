import { Injectable, NotFoundException } from '@nestjs/common';
import type { Actor, MinorMoney } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { diffOf } from './diff';
import { type Page, paginate, parseSort, type SortSpec } from './list-query';
import type { ListQuery } from './people.service';
import { ownerWhere, resolveOwner } from './record-scope';
import { assertCompanyExists, assertOwnerIsMember, assertPersonExists, compact, stored } from './references';
import { searchCandidates } from './search';

/** A deal as the API returns it (PAR-007). Stage and pipeline arrive with P1-2. */
export interface OpportunityView {
    id: string;
    name: string;
    /** `null` until an amount is known; the currency is always the deal's. */
    amount: MinorMoney | null;
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
    amount?: { amountMinor: number; currency?: string | undefined } | null | undefined;
    closeDate?: string | null | undefined;
    probability?: number | null | undefined;
    position?: number | undefined;
    ownerId?: string | null | undefined;
    pointOfContactId?: string | null | undefined;
    companyId?: string | null | undefined;
    custom?: Record<string, unknown> | undefined;
}

export const OPPORTUNITY_SORT_FIELDS = [
    'createdAt',
    'updatedAt',
    'name',
    'amountMinor',
    'closeDate',
    'probability',
    'position',
] as const;
type OpportunitySortField = (typeof OPPORTUNITY_SORT_FIELDS)[number];
const DEFAULT_SORT: SortSpec<OpportunitySortField> = { field: 'createdAt', direction: 'desc' };

const DIFF_FIELDS = [
    'name',
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

type OpportunityRow = Prisma.OpportunityGetPayload<Record<string, never>>;

@Injectable()
export class OpportunitiesService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
        private readonly events: DomainEvents,
    ) {}

    list(query: ListQuery, deleted = false): Promise<Page<OpportunityView>> {
        const context = this.current();
        const sort = parseSort(query.sort, OPPORTUNITY_SORT_FIELDS, DEFAULT_SORT);
        return this.rls.withWorkspace(async (tx) => {
            const ids = query.q ? await searchCandidates(tx, 'opportunities', query.q, deleted) : undefined;
            if (ids && ids.length === 0) return { items: [], nextCursor: null };
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.opportunity.findMany({
                    where: { ...where(context, deleted), ...(ids ? { id: { in: ids } } : {}) },
                    orderBy: [
                        { [sort.field]: sort.direction } as Prisma.OpportunityOrderByWithRelationInput,
                        { id: 'asc' },
                    ],
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
            const currency = input.amount?.currency ?? (await defaultCurrency(tx, context.workspaceId));
            return tx.opportunity.create({
                data: {
                    ...compact(fields(input)),
                    name: input.name,
                    amountMinor: input.amount ? BigInt(input.amount.amountMinor) : null,
                    currency,
                    workspaceId: context.workspaceId,
                    ownerId,
                    createdBy: actor,
                    custom,
                },
            });
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
            const money =
                patch.amount === undefined
                    ? {}
                    : patch.amount === null
                      ? { amountMinor: null }
                      : {
                            amountMinor: BigInt(patch.amount.amountMinor),
                            ...(patch.amount.currency ? { currency: patch.amount.currency } : {}),
                        };
            const updated = await tx.opportunity.update({
                where: { id },
                data: { ...compact(fields(patch)), ...money, ownerId, ...(custom ? { custom } : {}) },
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
        closeDate:
            input.closeDate === undefined ? undefined : input.closeDate === null ? null : dateOnly(input.closeDate),
        probability: input.probability,
        position: input.position,
        pointOfContactId: input.pointOfContactId,
        companyId: input.companyId,
    };
}

/** The workspace's default currency, read under the policy that lets a workspace see itself. */
async function defaultCurrency(tx: WorkspaceClient, workspaceId: string): Promise<string> {
    const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { defaultCurrency: true } });
    if (!workspace) throw new Error('the current workspace is not readable');
    return workspace.defaultCurrency;
}

function where(context: WorkspaceRunContext, deleted: boolean): Prisma.OpportunityWhereInput {
    return { deletedAt: deleted ? { not: null } : null, ...ownerWhere(context) };
}

async function find(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<OpportunityRow> {
    const row = await tx.opportunity.findFirst({ where: { id, ...where(context, false) } });
    if (!row) throw notFound();
    return row;
}

function notFound(): NotFoundException {
    return new NotFoundException('opportunity not found');
}

/** A `YYYY-MM-DD` string as the UTC midnight the `DATE` column stores it from. */
function dateOnly(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
}

export function view(row: OpportunityRow): OpportunityView {
    return {
        id: row.id,
        name: row.name,
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
