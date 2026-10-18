import { Checkbox, EmptyState, LoadingRegion, PageHeader, Skeleton, toast } from '@bylinecrm/ui';
import { Link } from 'react-router';
import { useCompleteMyTask, useMyTasks } from '../../../api/notifications';
import type { MyTaskView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { recordPath } from '../records/targets';

const GROUPS = ['Overdue', 'Due today', 'Upcoming', 'No due date'] as const;
type Group = (typeof GROUPS)[number];

/** Where a task falls against today, on the member's own clock: before today, today, later, or never. */
function groupOf(task: MyTaskView, now: Date): Group {
    if (!task.dueAt) return 'No due date';
    const due = new Date(task.dueAt);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (due < start) return 'Overdue';
    return due < end ? 'Due today' : 'Upcoming';
}

/**
 * The dashboard (#192): for now, **My tasks** — the member's open tasks, overdue first, then today's,
 * the coming ones and those with no date, each linked to what it is about. A sequence's "Call if no
 * reply" lands here as well as on the person. Completing one (with `task:write`) takes it off.
 */
export function HomePage() {
    const workspaceId = useWorkspaceId();
    const tasks = useMyTasks(workspaceId);
    const complete = useCompleteMyTask(workspaceId);
    const canComplete = useCan('task:write');
    if (tasks.isError) throw tasks.error;
    const now = new Date();
    const grouped = new Map<Group, MyTaskView[]>(GROUPS.map((g) => [g, []]));
    for (const t of tasks.data ?? []) grouped.get(groupOf(t, now))!.push(t);

    return (
        <div className="p-7 max-md:p-4">
            <PageHeader title="Dashboard" subtitle="What needs your attention today." />
            <section aria-labelledby="my-tasks-title" className="max-w-3xl">
                <h2 id="my-tasks-title" className="m-0 mb-3 text-base font-semibold">
                    My tasks
                </h2>
                {!tasks.data ? (
                    <LoadingRegion label="Loading your tasks">
                        <Skeleton className="h-9" />
                        <Skeleton className="mt-2 h-9" />
                    </LoadingRegion>
                ) : tasks.data.length === 0 ? (
                    <EmptyState
                        title="Nothing assigned to you"
                        body="Tasks assigned to you — by a teammate or a sequence step — show here."
                    />
                ) : (
                    GROUPS.filter((g) => grouped.get(g)!.length > 0).map((group) => {
                        const id = `my-tasks-${group.replaceAll(' ', '-').toLowerCase()}`;
                        return (
                            <section key={group} aria-labelledby={id} className="mb-5">
                                <h3
                                    id={id}
                                    className={
                                        group === 'Overdue'
                                            ? 'm-0 mb-1.5 text-[13px] font-semibold text-danger'
                                            : 'm-0 mb-1.5 text-[13px] font-semibold text-text-muted'
                                    }
                                >
                                    {group}
                                </h3>
                                <ul className="m-0 list-none rounded-lg border border-border bg-surface p-0">
                                    {grouped.get(group)!.map((t) => (
                                        <li
                                            key={t.id}
                                            className="flex items-start gap-3 border-b border-border px-3 py-2.5 last:border-b-0 max-md:min-h-touch"
                                        >
                                            {canComplete && (
                                                <Checkbox
                                                    aria-label={`Complete “${t.title}”`}
                                                    className="mt-0.5"
                                                    disabled={complete.isPending}
                                                    onCheckedChange={() =>
                                                        complete.mutate(t.id, {
                                                            onSuccess: () =>
                                                                toast({ title: `Done: ${t.title}`, tone: 'success' }),
                                                            onError: (error) =>
                                                                toast({
                                                                    title: 'Could not complete the task',
                                                                    description: failureText(error),
                                                                    tone: 'danger',
                                                                }),
                                                        })
                                                    }
                                                />
                                            )}
                                            <div className="min-w-0 flex-1">
                                                <span className="block text-sm">{t.title}</span>
                                                <span className="flex flex-wrap gap-x-2 text-xs text-text-muted">
                                                    {t.targets.map((target) => (
                                                        <Link
                                                            key={`${target.type}:${target.id}`}
                                                            to={recordPath(workspaceId, target)}
                                                            className="text-accent underline-offset-2 hover:underline max-md:inline-flex max-md:min-h-touch max-md:items-center"
                                                        >
                                                            {target.label}
                                                        </Link>
                                                    ))}
                                                    {t.dueAt && <span>Due {formatWhen(t.dueAt)}</span>}
                                                </span>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        );
                    })
                )}
            </section>
        </div>
    );
}
