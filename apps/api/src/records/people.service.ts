import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Actor, DomainEvent, Emails, FilterGroup, Links, Phones } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import type { BulkRecords } from './bulk/bulk.service';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { diffOf } from './diff';
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
    links?: Links | undefined;
    avatarUrl?: string | null | undefined;
    position?: number | undefined;
    companyId?: string | null | undefined;
    ownerId?: string | null | undefined;
    custom?: Record<string, unknown> | undefined;
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
    readonly editCapability = 'record:write' as const;

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
        private readonly events: DomainEvents,
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
        const actor = actorOf(context);
        const row = await this.rls.withWorkspace(async (tx) => {
            const ownerId = resolveOwner(context, input.ownerId, undefined);
            await assertOwnerIsMember(tx, ownerId);
            await assertCompanyExists(tx, input.companyId ?? null);
            const custom = await this.customFields.validated(tx, 'person', input.custom ?? {}, 'create');
            assertIdentifiable(input.nameFirst ?? '', input.nameLast ?? '', input.emails?.primary ?? null);
            try {
                return await tx.person.create({
                    data: {
                        ...compact(fields(input)),
                        workspaceId: context.workspaceId,
                        ownerId,
                        createdBy: actor,
                        custom,
                    },
                    include: personInclude,
                });
            } catch (error) {
                throw uniqueViolation(error) ? conflict() : error;
            }
        });
        this.events.publish(event(context, 'person.created', row.id));
        return view(row);
    }

    /** Partial: a composite (`emails`, `phones`, `links`) is replaced whole; `custom` is merged key by key. */
    async update(id: string, patch: PersonInput): Promise<PersonView> {
        const context = this.current();
        const { after, event } = await this.rls.withWorkspace((tx) => this.updateIn(tx, context, id, patch));
        this.events.publish(event);
        return view(after);
    }

    /** Soft: the row keeps its data and its place in the uniqueness index (PAR-079). */
    async remove(id: string): Promise<void> {
        const context = this.current();
        const { event } = await this.rls.withWorkspace((tx) => this.removeIn(tx, context, id));
        this.events.publish(event);
    }

    async restore(id: string): Promise<PersonView> {
        const context = this.current();
        const { row, event } = await this.rls.withWorkspace((tx) => this.restoreIn(tx, context, id));
        this.events.publish(event);
        return view(row);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The writes, inside a caller's transaction: the single routes above and the bulk service
    // (P1-4a) both run these, so one record changed by either is changed — and announced — alike.
    // The event is returned for the caller to publish after its transaction commits.
    // ─────────────────────────────────────────────────────────────────────────

    async updateIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        id: string,
        patch: PersonInput,
    ): Promise<{ after: PersonRow; event: DomainEvent }> {
        const current = await find(tx, context, id);
        const ownerId = resolveOwner(context, patch.ownerId, current.ownerId);
        if (ownerId !== current.ownerId) await assertOwnerIsMember(tx, ownerId);
        if (patch.companyId != null && patch.companyId !== current.companyId) {
            await assertCompanyExists(tx, patch.companyId);
        }
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
        try {
            const after = await tx.person.update({
                where: { id },
                data: { ...compact(fields(patch)), ownerId, ...(custom ? { custom } : {}) },
                include: personInclude,
            });
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

function conflict(): ConflictException {
    return new ConflictException({ message: 'a person with that primary email exists', field: 'emails.primary' });
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
