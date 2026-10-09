import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Actor, Address, Links, Money } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { diffOf } from './diff';
import { type Page, paginate, parseSort, type SortSpec } from './list-query';
import type { ListQuery } from './people.service';
import { ownerWhere, resolveOwner } from './record-scope';
import { assertOwnerIsMember, compact, stored } from './references';
import { searchCandidates } from './search';

/** A company as the API returns it (PAR-005). */
export interface CompanyView {
    id: string;
    name: string;
    domain: string | null;
    employeeCount: number | null;
    arr: Money | null;
    address: Address;
    links: Links;
    icp: boolean;
    position: number;
    ownerId: string | null;
    createdBy: Actor;
    custom: Record<string, unknown>;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface CompanyInput {
    name?: string | undefined;
    domain?: string | null | undefined;
    employeeCount?: number | null | undefined;
    arr?: Money | null | undefined;
    address?: Address | undefined;
    links?: Links | undefined;
    icp?: boolean | undefined;
    position?: number | undefined;
    ownerId?: string | null | undefined;
    custom?: Record<string, unknown> | undefined;
}

export const COMPANY_SORT_FIELDS = [
    'createdAt',
    'updatedAt',
    'name',
    'domain',
    'employeeCount',
    'arrAmount',
    'position',
] as const;
type CompanySortField = (typeof COMPANY_SORT_FIELDS)[number];
const DEFAULT_SORT: SortSpec<CompanySortField> = { field: 'createdAt', direction: 'desc' };

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

type CompanyRow = Prisma.CompanyGetPayload<Record<string, never>>;

@Injectable()
export class CompaniesService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
        private readonly events: DomainEvents,
    ) {}

    list(query: ListQuery, deleted = false): Promise<Page<CompanyView>> {
        const context = this.current();
        const sort = parseSort(query.sort, COMPANY_SORT_FIELDS, DEFAULT_SORT);
        return this.rls.withWorkspace(async (tx) => {
            const ids = query.q ? await searchCandidates(tx, 'companies', query.q, deleted) : undefined;
            if (ids && ids.length === 0) return { items: [], nextCursor: null };
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.company.findMany({
                    where: { ...where(context, deleted), ...(ids ? { id: { in: ids } } : {}) },
                    // The field comes from COMPANY_SORT_FIELDS, every one a column of the model.
                    orderBy: [
                        { [sort.field]: sort.direction } as Prisma.CompanyOrderByWithRelationInput,
                        { id: 'asc' },
                    ],
                    ...args,
                }),
            );
            return { items: page.items.map(view), nextCursor: page.nextCursor };
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
            try {
                return await tx.company.create({
                    data: {
                        ...compact(fields(input)),
                        name: input.name,
                        workspaceId: context.workspaceId,
                        ownerId,
                        createdBy: actor,
                        custom,
                    },
                });
            } catch (error) {
                throw uniqueViolation(error) ? conflict() : error;
            }
        });
        this.events.publish({
            type: 'company.created',
            object: 'company',
            workspaceId: context.workspaceId,
            actor,
            occurredAt: new Date().toISOString(),
            recordId: row.id,
        });
        return view(row);
    }

    async update(id: string, patch: CompanyInput): Promise<CompanyView> {
        const context = this.current();
        const { before, after } = await this.rls.withWorkspace(async (tx) => {
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
            try {
                const updated = await tx.company.update({
                    where: { id },
                    data: { ...compact(fields(patch)), ownerId, ...(custom ? { custom } : {}) },
                });
                return { before: current, after: updated };
            } catch (error) {
                throw uniqueViolation(error) ? conflict() : error;
            }
        });
        this.events.publish({
            type: 'company.updated',
            object: 'company',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
            diff: diffOf(view(before), view(after), DIFF_FIELDS),
        });
        return view(after);
    }

    /** Soft. People keep their `companyId`; the company is simply in the trash (PAR-079). */
    async remove(id: string): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const result = await tx.company.updateMany({
                where: { id, ...where(context, false) },
                data: { deletedAt: new Date() },
            });
            if (result.count === 0) throw notFound();
        });
        this.events.publish({
            type: 'company.deleted',
            object: 'company',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
        });
    }

    async restore(id: string): Promise<CompanyView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const result = await tx.company.updateMany({
                where: { id, ...where(context, true) },
                data: { deletedAt: null },
            });
            if (result.count === 0) throw notFound();
            return find(tx, context, id);
        });
        this.events.publish({
            type: 'company.restored',
            object: 'company',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
        });
        return view(row);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('CompaniesService is used inside a workspace scope');
        return context;
    }
}

/** The columns a caller may set. `arr` is one value to the API and two columns in the table. */
function fields(input: CompanyInput) {
    return {
        name: input.name,
        domain: input.domain,
        employeeCount: input.employeeCount,
        arrAmount:
            input.arr === undefined ? undefined : input.arr === null ? null : new Prisma.Decimal(input.arr.amount),
        arrCurrency: input.arr === undefined ? undefined : input.arr === null ? null : input.arr.currency,
        address: input.address,
        links: input.links,
        icp: input.icp,
        position: input.position,
    };
}

function where(context: WorkspaceRunContext, deleted: boolean): Prisma.CompanyWhereInput {
    return { deletedAt: deleted ? { not: null } : null, ...ownerWhere(context) };
}

async function find(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<CompanyRow> {
    const row = await tx.company.findFirst({ where: { id, ...where(context, false) } });
    if (!row) throw notFound();
    return row;
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
            row.arrAmount !== null && row.arrCurrency !== null
                ? { amount: row.arrAmount.toFixed(2), currency: row.arrCurrency }
                : null,
        address: stored<Address>(row.address),
        links: stored<Links>(row.links),
        icp: row.icp,
        position: row.position,
        ownerId: row.ownerId,
        createdBy: stored<Actor>(row.createdBy),
        custom: stored<Record<string, unknown>>(row.custom),
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
