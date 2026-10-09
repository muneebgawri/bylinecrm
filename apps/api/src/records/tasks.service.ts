import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Actor, RecordTarget, RichText, TaskStatus } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import { diffOf } from './diff';
import { type Page, paginate } from './list-query';
import { assertOwnerIsMember, compact, stored } from './references';
import { EMPTY_RICH_TEXT, richTextToPlain } from './rich-text';
import { completedAtFor } from './task-rules';
import { anyTargetReadable, assertTargetsReadable, dedupeTargets, targetRows } from './targets';
import { type TaskView } from './responses';
export type { TaskView } from './responses';

export interface TaskInput {
    title?: string | undefined;
    body?: RichText | undefined;
    status?: TaskStatus | undefined;
    dueAt?: string | null | undefined;
    assigneeId?: string | null | undefined;
    targets?: RecordTarget[] | undefined;
}

export interface ListTasksQuery {
    target?: RecordTarget | undefined;
    assigneeId?: string | undefined;
    status?: TaskStatus | undefined;
    cursor?: string | undefined;
    limit: number;
}

const DIFF_FIELDS = ['title', 'body', 'status', 'dueAt', 'assigneeId', 'completedAt', 'targets'] as const;

type TaskRow = Prisma.TaskGetPayload<{ include: { targets: true } }>;

/**
 * A task is visible to its assignee and to whoever can see at least one of its targets. Listing
 * by assignee is listing one's own work; a caller whose role sees every record may list anyone's,
 * an own-scoped caller only their own (`403`, since nothing about another member's tasks is
 * learned by refusing).
 */
@Injectable()
export class TasksService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
    ) {}

    list(query: ListTasksQuery, deleted = false): Promise<Page<TaskView>> {
        const context = this.current();
        if (query.assigneeId && context.ownerScopeMemberId && query.assigneeId !== context.ownerScopeMemberId) {
            throw new ForbiddenException('your role lists its own tasks: the assignee must be yourself');
        }
        return this.rls.withWorkspace(async (tx) => {
            if (query.target && !(await anyTargetReadable(tx, [query.target]))) {
                throw new NotFoundException('target not found');
            }
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.task.findMany({
                    where: {
                        deletedAt: deleted ? { not: null } : null,
                        ...(query.status ? { status: query.status } : {}),
                        ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
                        ...(query.target
                            ? { targets: { some: { targetType: query.target.type, targetId: query.target.id } } }
                            : {}),
                    },
                    include: { targets: true },
                    orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }],
                    ...args,
                }),
            );
            return { items: page.items.map(view), nextCursor: page.nextCursor };
        });
    }

    get(id: string): Promise<TaskView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => view(await find(tx, context, id, false)));
    }

    async create(input: TaskInput & { title: string; targets: RecordTarget[] }): Promise<TaskView> {
        const context = this.current();
        const actor = actorOf(context);
        const targets = dedupeTargets(input.targets);
        const body = input.body ?? EMPTY_RICH_TEXT;
        const status = input.status ?? 'todo';
        const row = await this.rls.withWorkspace(async (tx) => {
            await assertTargetsReadable(tx, targets);
            await assertOwnerIsMember(tx, input.assigneeId ?? null);
            return tx.task.create({
                data: {
                    workspaceId: context.workspaceId,
                    title: input.title,
                    body: body as Prisma.InputJsonObject,
                    bodyText: richTextToPlain(body),
                    status,
                    dueAt: input.dueAt ? new Date(input.dueAt) : null,
                    assigneeId: input.assigneeId ?? null,
                    completedAt: completedAtFor(status, undefined, new Date()),
                    createdBy: actor,
                    targets: {
                        create: targetRows(context.workspaceId, targets),
                    },
                },
                include: { targets: true },
            });
        });
        this.events.publish({
            type: 'task.created',
            object: 'task',
            workspaceId: context.workspaceId,
            actor,
            occurredAt: new Date().toISOString(),
            recordId: row.id,
            targets,
        });
        return view(row);
    }

    /** Partial; `targets` replaces the set; `completedAt` follows `status` by the one rule. */
    async update(id: string, patch: TaskInput): Promise<TaskView> {
        const context = this.current();
        const { before, after } = await this.rls.withWorkspace(async (tx) => {
            const current = await find(tx, context, id, false);
            const targets = patch.targets ? dedupeTargets(patch.targets) : undefined;
            if (targets) await assertTargetsReadable(tx, targets);
            if (patch.assigneeId != null && patch.assigneeId !== current.assigneeId) {
                await assertOwnerIsMember(tx, patch.assigneeId);
            }
            const status = patch.status ?? current.status;
            const updated = await tx.task.update({
                where: { id },
                data: {
                    ...compact({ title: patch.title, assigneeId: patch.assigneeId }),
                    ...(patch.body
                        ? { body: patch.body as Prisma.InputJsonObject, bodyText: richTextToPlain(patch.body) }
                        : {}),
                    ...(patch.dueAt === undefined
                        ? {}
                        : { dueAt: patch.dueAt === null ? null : new Date(patch.dueAt) }),
                    status,
                    completedAt: completedAtFor(status, current, new Date()),
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
            type: 'task.updated',
            object: 'task',
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
            const current = await find(tx, context, id, false);
            await tx.task.update({ where: { id }, data: { deletedAt: new Date() } });
            return current;
        });
        this.events.publish({
            type: 'task.deleted',
            object: 'task',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
            targets: targetsOf(row),
        });
    }

    async restore(id: string): Promise<TaskView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            await find(tx, context, id, true);
            return tx.task.update({ where: { id }, data: { deletedAt: null }, include: { targets: true } });
        });
        this.events.publish({
            type: 'task.restored',
            object: 'task',
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
        if (!context) throw new Error('TasksService is used inside a workspace scope');
        return context;
    }
}

/** A task the caller can see — theirs, or on a record they can see — or `404`. */
async function find(tx: WorkspaceClient, context: WorkspaceRunContext, id: string, deleted: boolean): Promise<TaskRow> {
    const row = await tx.task.findFirst({
        where: { id, deletedAt: deleted ? { not: null } : null },
        include: { targets: true },
    });
    const mine = row !== null && row.assigneeId !== null && row.assigneeId === context.memberId;
    if (!row || (!mine && !(await anyTargetReadable(tx, targetsOf(row))))) {
        throw new NotFoundException('task not found');
    }
    return row;
}

function targetsOf(row: TaskRow): RecordTarget[] {
    return row.targets.map((t) => ({ type: t.targetType, id: t.targetId }));
}

export function view(row: TaskRow): TaskView {
    return {
        id: row.id,
        title: row.title,
        body: stored<RichText>(row.body),
        bodyText: row.bodyText,
        status: row.status,
        dueAt: row.dueAt,
        assigneeId: row.assigneeId,
        completedAt: row.completedAt,
        targets: targetsOf(row),
        createdBy: stored<Actor>(row.createdBy),
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
