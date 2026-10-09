import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Actor, Address, DomainEvent, Links } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import type { BulkRecords } from './bulk/bulk.service';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { diffOf } from './diff';
import { type CountedPage, countTotal, EMPTY_COUNTED_PAGE, paginate } from './list-query';
import type { ListQuery } from './people.service';
import { listScope } from '../query/query.service';
import { countRows } from '../query/rows';
import { recordWhere, resolveOwner } from './record-scope';
import { assertOwnerIsMember, compact, moneyColumns, type MoneyInput, stored } from './references';
import { type CompanyView } from './responses';
import { MEMBER_SUMMARY_SELECT, memberSummary } from './summaries';
export type { CompanyView } from './responses';

export interface CompanyInput {
    name?: string | undefined;
    domain?: string | null | undefined;
    employeeCount?: number | null | undefined;
    arr?: MoneyInput | null | undefined;
    address?: Address | undefined;
    links?: Links | undefined;
    icp?: boolean | undefined;
    position?: number | undefined;
    ownerId?: string | null | undefined;
    custom?: Record<string, unknown> | undefined;
}

const DIFF_FIELDS = [
    'name',
    'domain',
    'employeeCount',
    'arr',
    'address',
    'links',
    'icp',
    'position',
    'ownerId',
    'custom',
] as const;

/** What every company read loads beside the row: its owner by name (P1-4a). */
const companyInclude = { owner: { select: MEMBER_SUMMARY_SELECT } } as const;
type CompanyRow = Prisma.CompanyGetPayload<{ include: typeof companyInclude }>;

@Injectable()
export class CompaniesService implements BulkRecords {
    readonly object = 'company' as const;
    readonly editCapability = 'record:write' as const;

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
        private readonly events: DomainEvents,
    ) {}

    /** Live companies, or the trash when `deleted`; the page and its total read one `where`. */
    list(query: ListQuery, deleted = false): Promise<CountedPage<CompanyView>> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const scope = await listScope(tx, context, this.customFields, 'company', query, deleted);
            if (scope.empty) return EMPTY_COUNTED_PAGE;
            const where = scope.where as Prisma.CompanyWhereInput;
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.company.findMany({
                    where,
                    include: companyInclude,
                    orderBy: scope.plan.orderBy as Prisma.CompanyOrderByWithRelationInput[],
                    ...args,
                }),
            );
            const totals = await countTotal((take) => countRows(tx, 'company', where, take), scope.candidatesCapped);
            return { items: page.items.map(view), nextCursor: page.nextCursor, ...totals };
        });
    }

    get(id: string): Promise<CompanyView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => view(await find(tx, context, id)));
    }

    async create(input: CompanyInput & { name: string }): Promise<CompanyView> {
        const context = this.current();
        const actor = actorOf(context);
        const row = await this.rls.withWorkspace(async (tx) => {
            const ownerId = resolveOwner(context, input.ownerId, undefined);
            await assertOwnerIsMember(tx, ownerId);
            const custom = await this.customFields.validated(tx, 'company', input.custom ?? {}, 'create');
            const arr = await moneyColumns(tx, context.workspaceId, input.arr);
            try {
                return await tx.company.create({
                    data: {
                        ...compact(fields(input)),
                        ...arrColumns(arr),
                        name: input.name,
                        workspaceId: context.workspaceId,
                        ownerId,
                        createdBy: actor,
                        custom,
                    },
                    include: companyInclude,
                });
            } catch (error) {
                throw uniqueViolation(error) ? conflict() : error;
            }
        });
        this.events.publish(event(context, 'company.created', row.id));
        return view(row);
    }

    async update(id: string, patch: CompanyInput): Promise<CompanyView> {
        const context = this.current();
        const { after, event } = await this.rls.withWorkspace((tx) => this.updateIn(tx, context, id, patch));
        this.events.publish(event);
        return view(after);
    }

    /** Soft. People keep their `companyId`; the company is simply in the trash (PAR-079). */
    async remove(id: string): Promise<void> {
        const context = this.current();
        const { event } = await this.rls.withWorkspace((tx) => this.removeIn(tx, context, id));
        this.events.publish(event);
    }

    async restore(id: string): Promise<CompanyView> {
        const context = this.current();
        const { row, event } = await this.rls.withWorkspace((tx) => this.restoreIn(tx, context, id));
        this.events.publish(event);
        return view(row);
    }

    // The writes inside a caller's transaction — the single routes and the bulk service (P1-4a)
    // both run these; each returns the event for the caller to publish after commit.

    async updateIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        id: string,
        patch: CompanyInput,
    ): Promise<{ after: CompanyRow; event: DomainEvent }> {
        const current = await find(tx, context, id);
        const ownerId = resolveOwner(context, patch.ownerId, current.ownerId);
        if (ownerId !== current.ownerId) await assertOwnerIsMember(tx, ownerId);
        const custom = patch.custom
            ? await this.customFields.validated(
                  tx,
                  'company',
                  patch.custom,
                  'patch',
                  stored<Record<string, unknown>>(current.custom),
              )
            : undefined;
        const arr = await moneyColumns(tx, context.workspaceId, patch.arr);
        try {
            const after = await tx.company.update({
                where: { id },
                data: { ...compact(fields(patch)), ...arrColumns(arr), ownerId, ...(custom ? { custom } : {}) },
                include: companyInclude,
            });
            return {
                after,
                event: event(context, 'company.updated', id, diffOf(view(current), view(after), DIFF_FIELDS)),
            };
        } catch (error) {
            throw uniqueViolation(error) ? conflict() : error;
        }
    }

    async removeIn(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<{ event: DomainEvent }> {
        const result = await tx.company.updateMany({
            where: { id, ...recordWhere(context, false) },
            data: { deletedAt: new Date() },
        });
        if (result.count === 0) throw notFound();
        return { event: event(context, 'company.deleted', id) };
    }

    async restoreIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        id: string,
    ): Promise<{ row: CompanyRow; event: DomainEvent }> {
        const result = await tx.company.updateMany({
            where: { id, ...recordWhere(context, true) },
            data: { deletedAt: null },
        });
        if (result.count === 0) throw notFound();
        return { row: await find(tx, context, id), event: event(context, 'company.restored', id) };
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('CompaniesService is used inside a workspace scope');
        return context;
    }
}

/** The plain columns a caller may set; `arr` is resolved by `moneyColumns` and named by `arrColumns`. */
function fields(input: CompanyInput) {
    return {
        name: input.name,
        domain: input.domain,
        employeeCount: input.employeeCount,
        address: input.address,
        links: input.links,
        icp: input.icp,
        position: input.position,
    };
}

/** `arr` is one value to the API and the `arr_minor` + `arr_currency` pair in the table. */
function arrColumns(money: { amountMinor?: bigint | null; currency?: string | null }) {
    return {
        ...(money.amountMinor !== undefined ? { arrMinor: money.amountMinor } : {}),
        ...(money.currency !== undefined ? { arrCurrency: money.currency } : {}),
    };
}

async function find(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<CompanyRow> {
    const row = await tx.company.findFirst({ where: { id, ...recordWhere(context, false) }, include: companyInclude });
    if (!row) throw notFound();
    return row;
}

function event(
    context: WorkspaceRunContext,
    type: 'company.created' | 'company.updated' | 'company.deleted' | 'company.restored',
    recordId: string,
    diff?: DomainEvent['diff'],
): DomainEvent {
    return {
        type,
        object: 'company',
        workspaceId: context.workspaceId,
        actor: actorOf(context),
        occurredAt: new Date().toISOString(),
        recordId,
        ...(diff ? { diff } : {}),
    };
}

function notFound(): NotFoundException {
    return new NotFoundException('company not found');
}

function conflict(): ConflictException {
    return new ConflictException({ message: 'a company with that domain exists', field: 'domain' });
}

export function view(row: CompanyRow): CompanyView {
    return {
        id: row.id,
        name: row.name,
        domain: row.domain,
        employeeCount: row.employeeCount,
        arr:
            row.arrMinor !== null && row.arrCurrency !== null
                ? { amountMinor: Number(row.arrMinor), currency: row.arrCurrency }
                : null,
        address: stored<Address>(row.address),
        links: stored<Links>(row.links),
        icp: row.icp,
        position: row.position,
        ownerId: row.ownerId,
        owner: memberSummary(row.owner),
        createdBy: stored<Actor>(row.createdBy),
        custom: stored<Record<string, unknown>>(row.custom),
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
