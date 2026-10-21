import type { DomainEvent } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import type { TasksService } from './tasks.service';

/** The deal columns the follow-up reminder reads. */
export interface FollowUpDeal {
    id: string;
    name: string;
    ownerId: string | null;
    nextFollowUpDate: Date | null;
    followUpTaskId: string | null;
}

/** What a follow-up date change does to the deal's reminder task. Pure, so the rules are tested on their own. */
export type FollowUpPlan =
    { kind: 'none' } | { kind: 'create' } | { kind: 'reschedule'; taskId: string } | { kind: 'remove'; taskId: string };

/**
 * #242: a deal's Next Follow-up Date keeps exactly one open task, due that day and assigned to the deal's owner.
 * Setting the date makes the task (or a new one, when the last is done or deleted); changing it moves the open task;
 * clearing it deletes the open task. A task the owner completed is left alone: it is history.
 */
export function followUpPlan(date: Date | null, task: { id: string; open: boolean } | null): FollowUpPlan {
    if (date === null) return task?.open ? { kind: 'remove', taskId: task.id } : { kind: 'none' };
    return task?.open ? { kind: 'reschedule', taskId: task.id } : { kind: 'create' };
}

/** Applies `followUpPlan` in `tx`; returns the task events for the caller to record with its own. */
export async function syncFollowUpTask(
    tx: WorkspaceClient,
    context: WorkspaceRunContext,
    tasks: TasksService,
    deal: FollowUpDeal,
): Promise<DomainEvent[]> {
    const current = deal.followUpTaskId
        ? await tx.task.findUnique({
              where: { id: deal.followUpTaskId },
              select: { id: true, status: true, deletedAt: true },
          })
        : null;
    const plan = followUpPlan(
        deal.nextFollowUpDate,
        current ? { id: current.id, open: current.deletedAt === null && current.status !== 'done' } : null,
    );
    const dueAt = deal.nextFollowUpDate?.toISOString();
    switch (plan.kind) {
        case 'none':
            if (deal.followUpTaskId && !current) {
                await tx.opportunity.update({ where: { id: deal.id }, data: { followUpTaskId: null } });
            }
            return [];
        case 'create': {
            const created = await tasks.createIn(tx, context, {
                title: `Follow up: ${deal.name}`,
                dueAt,
                assigneeId: deal.ownerId,
                targets: [{ type: 'opportunity', id: deal.id }],
            });
            await tx.opportunity.update({ where: { id: deal.id }, data: { followUpTaskId: created.row.id } });
            return [created.event];
        }
        case 'reschedule': {
            const updated = await tasks.updateIn(tx, context, plan.taskId, { dueAt });
            return updated.event ? [updated.event] : [];
        }
        case 'remove': {
            await tx.task.update({ where: { id: plan.taskId }, data: { deletedAt: new Date() } });
            return [
                {
                    type: 'task.deleted',
                    object: 'task',
                    workspaceId: context.workspaceId,
                    actor: actorOf(context),
                    occurredAt: new Date().toISOString(),
                    recordId: plan.taskId,
                    targets: [{ type: 'opportunity', id: deal.id }],
                },
            ];
        }
    }
}
