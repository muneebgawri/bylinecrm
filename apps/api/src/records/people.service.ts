import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Actor, DomainEvent, Emails, FilterGroup, Links, Phones } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { UniqueConflict } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import type { BulkRecords } from './bulk/bulk.service';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { CompanyOwnership, companyDomainOfAddress } from './company-ownership';
import { requireCallerMember } from '../infra/caller-member';
import { TransfersService } from '../transfers/transfers.service';
import { diffOf, isEmpty, projectedChanges } from './diff';
import { type CountedPage, countTotal, EMPTY_COUNTED_PAGE, paginate } from './list-query';
import { listScope } from '../query/query.service';
import { countRows } from '../query/rows';
import { recordWhere, resolveOwner } from './record-scope';
import { assertCompanyExists, assertOwnerIsMember, compact, stored } from './references';
import { type PersonView } from './responses';
import { COMPANY_SUMMARY_SELECT, companySummary, MEMBER_SUMMARY_SELECT, memberSummary } from './summaries';
export type { PersonView } from './responses';

export interface PersonInput {
    nameFirst?: string | undefined;
    nameLast?: string | undefined;
    emails?: Emails | undefined;
    phones?: Phones | undefined;
    jobTitle?: string | null | undefined;
    city?: string | null | undefined;
    source?: string | null | undefined;
    country?: string | null | undefined;
    links?: Links | undefined;
    avatarUrl?: string | null | undefined;
    position?: number | undefined;
    companyId?: string | null | undefined;
    ownerId?: string | null | undefined;
    custom?: Record<string, unknown> | undefined;
    /**
     * OWN-2: the address's company is another member's — save the person for them instead. Only on
     * create; the person is theirs at once, and they are told (a `forced` transfer from the saver).
     */
    handToOwner?: boolean | undefined;
}

/** A record list request: paging, plus the filter, sort, view and search the planner resolves (P1-4). */
export interface ListQuery {
    cursor?: string | undefined;
    limit: number;
    sort?: string | undefined;
    /** Base64url JSON over the query string, or the parsed grammar from a `POST …/query` body. */
    filter?: string | FilterGroup | undefined;
    view?: string | undefined;
    q?: string | undefined;
}

/** The fields an `updated` event reports changes to. */
const DIFF_FIELDS = [
    'nameFirst',
    'nameLast',
    'emails',
    'phones',
    'jobTitle',
    'city',
    'source',
    'country',
    'links',
    'avatarUrl',
    'position',
    'companyId',
    'ownerId',
    'custom',
] as const;

/** What every person read loads beside the row: its company and owner by name (P1-4a). */
const personInclude = {
    company: { select: COMPANY_SUMMARY_SELECT },
    owner: { select: MEMBER_SUMMARY_SELECT },
} as const;
type PersonRow = Prisma.PersonGetPayload<{ include: typeof personInclude }>;

@Injectable()
export class PeopleService implements BulkRecords {
    readonly object = 'person' as const;

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
        private readonly events: DomainEvents,
        private readonly ownership: CompanyOwnership,
        private readonly transfers: TransfersService,
    ) {}

    /** Live people, or the trash when `deleted`; the page and its total read one `where`. */
    list(query: ListQuery, deleted = false): Promise<CountedPage<PersonView>> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const scope = await listScope(tx, context, this.customFields, 'person', query, deleted);
            if (scope.empty) return EMPTY_COUNTED_PAGE;
            const where = scope.where as Prisma.PersonWhereInput;
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.person.findMany({
                    where,
                    include: personInclude,
                    orderBy: scope.plan.orderBy as Prisma.PersonOrderByWithRelationInput[],
                    ...args,
                }),
            );
            const totals = await countTotal((take) => countRows(tx, 'person', where, take), scope.candidatesCapped);
            return { items: page.items.map(view), nextCursor: page.nextCursor, ...totals };
        });
    }

    get(id: string): Promise<PersonView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => view(await find(tx, context, id)));
    }

    async create(input: PersonInput): Promise<PersonView> {
        const context = this.current();
        if (input.handToOwner) {
            const handed = await this.handToOwner(context, input);
            if (handed) return handed;
        }
        const row = await this.rls.withWorkspace(async (tx) => {
            const created = await this.createIn(tx, context, input);
            await this.events.record(tx, created.event);
            return created.row;
        });
        return view(row);
    }

    /** Partial: a composite (`emails`, `phones`, `links`) is replaced whole; `custom` is merged key by key. */
    async update(id: string, patch: PersonInput): Promise<PersonView> {
        const context = this.current();
        const { after } = await this.rls.withWorkspace(async (tx) => {
            const result = await this.updateIn(tx, context, id, patch);
            if (result.event) await this.events.record(tx, result.event);
            return result;
        });
        return view(after);
    }

    /** Soft: the row keeps its data and its place in the uniqueness index (PAR-079). */
    async remove(id: string): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const { event } = await this.removeIn(tx, context, id);
            await this.events.record(tx, event);
        });
    }

    async restore(id: string): Promise<PersonView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const restored = await this.restoreIn(tx, context, id);
            await this.events.record(tx, restored.event);
            return restored.row;
        });
        return view(row);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The writes, inside a caller's transaction: the single routes above and the bulk service
    // (P1-4a) both run these, so one record changed by either is changed — and announced — alike.
    // The event is returned for the caller to record in the same transaction (P1-6).
    // ─────────────────────────────────────────────────────────────────────────

    async createIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        input: PersonInput,
    ): Promise<{ row: PersonRow; event: DomainEvent }> {
        const ownerId = resolveOwner(context, input.ownerId, undefined);
        await assertOwnerIsMember(tx, ownerId);
        // OWN-2: a person at another member's company is theirs — refused here, by name; at a company
        // the saver may hold, linked to it by their address's domain.
        const placed = await this.ownership.checkPerson(context, {
            address: input.emails?.primary,
            companyId: input.companyId,
            ownerId,
        });
        if (placed.companyId) input = { ...input, companyId: placed.companyId };
        else await assertCompanyExists(tx, input.companyId ?? null);
        const custom = await this.customFields.validated(tx, 'person', input.custom ?? {}, 'create');
        assertIdentifiable(input.nameFirst ?? '', input.nameLast ?? '', input.emails?.primary ?? null);
        try {
            const row = await tx.person.create({
                data: {
                    ...compact(fields(input)),
                    workspaceId: context.workspaceId,
                    ownerId,
                    createdBy: actorOf(context),
                    custom,
                },
                include: personInclude,
            });
            return { row, event: event(context, 'person.created', row.id) };
        } catch (error) {
            throw uniqueViolation(error) ? conflict() : error;
        }
    }

    async updateIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        id: string,
        patch: PersonInput,
    ): Promise<{ after: PersonRow; event: DomainEvent | null }> {
        const current = await find(tx, context, id);
        const ownerId = resolveOwner(context, patch.ownerId, current.ownerId);
        if (ownerId !== current.ownerId) await assertOwnerIsMember(tx, ownerId);
        // OWN-2: moving a person to a company, or giving one with no company an address at a company,
        // is held to the company's owner like a new person.
        const companyChanged = patch.companyId != null && patch.companyId !== current.companyId;
        const newPrimary = patch.emails?.primary;
        const addressChanged =
            current.companyId === null &&
            patch.companyId === undefined &&
            newPrimary !== undefined &&
            companyDomainOfAddress(newPrimary) !== companyDomainOfAddress(current.emailPrimary);
        if (companyChanged || addressChanged) {
            const placed = await this.ownership.checkPerson(context, {
                address: newPrimary ?? current.emailPrimary,
                companyId: companyChanged ? patch.companyId : undefined,
                ownerId,
            });
            if (placed.companyId) patch = { ...patch, companyId: placed.companyId };
        }
        if (companyChanged) await assertCompanyExists(tx, patch.companyId!);
        const custom = patch.custom
            ? await this.customFields.validated(
                  tx,
                  'person',
                  patch.custom,
                  'patch',
                  stored<Record<string, unknown>>(current.custom),
              )
            : undefined;
        assertIdentifiable(
            patch.nameFirst ?? current.nameFirst,
            patch.nameLast ?? current.nameLast,
            (patch.emails ?? stored<Emails>(current.emails)).primary,
        );
        const data = { ...compact(fields(patch)), ownerId, ...(custom ? { custom } : {}) };
        // Nothing would change: no write, no `updated` event, the record as it was.
        if (isEmpty(projectedChanges(current, data, view, DIFF_FIELDS))) return { after: current, event: null };
        try {
            const after = await tx.person.update({ where: { id }, data, include: personInclude });
            return {
                after,
                event: event(context, 'person.updated', id, diffOf(view(current), view(after), DIFF_FIELDS)),
            };
        } catch (error) {
            throw uniqueViolation(error) ? conflict() : error;
        }
    }

    async removeIn(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<{ event: DomainEvent }> {
        const result = await tx.person.updateMany({
            where: { id, ...recordWhere(context, false) },
            data: { deletedAt: new Date() },
        });
        if (result.count === 0) throw notFound();
        return { event: event(context, 'person.deleted', id) };
    }

    async restoreIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        id: string,
    ): Promise<{ row: PersonRow; event: DomainEvent }> {
        const result = await tx.person.updateMany({
            where: { id, ...recordWhere(context, true) },
            data: { deletedAt: null },
        });
        if (result.count === 0) throw notFound();
        return { row: await find(tx, context, id), event: event(context, 'person.restored', id) };
    }

    /**
     * OWN-2: save a person for the member who owns their address's company, and tell them. Null when there
     * is nobody else to hand them to (no company by that domain, no owner, or the saver owns it), so the
     * caller saves them as usual.
     */
    private async handToOwner(context: WorkspaceRunContext, input: PersonInput): Promise<PersonView | null> {
        const company = await this.ownership.companyForDomain(context, companyDomainOfAddress(input.emails?.primary));
        const me = await this.rls.withWorkspace((tx) => requireCallerMember(tx, context));
        if (!company?.ownerId || company.ownerId === me) return null;
        const { handToOwner: _hand, ownerId: _owner, ...rest } = input;
        const owner = company.ownerId;
        const row = await this.transfers.handOver(
            context,
            me,
            owner,
            async (tx, wide) => {
                const created = await tx.person.create({
                    data: {
                        ...compact(fields({ ...rest, companyId: company.companyId })),
                        workspaceId: context.workspaceId,
                        ownerId: owner,
                        createdBy: actorOf(context),
                        custom: await this.customFields.validated(tx, 'person', rest.custom ?? {}, 'create'),
                    },
                    include: personInclude,
                });
                await this.events.record(tx, event(wide, 'person.created', created.id));
                return { row: created, target: { type: 'person' as const, id: created.id } };
            },
            `${company.companyName} is theirs`,
        );
        return view(row);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('PeopleService is used inside a workspace scope');
        return context;
    }
}

/** The columns a caller may set, as they travel to Prisma; identity and bookkeeping are added by the service. */
function fields(input: PersonInput) {
    return {
        nameFirst: input.nameFirst,
        nameLast: input.nameLast,
        emails: input.emails,
        phones: input.phones,
        jobTitle: input.jobTitle,
        city: input.city,
        source: input.source,
        country: input.country,
        links: input.links,
        avatarUrl: input.avatarUrl,
        position: input.position,
        companyId: input.companyId,
    };
}

/** A live record in the caller's scope, or `404` — outside the scope it does not exist for them. */
async function find(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<PersonRow> {
    const row = await tx.person.findFirst({ where: { id, ...recordWhere(context, false) }, include: personInclude });
    if (!row) throw notFound();
    return row;
}

function event(
    context: WorkspaceRunContext,
    type: 'person.created' | 'person.updated' | 'person.deleted' | 'person.restored',
    recordId: string,
    diff?: DomainEvent['diff'],
): DomainEvent {
    return {
        type,
        object: 'person',
        workspaceId: context.workspaceId,
        actor: actorOf(context),
        occurredAt: new Date().toISOString(),
        recordId,
        ...(diff ? { diff } : {}),
    };
}

/** A person with neither a name nor a primary email could never be found again. */
function assertIdentifiable(nameFirst: string, nameLast: string, primaryEmail: string | null): void {
    if (!nameFirst && !nameLast && !primaryEmail) {
        throw new UnprocessableEntityException('a person needs a name or a primary email');
    }
}

function notFound(): NotFoundException {
    return new NotFoundException('person not found');
}

function conflict(): UniqueConflict {
    return new UniqueConflict('a person with that primary email exists', 'emails.primary');
}

export function view(row: PersonRow): PersonView {
    return {
        id: row.id,
        nameFirst: row.nameFirst,
        nameLast: row.nameLast,
        emails: stored<Emails>(row.emails),
        phones: stored<Phones>(row.phones),
        jobTitle: row.jobTitle,
        city: row.city,
        source: row.source,
        contactStatus: row.contactStatus,
        contactStatusOverride: row.contactStatusOverride,
        contactAttempts: row.contactAttempts,
        lastContactedAt: row.lastContactedAt,
        country: row.country,
        links: stored<Links>(row.links),
        avatarUrl: row.avatarUrl,
        position: row.position,
        companyId: row.companyId,
        ownerId: row.ownerId,
        company: companySummary(row.company),
        owner: memberSummary(row.owner),
        createdBy: stored<Actor>(row.createdBy),
        custom: stored<Record<string, unknown>>(row.custom),
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
