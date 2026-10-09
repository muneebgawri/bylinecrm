import { Injectable, NotFoundException } from '@nestjs/common';
import type { Actor, RecordTarget, RichText } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import { diffOf } from './diff';
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
        const actor = actorOf(context);
        const targets = dedupeTargets(input.targets);
        const body = input.body ?? EMPTY_RICH_TEXT;
        const row = await this.rls.withWorkspace(async (tx) => {
            await assertTargetsReadable(tx, targets);
            return tx.note.create({
                data: {
                    workspaceId: context.workspaceId,
                    title: input.title ?? '',
                    body: body as Prisma.InputJsonObject,
                    bodyText: richTextToPlain(body),
                    authorId: context.memberId ?? null,
                    createdBy: actor,
                    targets: {
                        create: targetRows(context.workspaceId, targets),
                    },
                },
                include: { targets: true },
            });
        });
        this.events.publish({
            type: 'note.created',
            object: 'note',
            workspaceId: context.workspaceId,
            actor,
            occurredAt: new Date().toISOString(),
            recordId: row.id,
            targets,
        });
        return view(row);
    }

    /** Partial; `targets`, when given, replaces the whole set. */
    async update(id: string, patch: NoteInput): Promise<NoteView> {
        const context = this.current();
        const { before, after } = await this.rls.withWorkspace(async (tx) => {
            const current = await find(tx, id, false);
            const targets = patch.targets ? dedupeTargets(patch.targets) : undefined;
            if (targets) await assertTargetsReadable(tx, targets);
            const updated = await tx.note.update({
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
            return { before: current, after: updated };
        });
        const afterView = view(after);
        this.events.publish({
            type: 'note.updated',
            object: 'note',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
            diff: diffOf(view(before), afterView, DIFF_FIELDS),
            targets: afterView.targets,
        });
        return afterView;
    }

    async remove(id: string): Promise<void> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const current = await find(tx, id, false);
            await tx.note.update({ where: { id }, data: { deletedAt: new Date() } });
            return current;
        });
        this.events.publish({
            type: 'note.deleted',
            object: 'note',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
            targets: targetsOf(row),
        });
    }

    async restore(id: string): Promise<NoteView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            await find(tx, id, true);
            return tx.note.update({ where: { id }, data: { deletedAt: null }, include: { targets: true } });
        });
        this.events.publish({
            type: 'note.restored',
            object: 'note',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
            targets: targetsOf(row),
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
