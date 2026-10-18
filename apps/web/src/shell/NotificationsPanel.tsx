import { Button, Switch } from '@bylinecrm/ui';
import { useId, type ReactElement } from 'react';
import { Link } from 'react-router';
import { useMarkNotificationsRead, useNotificationSettings, useUpdateNotificationSettings } from '../api/notifications';
import type { NotificationsView } from '../api/types';
import { ResponsivePanel } from '../components/ResponsivePanel';
import { formatRelative } from '../lib/format';
import { recordPath } from '../routes/w/records/targets';

type Item = NotificationsView['items'][number];

const KIND_LABEL: Record<Item['kind'], string> = { task_assigned: 'Assigned to you', task_due: 'Due' };

/**
 * The bell's panel (#192), loaded the first time the bell opens: the member's task notifications —
 * a task someone else assigned them, a task that came due. Opening one goes to the record it is about
 * and marks it read; the footer holds the daily email of tasks due. A popover on a desktop, a bottom
 * sheet on a phone.
 */
export function NotificationsPanel({
    workspaceId,
    inbox,
    trigger,
    open,
    onOpenChange,
}: {
    workspaceId: string;
    inbox: NotificationsView | undefined;
    trigger: ReactElement;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const read = useMarkNotificationsRead(workspaceId);
    const unread = inbox?.unread ?? 0;
    const items = inbox?.items ?? [];
    return (
        <ResponsivePanel
            trigger={trigger}
            title="Notifications"
            open={open}
            onOpenChange={onOpenChange}
            widthClass="w-[min(22rem,calc(100vw-2rem))]"
            footer={<DigestSetting workspaceId={workspaceId} />}
        >
            {unread > 0 && (
                <div className="flex justify-end">
                    <Button size="sm" variant="ghost" shape="square" onClick={() => read.mutate(undefined)}>
                        Mark all read
                    </Button>
                </div>
            )}
            {items.length === 0 ? (
                <p className="m-0 py-6 text-center text-sm text-text-muted">Nothing new</p>
            ) : (
                <ul className="m-0 max-h-[60vh] list-none overflow-y-auto p-0">
                    {items.map((n) => (
                        <li key={n.id} className="border-b border-border last:border-b-0">
                            <NotificationLink
                                workspaceId={workspaceId}
                                item={n}
                                onOpen={() => {
                                    if (!n.readAt) read.mutate([n.id]);
                                    onOpenChange(false);
                                }}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </ResponsivePanel>
    );
}

function NotificationLink({ workspaceId, item, onOpen }: { workspaceId: string; item: Item; onOpen: () => void }) {
    const target = item.task.targets[0];
    const body = (
        <>
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
                {!item.readAt && <span aria-hidden className="size-1.5 rounded-full bg-accent" />}
                <span>{KIND_LABEL[item.kind]}</span>
                <span aria-hidden>·</span>
                {formatRelative(item.createdAt)}
            </span>
            <span className={item.readAt ? 'block text-sm' : 'block text-sm font-semibold'}>{item.task.title}</span>
            {item.task.targets.length > 0 && (
                <span className="block truncate text-xs text-text-muted">
                    {item.task.targets.map((t) => t.label).join(', ')}
                </span>
            )}
        </>
    );
    const className =
        'block px-3 py-2.5 hover:bg-surface-raised focus-visible:bg-surface-raised outline-none max-md:min-h-touch';
    return target ? (
        <Link to={recordPath(workspaceId, target)} onClick={onOpen} className={className}>
            {body}
        </Link>
    ) : (
        <div className={className}>{body}</div>
    );
}

/** The daily email of tasks due or overdue (#192): on unless the member turns it off. */
function DigestSetting({ workspaceId }: { workspaceId: string }) {
    const id = useId();
    const settings = useNotificationSettings(workspaceId);
    const update = useUpdateNotificationSettings(workspaceId);
    if (!settings.data) return null;
    return (
        <div className="flex w-full items-center justify-between gap-3">
            <label htmlFor={id} className="text-xs text-text-muted">
                Daily email of tasks due, each morning
            </label>
            <Switch
                id={id}
                checked={settings.data.taskDigest}
                disabled={update.isPending}
                onCheckedChange={(taskDigest) => update.mutate({ taskDigest })}
            />
        </div>
    );
}
