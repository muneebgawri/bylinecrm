import { Card, CardContent, CardHeader, Checkbox, EmptyState, LoadingRegion, Skeleton, cn, toast } from '@bylinecrm/ui';
import { CalendarClock, CheckCircle2, CircleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { useCompleteMyTask, useMyTasks } from '../../../api/notifications';
import type { MyTaskView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
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

const GROUP_ICON: Record<Group, { icon: typeof CircleAlert; className: string }> = {
    Overdue: { icon: CircleAlert, className: 'bg-danger-soft text-danger' },
    'Due today': { icon: CalendarClock, className: 'bg-warning-soft text-warning' },
    Upcoming: { icon: CalendarClock, className: 'bg-info-soft text-info' },
    'No due date': { icon: CheckCircle2, className: 'bg-surface-raised text-text-muted' },
};

/**
 * **My tasks** (#192): the member's open tasks, overdue first, then today's, the coming ones and
 * those with no date, each linked to what it is about. A sequence's "Call if no reply" lands here
 * as well as on the person. Completing one (with `task:write`) takes it off.
 */
export function MyTasksCard({ workspaceId, className }: { workspaceId: string; className?: string }) {
    const tasks = useMyTasks(workspaceId);
    const complete = useCompleteMyTask(workspaceId);
    const canComplete = useCan('task:write');
    if (tasks.isError) throw tasks.error;
    const now = new Date();
    const grouped = new Map<Group, MyTaskView[]>(GROUPS.map((g) => [g, []]));
    for (const t of tasks.data ?? []) grouped.get(groupOf(t, now))!.push(t);
    const open = tasks.data?.length ?? 0;

    return (
        <Card className={cn('gap-4', className)} aria-labelledby="my-tasks-title">
            <CardHeader className="flex flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                    <h2 id="my-tasks-title" className="m-0 text-sm font-semibold">
                        My tasks
                    </h2>
                    {tasks.data && (
                        <span className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[11px] font-medium text-text-muted">
                            {open} left
                        </span>
                    )}
                </div>
            </CardHeader>
            <CardContent>
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
                        const { icon: Icon, className: tile } = GROUP_ICON[group];
                        return (
                            <section key={group} aria-labelledby={id} className="mb-4 last:mb-0">
                                <h3
                                    id={id}
                                    className={cn(
                                        'm-0 mb-1 text-xs font-semibold',
                                        group === 'Overdue' ? 'text-danger' : 'text-text-muted',
                                    )}
                                >
                                    {group}
                                </h3>
                                <ul className="m-0 list-none divide-y divide-border p-0">
                                    {grouped.get(group)!.map((t) => (
                                        <li key={t.id} className="flex items-center gap-3 py-3 max-md:min-h-touch">
                                            <span
                                                aria-hidden
                                                className={cn(
                                                    'grid size-8 shrink-0 place-items-center rounded-full [&_svg]:size-4',
                                                    tile,
                                                )}
                                            >
                                                <Icon />
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <span className="block truncate text-sm font-medium">{t.title}</span>
                                                <span className="flex flex-wrap gap-x-3 text-xs text-text-muted">
                                                    {t.targets.map((target) => (
                                                        <Link
                                                            key={`${target.type}:${target.id}`}
                                                            to={recordPath(workspaceId, target)}
                                                            className="underline-offset-2 hover:text-text hover:underline max-md:inline-flex max-md:min-h-touch max-md:items-center"
                                                        >
                                                            {target.label}
                                                        </Link>
                                                    ))}
                                                </span>
                                            </div>
                                            {t.dueAt && (
                                                <span className="shrink-0 text-xs text-text-muted">
                                                    {formatWhen(t.dueAt)}
                                                </span>
                                            )}
                                            {canComplete && (
                                                <Checkbox
                                                    aria-label={`Complete “${t.title}”`}
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
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        );
                    })
                )}
            </CardContent>
        </Card>
    );
}
