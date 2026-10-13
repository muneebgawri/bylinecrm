import { TASK_STATUSES, type RecordTarget, type TaskStatus } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Field,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    type BadgeProps,
} from '@bylinecrm/ui';
import { useState } from 'react';
import { useDeleteTask, useMembersSummary, useSaveTask, useTasks, currentMembers } from '../../../api/records';
import type { TaskView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { formatDate, formatWhen } from '../../../lib/format';
import { messageFor } from './InlineEdit';
import { RailCard, RailEmpty, RailLoading, RailRow } from './RailCard';

const STATUS_LABEL: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
const STATUS_TONE: Record<TaskStatus, NonNullable<BadgeProps['status']>> = {
    todo: 'neutral',
    in_progress: 'info',
    done: 'success',
};

/** Tasks on a record: the rail card; "+ Add task" and a row open the dialog. */
export function TasksPanel({
    workspaceId,
    target,
    open,
    onOpenChange,
}: {
    workspaceId: string;
    target: RecordTarget;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const tasks = useTasks(workspaceId, target);
    const write = usePermission('task:write');
    const [editing, setEditing] = useState<TaskView | null>(null);
    const items = tasks.data?.pages.flatMap((p) => p.items) ?? [];
    const openWith = (task: TaskView | null) => {
        setEditing(task);
        onOpenChange(true);
    };

    return (
        <RailCard
            title="Tasks"
            count={tasks.data ? items.filter((t) => t.status !== 'done').length : undefined}
            action={
                write.allowed ? (
                    <Button size="xs" shape="square" variant="ghost" onClick={() => openWith(null)}>
                        + Add task
                    </Button>
                ) : (
                    <span className="text-xs text-text-faint" title={write.reason}>
                        read only
                    </span>
                )
            }
        >
            {tasks.isPending ? (
                <RailLoading />
            ) : tasks.isError ? (
                <RailEmpty>Tasks could not be loaded.</RailEmpty>
            ) : items.length === 0 ? (
                <RailEmpty>No tasks yet.</RailEmpty>
            ) : (
                items.map((task) => (
                    <RailRow
                        key={task.id}
                        onClick={write.allowed ? () => openWith(task) : undefined}
                        title={
                            <span className="flex items-center gap-2">
                                <span className="truncate">{task.title}</span>
                                <Badge status={STATUS_TONE[task.status]} className="ml-auto shrink-0">
                                    {STATUS_LABEL[task.status]}
                                </Badge>
                            </span>
                        }
                        subtitle={task.dueAt ? `Due ${formatDate(task.dueAt)}` : `Added ${formatWhen(task.createdAt)}`}
                    />
                ))
            )}
            {open && (
                <TaskDialog
                    workspaceId={workspaceId}
                    target={target}
                    task={editing}
                    onClose={() => {
                        setEditing(null);
                        onOpenChange(false);
                    }}
                />
            )}
        </RailCard>
    );
}

/** `dueAt` is an instant; the input wants the local `YYYY-MM-DDTHH:mm`. */
function toLocalInput(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TaskDialog({
    workspaceId,
    target,
    task,
    onClose,
}: {
    workspaceId: string;
    target: RecordTarget;
    task: TaskView | null;
    onClose: () => void;
}) {
    const save = useSaveTask(workspaceId, target);
    const remove = useDeleteTask(workspaceId, target);
    const members = useMembersSummary(workspaceId);
    const [title, setTitle] = useState(task?.title ?? '');
    const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'todo');
    const [due, setDue] = useState(toLocalInput(task?.dueAt ?? null));
    const [assignee, setAssignee] = useState(task?.assigneeId ?? '');
    const [confirming, setConfirming] = useState(false);
    const titleError = save.error ? messageFor(save.error, 'title') : null;

    return (
        <Dialog open onOpenChange={(o) => !o && onClose()}>
            <DialogContent>
                <DialogTitle>{task ? 'Edit task' : 'New task'}</DialogTitle>
                <DialogDescription>A task is attached to this record and shows on its timeline.</DialogDescription>
                <form
                    id="task-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        save.mutate(
                            {
                                ...(task ? { id: task.id } : {}),
                                title: title.trim(),
                                status,
                                dueAt: due ? new Date(due).toISOString() : null,
                                assigneeId: assignee || null,
                            },
                            { onSuccess: onClose },
                        );
                    }}
                >
                    <DialogBody className="flex flex-col gap-3">
                        <Field
                            label="Title"
                            required
                            error={save.isError && titleError !== save.error?.message ? titleError : undefined}
                        >
                            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
                        </Field>
                        <Field label="Status">
                            <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {TASK_STATUSES.map((s) => (
                                        <SelectItem key={s} value={s}>
                                            {STATUS_LABEL[s]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field label="Due">
                            <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
                        </Field>
                        <Field label="Assignee">
                            <Select
                                value={assignee || '__none__'}
                                onValueChange={(v) => setAssignee(v === '__none__' ? '' : v)}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Unassigned" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="__none__">Unassigned</SelectItem>
                                    {currentMembers(members.data).map((m) => (
                                        <SelectItem key={m.memberId} value={m.memberId}>
                                            {m.name ?? 'Unnamed member'}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        {save.isError && titleError === save.error?.message && (
                            <p role="alert" className="m-0 text-sm text-danger">
                                {titleError}
                            </p>
                        )}
                        {remove.isError && (
                            <p role="alert" className="m-0 text-sm text-danger">
                                {messageFor(remove.error, 'task')}
                            </p>
                        )}
                    </DialogBody>
                </form>
                <DialogFooter>
                    {task &&
                        (confirming ? (
                            <>
                                <span className="mr-auto self-center text-sm text-text-muted">Delete this task?</span>
                                <Button
                                    variant="danger"
                                    shape="square"
                                    disabled={remove.isPending}
                                    onClick={() => remove.mutate(task.id, { onSuccess: onClose })}
                                >
                                    Delete
                                </Button>
                                <Button variant="ghost" shape="square" onClick={() => setConfirming(false)}>
                                    Keep
                                </Button>
                            </>
                        ) : (
                            <Button
                                variant="ghost"
                                shape="square"
                                className="mr-auto text-danger"
                                onClick={() => setConfirming(true)}
                            >
                                Delete
                            </Button>
                        ))}
                    <Button variant="secondary" shape="square" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        form="task-form"
                        variant="primary"
                        shape="square"
                        disabled={save.isPending || !title.trim()}
                    >
                        {task ? 'Save' : 'Add task'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
