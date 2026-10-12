import { Injectable, NotFoundException } from '@nestjs/common';
import type { Actor, DomainEvent, RecordTarget, RichText } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import { diffOf, isEmpty, projectedChanges } from './diff';
import { type Page, paginate } from './list-query';
import { compact, stored } from './references';
import { EMPTY_RICH_TEXT, richTextToPlain } from './rich-text';
import { anyTargetReadable, assertTargetsReadable, dedupeTargets, targetRows } from './targets';
import { type NoteView } from './responses';
export type { NoteView } from './responses';

export interface NoteInput {
    title?: string | undefined;
    body?: RichText | undefined;
    targets?: RecordTarget[] | undefined;
    /** Create only: the member who wrote it; the caller when absent (an import names the Twenty author). */
    authorId?: string | null | undefined;
}

export interface ListByTargetQuery {
    target: RecordTarget;
    cursor?: string | undefined;
    limit: number;
}

const DIFF_FIELDS = ['title', 'body', 'targets'] as const;

type NoteRow = Prisma.NoteGetPayload<{ include: { targets: true } }>;

/**
 * Notes are reached through the records they are on: a note is visible to whoever can see at
 * least one of its targets, under the same policies that scope the record itself. That rule,
 * `anyTargetReadable`, is the only visibility check here; the trash follows it too.
 */
@Injectable()
export class NotesService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
    ) {}

    /** The notes on one record, newest first; a record the caller cannot see has none (`404`). */
    list(query: ListByTargetQuery, deleted = false): Promise<Page<NoteView>> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            if (!(await anyTargetReadable(tx, [query.target]))) throw new NotFoundException('target not found');
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.note.findMany({
                    where: {
                        deletedAt: deleted ? { not: null } : null,
                        targets: { some: { targetType: query.target.type, targetId: query.target.id } },
                    },
                    include: { targets: true },
                    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                    ...args,
                }),
            );
            return { items: page.items.map(view), nextCursor: page.nextCursor };
        });
    }

    get(id: string): Promise<NoteView> {
        this.current();
        return this.rls.withWorkspace(async (tx) => view(await find(tx, id, false)));
    }

    async create(input: NoteInput & { targets: RecordTarget[] }): Promise<NoteView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const created = await this.createIn(tx, context, input);
            await this.events.record(tx, created.event);
            return created.row;
        });
        return view(row);
    }

    /** Partial; `targets`, when given, replaces the whole set. */
    async update(id: string, patch: NoteInput): Promise<NoteView> {
        const context = this.current();
        const { after } = await this.rls.withWorkspace(async (tx) => {
            const result = await this.updateIn(tx, context, id, patch);
            if (result.event) await this.events.record(tx, result.event);
            return result;
        });
        return view(after);
    }

    // The writes inside a caller's transaction — the routes above and the Twenty importer (P4-4)
    // both run these; each returns the event for the caller to record in the same transaction (P1-6).

    async createIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        input: NoteInput & { targets: RecordTarget[] },
    ): Promise<{ row: NoteRow; event: DomainEvent }> {
        const actor = actorOf(context);
        const targets = dedupeTargets(input.targets);
        const body = input.body ?? EMPTY_RICH_TEXT;
        await assertTargetsReadable(tx, targets);
        const row = await tx.note.create({
            data: {
                workspaceId: context.workspaceId,
                title: input.title ?? '',
                body: body as Prisma.InputJsonObject,
                bodyText: richTextToPlain(body),
                authorId: input.authorId === undefined ? (context.memberId ?? null) : input.authorId,
                createdBy: actor,
                targets: {
                    create: targetRows(context.workspaceId, targets),
                },
            },
            include: { targets: true },
        });
        return {
            row,
            event: {
                type: 'note.created',
                object: 'note',
                workspaceId: context.workspaceId,
                actor,
                occurredAt: new Date().toISOString(),
                recordId: row.id,
                targets,
            },
        };
    }

    /** Nothing would change: no write, no `updated` event, the note as it was. */
    async updateIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        id: string,
        patch: NoteInput,
    ): Promise<{ after: NoteRow; event: DomainEvent | null }> {
        const current = await find(tx, id, false);
        const targets = patch.targets ? dedupeTargets(patch.targets) : undefined;
        if (targets) await assertTargetsReadable(tx, targets);
        const projected = projectedChanges(
            current,
            {
                ...compact({ title: patch.title }),
                ...(patch.body ? { body: patch.body } : {}),
                ...(targets
                    ? { targets: targetRows(context.workspaceId, targets).map((t) => ({ ...t, id: '', noteId: id })) }
                    : {}),
            },
            view,
            DIFF_FIELDS,
        );
        if (isEmpty(projected)) return { after: current, event: null };
        const after = await tx.note.update({
            where: { id },
            data: {
                ...compact({ title: patch.title }),
                ...(patch.body
                    ? { body: patch.body as Prisma.InputJsonObject, bodyText: richTextToPlain(patch.body) }
                    : {}),
                ...(targets
                    ? {
                          targets: {
                              deleteMany: {},
                              create: targetRows(context.workspaceId, targets),
                          },
                      }
                    : {}),
            },
            include: { targets: true },
        });
        const updatedView = view(after);
        return {
            after,
            event: {
                type: 'note.updated',
                object: 'note',
                workspaceId: context.workspaceId,
                actor: actorOf(context),
                occurredAt: new Date().toISOString(),
                recordId: id,
                diff: diffOf(view(current), updatedView, DIFF_FIELDS),
                targets: updatedView.targets,
            },
        };
    }

    async remove(id: string): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const current = await find(tx, id, false);
            await tx.note.update({ where: { id }, data: { deletedAt: new Date() } });
            await this.events.record(tx, {
                type: 'note.deleted',
                object: 'note',
                workspaceId: context.workspaceId,
                actor: actorOf(context),
                occurredAt: new Date().toISOString(),
                recordId: id,
                targets: targetsOf(current),
            });
        });
    }

    async restore(id: string): Promise<NoteView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            await find(tx, id, true);
            const restored = await tx.note.update({
                where: { id },
                data: { deletedAt: null },
                include: { targets: true },
            });
            await this.events.record(tx, {
                type: 'note.restored',
                object: 'note',
                workspaceId: context.workspaceId,
                actor: actorOf(context),
                occurredAt: new Date().toISOString(),
                recordId: id,
                targets: targetsOf(restored),
            });
            return restored;
        });
        return view(row);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('NotesService is used inside a workspace scope');
        return context;
    }
}

/** A note the caller can see (live, or in the trash when `deleted`), or `404`. */
async function find(tx: WorkspaceClient, id: string, deleted: boolean): Promise<NoteRow> {
    const row = await tx.note.findFirst({
        where: { id, deletedAt: deleted ? { not: null } : null },
        include: { targets: true },
    });
    if (!row || !(await anyTargetReadable(tx, targetsOf(row)))) throw new NotFoundException('note not found');
    return row;
}

function targetsOf(row: NoteRow): RecordTarget[] {
    return row.targets.map((t) => ({ type: t.targetType, id: t.targetId }));
}

export function view(row: NoteRow): NoteView {
    return {
        id: row.id,
        title: row.title,
        body: stored<RichText>(row.body),
        bodyText: row.bodyText,
        targets: targetsOf(row),
        authorId: row.authorId,
        createdBy: stored<Actor>(row.createdBy),
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
