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
import { notify, targetOf } from './notify';
import { labelled, labelTargets } from './task-labels';

/** GUARD-2: the guardrail notifications a digest lists — those of the last day, once each. */
const DIGEST_ALERT_KINDS = [
    'guardrail_poach_suspected',
    'guardrail_off_crm_cold',
    'cadence_warning',
] as const satisfies readonly NotificationKind[];
const DAY_MS = 24 * 60 * 60 * 1000;

/** An open task: not done and not deleted. */
const OPEN = { deletedAt: null, status: { not: 'done' } } satisfies Prisma.TaskWhereInput;
const WITH_TARGETS = { targets: { select: { targetType: true, targetId: true } } } as const;
const MEMBER = { select: MEMBER_SUMMARY_SELECT } as const;
/** A member's notification settings, as stored on their seat. */
const SETTINGS = {
    taskDigest: true,
    notifyEmailReplies: true,
    notifyEmailClicks: true,
    notifyEmailOpens: true,
    notifySound: true,
} as const satisfies Record<keyof NotificationSettings, true>;

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

    /**
     * A task was made or handed on: its assignee is told, unless they did it themselves. A task an
     * import or a sync brought over (the Bigin and Twenty importers: hundreds at once, most of them
     * long overdue) is no one handing work to anyone: nobody is told.
     */
    async assigned(workspaceId: string, taskId: string, actor: EventActor): Promise<void> {
        if (actor.kind === 'import' || actor.kind === 'sync') return;
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
     * (UTC), or (GUARD-2) was told of a guardrail alert in the last day, gets one email listing the
     * overdue tasks, today's, and the alerts (who, whom, when, subject — never a body). One per member
     * per day (the outbox's idempotency key), so running it again that day sends nothing more.
     */
    async sendDigests(now = new Date()): Promise<number> {
        const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        const startOfDay = new Date(endOfDay.getTime() - 24 * 60 * 60 * 1000);
        const day = startOfDay.toISOString().slice(0, 10);
        const members = await this.ownerPrisma.workspaceMember.findMany({
            where: {
                taskDigest: true,
                leftAt: null,
                OR: [
                    { assignedTasks: { some: { ...OPEN, dueAt: { lt: endOfDay } } } },
                    {
                        notifications: {
                            some: {
                                kind: { in: [...DIGEST_ALERT_KINDS] },
                                createdAt: { gte: new Date(now.getTime() - DAY_MS) },
                            },
                        },
                    },
                ],
            },
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
                    const alerts = await tx.notification.findMany({
                        where: {
                            memberId: member.id,
                            kind: { in: [...DIGEST_ALERT_KINDS] },
                            createdAt: { gte: new Date(now.getTime() - DAY_MS) },
                        },
                        orderBy: { createdAt: 'asc' },
                        select: {
                            guardrailEvent: { select: { message: true } },
                            cadenceLapse: {
                                select: { stageName: true, rotateAt: true, opportunity: { select: { name: true } } },
                            },
                        },
                    });
                    if (tasks.length === 0 && alerts.length === 0) return false;
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
                        alerts: alerts.flatMap((a) =>
                            a.guardrailEvent
                                ? [a.guardrailEvent.message]
                                : a.cadenceLapse
                                  ? [
                                        `${a.cadenceLapse.opportunity.name} (${a.cadenceLapse.stageName}) missed its follow-up cadence; it rotates to the next rep on ${a.cadenceLapse.rotateAt.toISOString().slice(0, 10)} unless it is touched.`,
                                    ]
                                  : [],
                        ),
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
            // About a live task, or (OWN-1) about a transfer, or (GUARD-1) about a guardrail event.
            const live = {
                memberId: me,
                OR: [
                    { task: { deletedAt: null } },
                    { transferId: { not: null } },
                    { guardrailEventId: { not: null } },
                    { invoiceId: { not: null } },
                    { cadenceLapseId: { not: null } },
                    { newswireosPaymentId: { not: null } },
                    { mailOutboundId: { not: null } },
                    { mailMessageId: { not: null } },
                ],
            } satisfies Prisma.NotificationWhereInput;
            const rows = await tx.notification.findMany({
                where: live,
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                take: NOTIFICATIONS_PAGE,
                include: {
                    task: { select: { id: true, title: true, dueAt: true, ...WITH_TARGETS } },
                    transfer: { include: { from: MEMBER, to: MEMBER } },
                    guardrailEvent: { include: { actor: MEMBER, owner: MEMBER } },
                    invoice: { include: { opportunity: { select: { name: true } } } },
                    cadenceLapse: { include: { opportunity: { select: { name: true } } } },
                    newswireosPayment: { include: { opportunity: { select: { name: true } } } },
                    mailOutbound: { select: { id: true, subject: true, personId: true } },
                    mailMessage: {
                        select: {
                            id: true,
                            subject: true,
                            participants: {
                                where: { role: 'from' },
                                select: { personId: true, displayName: true, address: true },
                                take: 1,
                            },
                        },
                    },
                },
            });
            const repliedBy = (r: (typeof rows)[number]) => r.mailMessage?.participants[0];
            const labels = await labelTargets(tx, [
                ...rows.flatMap((r) => r.task?.targets ?? []),
                ...rows.flatMap((r) =>
                    r.transfer ? [{ targetType: r.transfer.object, targetId: r.transfer.recordId }] : [],
                ),
                ...rows.flatMap((r) => {
                    const personId = r.mailOutbound?.personId ?? repliedBy(r)?.personId;
                    return personId ? [{ targetType: 'person', targetId: personId }] : [];
                }),
            ]);
            // A click's link: the send's first click by a person (a scanner's never counts).
            const clicked = rows.filter((r) => r.kind === 'email_clicked' && r.mailOutboundId);
            const firstClick = new Map<string, string | null>();
            if (clicked.length > 0) {
                const hits = await tx.trackingHit.findMany({
                    where: {
                        outboundId: { in: clicked.map((r) => r.mailOutboundId!) },
                        kind: 'click',
                        botReason: null,
                    },
                    orderBy: [{ happenedAt: 'asc' }, { id: 'asc' }],
                    select: { outboundId: true, url: true },
                });
                for (const h of hits) if (!firstClick.has(h.outboundId)) firstClick.set(h.outboundId, h.url);
            }
            const person = (id: string | null | undefined, fallback: string | null) => {
                const label = id ? labels.get(`person:${id}`) : undefined;
                return { personId: label ? id! : null, personName: label ?? fallback };
            };
            const named = (m: { id: string; user: { displayName: string | null } } | null) =>
                m ? { memberId: m.id, name: m.user.displayName } : null;
            return {
                items: rows.map((r) => ({
                    id: r.id,
                    kind: r.kind,
                    target: targetOf(r),
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
                    guardrail: r.guardrailEvent
                        ? {
                              id: r.guardrailEvent.id,
                              kind: r.guardrailEvent.kind,
                              actor: named(r.guardrailEvent.actor),
                              count: Number((r.guardrailEvent.detail as { count?: string } | null)?.count ?? 0),
                              message: r.guardrailEvent.message,
                              severity: r.guardrailEvent.severity,
                              owner: named(r.guardrailEvent.owner),
                              address: r.guardrailEvent.address,
                              subject: detailOf(r.guardrailEvent.detail).subject ?? null,
                              sentAt: detailOf(r.guardrailEvent.detail).sentAt ?? null,
                          }
                        : null,
                    invoice: r.invoice
                        ? {
                              id: r.invoice.id,
                              opportunityId: r.invoice.opportunityId,
                              opportunityName: r.invoice.opportunity.name,
                              gateway: r.invoice.gateway,
                              reference: r.invoice.reference,
                              reasonCode: r.invoice.reasonCode,
                          }
                        : null,
                    payment: r.newswireosPayment
                        ? {
                              id: r.newswireosPayment.id,
                              invoiceNumber: r.newswireosPayment.invoiceNumber,
                              clientName: r.newswireosPayment.clientName,
                              amount:
                                  r.newswireosPayment.amountMinor !== null && r.newswireosPayment.currency
                                      ? {
                                            amountMinor: Number(r.newswireosPayment.amountMinor),
                                            currency: r.newswireosPayment.currency,
                                        }
                                      : null,
                              opportunityId: r.newswireosPayment.opportunityId,
                              opportunityName: r.newswireosPayment.opportunity?.name ?? null,
                          }
                        : null,
                    cadence: r.cadenceLapse
                        ? {
                              id: r.cadenceLapse.id,
                              opportunityId: r.cadenceLapse.opportunityId,
                              opportunityName: r.cadenceLapse.opportunity.name,
                              stageName: r.cadenceLapse.stageName,
                              dueAt: r.cadenceLapse.dueAt.toISOString(),
                              rotateAt: r.cadenceLapse.rotateAt.toISOString(),
                          }
                        : null,
                    email: r.mailOutbound
                        ? {
                              outboundId: r.mailOutbound.id,
                              messageId: null,
                              subject: r.mailOutbound.subject,
                              ...person(r.mailOutbound.personId, null),
                              url: r.kind === 'email_clicked' ? (firstClick.get(r.mailOutbound.id) ?? null) : null,
                          }
                        : r.mailMessage
                          ? {
                                outboundId: null,
                                messageId: r.mailMessage.id,
                                subject: r.mailMessage.subject,
                                ...person(
                                    repliedBy(r)?.personId,
                                    repliedBy(r)?.displayName || repliedBy(r)?.address || null,
                                ),
                                url: null,
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
        return this.rls.withWorkspace(async (tx) =>
            tx.workspaceMember.findUniqueOrThrow({
                where: { id: await requireCallerMember(tx, context) },
                select: SETTINGS,
            }),
        );
    }

    /** Changes the settings named; any left out stay as they are. */
    async updateSettings(input: {
        [K in keyof NotificationSettings]?: boolean | undefined;
    }): Promise<NotificationSettings> {
        const context = this.current();
        const data: Prisma.WorkspaceMemberUpdateInput = {};
        for (const key of Object.keys(SETTINGS) as (keyof NotificationSettings)[]) {
            const value = input[key];
            if (value !== undefined) data[key] = value;
        }
        return this.rls.withWorkspace(async (tx) =>
            tx.workspaceMember.update({
                where: { id: await requireCallerMember(tx, context) },
                data,
                select: SETTINGS,
            }),
        );
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
    await notify(
        tx,
        workspaceId,
        [memberId],
        kind,
        taskIds.map((id) => ({ type: 'task', id })),
    );
}

function detailOf(detail: Prisma.JsonValue): Record<string, string | undefined> {
    return detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, string>) : {};
}

/** A member's open tasks, soonest due first and no due date last, with what each is about. */
async function openTasksIn(tx: WorkspaceClient, memberId: string): Promise<MyTaskView[]> {
    const rows = await tx.task.findMany({
        where: { ...OPEN, assigneeId: memberId },
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
        take: MY_TASKS_LIMIT,
        select: MY_TASK_SELECT,
    });
    return myTaskViews(tx, rows);
}

/** What a task row needs to be a `MyTask`: My tasks and Today's tasks read the same. */
export const MY_TASK_SELECT = { id: true, title: true, status: true, dueAt: true, ...WITH_TARGETS } as const;

/** Tasks as `MyTask`s, in the order given, their targets labelled in one query per kind. */
export async function myTaskViews(
    tx: WorkspaceClient,
    rows: readonly Prisma.TaskGetPayload<{ select: typeof MY_TASK_SELECT }>[],
): Promise<MyTaskView[]> {
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
