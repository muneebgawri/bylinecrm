import { Injectable, Logger } from '@nestjs/common';
import {
    NOTIFICATIONS_PAGE,
    type EventActor,
    type MyTaskView,
    type NotificationKind,
    type NotificationSettings,
    type NotificationsView,
} from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { requireCallerMember } from '../infra/caller-member';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { MEMBER_SUMMARY_SELECT } from '../records/summaries';
import { AccountMail } from '../transactional-mail/account-mail';
import { MY_TASKS_LIMIT, TASK_DUE_AS_MADE_MS, TASK_DUE_BATCH, TASK_DUE_LOOKBACK_MS } from './notifications.constants';
import { labelled, labelTargets } from './task-labels';

/** An open task: not done and not deleted. */
const OPEN = { deletedAt: null, status: { not: 'done' } } satisfies Prisma.TaskWhereInput;
const WITH_TARGETS = { targets: { select: { targetType: true, targetId: true } } } as const;
const MEMBER = { select: MEMBER_SUMMARY_SELECT } as const;

/**
 * What members are told about their tasks (#192), one service for every way they hear of them:
 *
 * - **Assigned** — the outbox consumer, on a task made or handed to someone (a sequence's task step
 *   included): that member is told, unless they assigned it to themselves.
 * - **Due** — a repeating job: a task that came due (and was not due as it was made) tells its
 *   assignee once.
 * - **The bell** reads a member's own notifications and marks them read.
 * - **My tasks** and **the morning digest** read one query: the member's open tasks, soonest due first.
 *
 * Each (member, kind, task) is told once (a unique row), so an event delivered again or a job run
 * twice tells nobody twice. The digest is recorded in the mail outbox inside the transaction that read
 * the tasks; the relay sends it after commit — no network call inside a transaction.
 */
@Injectable()
export class TaskNotificationsService {
    private readonly logger = new Logger(TaskNotificationsService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly ownerPrisma: PrismaService,
        private readonly context: WorkspaceContext,
        private readonly mail: AccountMail,
    ) {}

    // ── Told ─────────────────────────────────────────────────────────────────────────────────

    /** A task was made or handed on: its assignee is told, unless they did it themselves. */
    async assigned(workspaceId: string, taskId: string, actor: EventActor): Promise<void> {
        await this.rls.withWorkspace(workspaceId, async (tx) => {
            const task = await tx.task.findUnique({
                where: { id: taskId },
                select: { assigneeId: true, deletedAt: true },
            });
            if (!task?.assigneeId || task.deletedAt) return;
            if (actor.kind === 'member' && actor.id === task.assigneeId) return;
            await tell(tx, workspaceId, task.assigneeId, 'task_assigned', [taskId]);
        });
    }

    /**
     * The repeating job: every open, assigned task that came due since the last look (within
     * `TASK_DUE_LOOKBACK_MS`) and was not due as it was made tells its assignee, once.
     */
    async remindDue(now = new Date()): Promise<number> {
        const due = await this.ownerPrisma.task.findMany({
            where: {
                ...OPEN,
                assigneeId: { not: null },
                dueAt: { lte: now, gt: new Date(now.getTime() - TASK_DUE_LOOKBACK_MS) },
                notifications: { none: { kind: 'task_due' } },
            },
            select: { id: true, workspaceId: true, assigneeId: true, dueAt: true, createdAt: true },
            orderBy: { dueAt: 'asc' },
            take: TASK_DUE_BATCH,
        });
        const told = due.filter((t) => t.dueAt!.getTime() - t.createdAt.getTime() > TASK_DUE_AS_MADE_MS);
        const byWorkspace = groupBy(told, (t) => t.workspaceId);
        for (const [workspaceId, tasks] of byWorkspace) {
            await this.rls.withWorkspace(workspaceId, async (tx) => {
                for (const [memberId, theirs] of groupBy(tasks, (t) => t.assigneeId!)) {
                    await tell(
                        tx,
                        workspaceId,
                        memberId,
                        'task_due',
                        theirs.map((t) => t.id),
                    );
                }
            });
        }
        return told.length;
    }

    /**
     * The morning digest: each member who wants it and holds open tasks due by the end of the day
     * (UTC) gets one email listing the overdue ones and today's. One per member per day (the outbox's
     * idempotency key), so running it again that day sends nothing more.
     */
    async sendDigests(now = new Date()): Promise<number> {
        const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        const startOfDay = new Date(endOfDay.getTime() - 24 * 60 * 60 * 1000);
        const day = startOfDay.toISOString().slice(0, 10);
        const members = await this.ownerPrisma.workspaceMember.findMany({
            where: { taskDigest: true, assignedTasks: { some: { ...OPEN, dueAt: { lt: endOfDay } } } },
            select: {
                id: true,
                workspaceId: true,
                user: { select: { email: true } },
                workspace: { select: { name: true } },
            },
        });
        let sent = 0;
        for (const member of members) {
            try {
                const recorded = await this.rls.withWorkspace(member.workspaceId, async (tx) => {
                    const tasks = (await openTasksIn(tx, member.id)).filter(
                        (t) => t.dueAt !== null && new Date(t.dueAt) < endOfDay,
                    );
                    if (tasks.length === 0) return false;
                    const line = (t: MyTaskView) => ({
                        title: t.title,
                        about: t.targets.map((x) => x.label),
                        due: t.dueAt!.slice(0, 10),
                    });
                    await this.mail.taskDigest(tx, {
                        workspaceId: member.workspaceId,
                        to: member.user.email,
                        memberId: member.id,
                        day,
                        workspaceName: member.workspace.name,
                        overdue: tasks.filter((t) => new Date(t.dueAt!) < startOfDay).map(line),
                        today: tasks.filter((t) => new Date(t.dueAt!) >= startOfDay).map(line),
                        path: `/w/${member.workspaceId}/home`,
                    });
                    return true;
                });
                if (recorded) sent += 1;
            } catch (error) {
                this.logger.error(
                    `task digest for member ${member.id}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        if (sent > 0) this.mail.kick();
        return sent;
    }

    // ── Read by the member ───────────────────────────────────────────────────────────────────

    /** The caller's latest notifications, newest first, and how many of all theirs are unread. */
    async list(): Promise<NotificationsView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const me = await requireCallerMember(tx, context);
            // About a live task, or (OWN-1) about a transfer.
            const live = {
                memberId: me,
                OR: [{ task: { deletedAt: null } }, { transferId: { not: null } }],
            } satisfies Prisma.NotificationWhereInput;
            const rows = await tx.notification.findMany({
                where: live,
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                take: NOTIFICATIONS_PAGE,
                include: {
                    task: { select: { id: true, title: true, dueAt: true, ...WITH_TARGETS } },
                    transfer: { include: { from: MEMBER, to: MEMBER } },
                },
            });
            const labels = await labelTargets(tx, [
                ...rows.flatMap((r) => r.task?.targets ?? []),
                ...rows.flatMap((r) =>
                    r.transfer ? [{ targetType: r.transfer.object, targetId: r.transfer.recordId }] : [],
                ),
            ]);
            const named = (m: { id: string; user: { displayName: string | null } } | null) =>
                m ? { memberId: m.id, name: m.user.displayName } : null;
            return {
                items: rows.map((r) => ({
                    id: r.id,
                    kind: r.kind,
                    createdAt: r.createdAt.toISOString(),
                    readAt: r.readAt?.toISOString() ?? null,
                    task: r.task
                        ? {
                              id: r.task.id,
                              title: r.task.title,
                              dueAt: r.task.dueAt?.toISOString() ?? null,
                              targets: labelled(r.task.targets, labels),
                          }
                        : null,
                    transfer: r.transfer
                        ? {
                              id: r.transfer.id,
                              object: r.transfer.object,
                              recordId: r.transfer.recordId,
                              recordLabel: labels.get(`${r.transfer.object}:${r.transfer.recordId}`) ?? 'A record',
                              from: named(r.transfer.from),
                              to: named(r.transfer.to)!,
                              status: r.transfer.status,
                              reason: r.transfer.reason,
                          }
                        : null,
                })),
                unread: await tx.notification.count({ where: { ...live, readAt: null } }),
            };
        });
    }

    /** Marks the caller's own notifications read: those named, or every one. Anyone else's are untouched. */
    async markRead(ids?: readonly string[]): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const me = await requireCallerMember(tx, context);
            await tx.notification.updateMany({
                where: { memberId: me, readAt: null, ...(ids ? { id: { in: [...ids] } } : {}) },
                data: { readAt: new Date() },
            });
        });
    }

    /** The caller's open tasks, soonest due first, no due date last. */
    async myTasks(): Promise<MyTaskView[]> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => openTasksIn(tx, await requireCallerMember(tx, context)));
    }

    async settings(): Promise<NotificationSettings> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const member = await tx.workspaceMember.findUniqueOrThrow({
                where: { id: await requireCallerMember(tx, context) },
                select: { taskDigest: true },
            });
            return { taskDigest: member.taskDigest };
        });
    }

    async updateSettings(input: NotificationSettings): Promise<NotificationSettings> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const member = await tx.workspaceMember.update({
                where: { id: await requireCallerMember(tx, context) },
                data: { taskDigest: input.taskDigest },
                select: { taskDigest: true },
            });
            return { taskDigest: member.taskDigest };
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('TaskNotificationsService is used inside a workspace scope');
        return context;
    }
}

/** Tells a member about tasks, once per (member, kind, task): a repeat is skipped by the unique row. */
async function tell(
    tx: WorkspaceClient,
    workspaceId: string,
    memberId: string,
    kind: NotificationKind,
    taskIds: readonly string[],
): Promise<void> {
    await tx.notification.createMany({
        data: taskIds.map((taskId) => ({ workspaceId, memberId, kind, taskId })),
        skipDuplicates: true,
    });
}

/** A member's open tasks, soonest due first and no due date last, with what each is about. */
async function openTasksIn(tx: WorkspaceClient, memberId: string): Promise<MyTaskView[]> {
    const rows = await tx.task.findMany({
        where: { ...OPEN, assigneeId: memberId },
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
        take: MY_TASKS_LIMIT,
        select: { id: true, title: true, status: true, dueAt: true, ...WITH_TARGETS },
    });
    const labels = await labelTargets(
        tx,
        rows.flatMap((r) => r.targets),
    );
    return rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        dueAt: r.dueAt?.toISOString() ?? null,
        targets: labelled(r.targets, labels),
    }));
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
    return groups;
}
