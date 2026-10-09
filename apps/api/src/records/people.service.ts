import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Actor, Emails, Links, Phones } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { diffOf } from './diff';
import { type Page, paginate, parseSort, type SortSpec } from './list-query';
import { ownerWhere, resolveOwner } from './record-scope';
import { assertCompanyExists, assertOwnerIsMember, compact, stored } from './references';
import { searchCandidates } from './search';

/** A person as the API returns it (PAR-001). */
export interface PersonView {
    id: string;
    nameFirst: string;
    nameLast: string;
    emails: Emails;
    phones: Phones;
    jobTitle: string | null;
    city: string | null;
    links: Links;
    avatarUrl: string | null;
    position: number;
    companyId: string | null;
    ownerId: string | null;
    createdBy: Actor;
    custom: Record<string, unknown>;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

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

export interface ListQuery {
    cursor?: string | undefined;
    limit: number;
    sort?: string | undefined;
    q?: string | undefined;
}

export const PERSON_SORT_FIELDS = ['createdAt', 'updatedAt', 'nameFirst', 'nameLast', 'jobTitle', 'position'] as const;
type PersonSortField = (typeof PERSON_SORT_FIELDS)[number];
const DEFAULT_SORT: SortSpec<PersonSortField> = { field: 'createdAt', direction: 'desc' };

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

type PersonRow = Prisma.PersonGetPayload<Record<string, never>>;

@Injectable()
export class PeopleService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
        private readonly events: DomainEvents,
    ) {}

    /** Live people, or the trash when `deleted`; a text search narrows the candidates first. */
    list(query: ListQuery, deleted = false): Promise<Page<PersonView>> {
        const context = this.current();
        const sort = parseSort(query.sort, PERSON_SORT_FIELDS, DEFAULT_SORT);
        return this.rls.withWorkspace(async (tx) => {
            const ids = query.q ? await searchCandidates(tx, 'people', query.q, deleted) : undefined;
            if (ids && ids.length === 0) return { items: [], nextCursor: null };
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.person.findMany({
                    where: { ...where(context, deleted), ...(ids ? { id: { in: ids } } : {}) },
                    // The field comes from PERSON_SORT_FIELDS, every one a column of the model.
                    orderBy: [{ [sort.field]: sort.direction } as Prisma.PersonOrderByWithRelationInput, { id: 'asc' }],
                    ...args,
                }),
            );
            return { items: page.items.map(view), nextCursor: page.nextCursor };
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
                });
            } catch (error) {
                throw uniqueViolation(error) ? conflict() : error;
            }
        });
        this.events.publish({
            type: 'person.created',
            object: 'person',
            workspaceId: context.workspaceId,
            actor,
            occurredAt: new Date().toISOString(),
            recordId: row.id,
        });
        return view(row);
    }

    /** Partial: a composite (`emails`, `phones`, `links`) is replaced whole; `custom` is merged key by key. */
    async update(id: string, patch: PersonInput): Promise<PersonView> {
        const context = this.current();
        const { before, after } = await this.rls.withWorkspace(async (tx) => {
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
                const updated = await tx.person.update({
                    where: { id },
                    data: { ...compact(fields(patch)), ownerId, ...(custom ? { custom } : {}) },
                });
                return { before: current, after: updated };
            } catch (error) {
                throw uniqueViolation(error) ? conflict() : error;
            }
        });
        this.events.publish({
            type: 'person.updated',
            object: 'person',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
            diff: diffOf(view(before), view(after), DIFF_FIELDS),
        });
        return view(after);
    }

    /** Soft: the row keeps its data and its place in the uniqueness index (PAR-079). */
    async remove(id: string): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const result = await tx.person.updateMany({
                where: { id, ...where(context, false) },
                data: { deletedAt: new Date() },
            });
            if (result.count === 0) throw notFound();
        });
        this.events.publish({
            type: 'person.deleted',
            object: 'person',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
        });
    }

    async restore(id: string): Promise<PersonView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const result = await tx.person.updateMany({
                where: { id, ...where(context, true) },
                data: { deletedAt: null },
            });
            if (result.count === 0) throw notFound();
            return find(tx, context, id);
        });
        this.events.publish({
            type: 'person.restored',
            object: 'person',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
        });
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
        links: input.links,
        avatarUrl: input.avatarUrl,
        position: input.position,
        companyId: input.companyId,
    };
}

function where(context: WorkspaceRunContext, deleted: boolean): Prisma.PersonWhereInput {
    return { deletedAt: deleted ? { not: null } : null, ...ownerWhere(context) };
}

/** A live record in the caller's scope, or `404` — outside the scope it does not exist for them. */
async function find(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<PersonRow> {
    const row = await tx.person.findFirst({ where: { id, ...where(context, false) } });
    if (!row) throw notFound();
    return row;
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
        createdBy: stored<Actor>(row.createdBy),
        custom: stored<Record<string, unknown>>(row.custom),
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
