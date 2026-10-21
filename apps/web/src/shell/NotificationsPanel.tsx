import { Button, Switch } from '@bylinecrm/ui';
import { useId, type ReactElement } from 'react';
import { Link } from 'react-router';
import { useMarkNotificationsRead, useNotificationSettings, useUpdateNotificationSettings } from '../api/notifications';
import type { NotificationsView } from '../api/types';
import { ResponsivePanel } from '../components/ResponsivePanel';
import { formatRelative } from '../lib/format';
import { paths } from '../routes/paths';
import { recordPath } from '../routes/w/records/targets';

type Item = NotificationsView['items'][number];

const KIND_LABEL: Record<Item['kind'], string> = {
    task_assigned: 'Assigned to you',
    task_due: 'Due',
    transfer_proposed: 'Offered to you',
    transfer_accepted: 'Transfer accepted',
    transfer_declined: 'Transfer declined',
    transfer_received: 'Moved to you',
    transfer_taken: 'Moved from you',
    guardrail_repeat_blocks: 'Guardrails',
    guardrail_alert: 'Sender reputation',
    invoice_needs_review: 'Invoice waiting for finance',
    invoice_coverage_lost: 'Refund: deal no longer paid in full',
    guardrail_poach_suspected: 'Another member’s lead mailed',
};

/** What a transfer notification says under its label. */
function transferLine(item: Item): string {
    const t = item.transfer!;
    const who = (m: { name: string | null } | null) => m?.name ?? 'a member';
    switch (item.kind) {
        case 'transfer_proposed':
            return `${who(t.from)} offers you ${t.recordLabel}`;
        case 'transfer_accepted':
            return `${who(t.to)} accepted ${t.recordLabel}`;
        case 'transfer_declined':
            return `${who(t.to)} declined ${t.recordLabel}`;
        case 'transfer_received':
            return `${t.recordLabel} is yours now`;
        default:
            return `${t.recordLabel} went to ${who(t.to)}`;
    }
}

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

/** What a guardrail notification says (GUARD-1): who kept being stopped, never what they wrote. */
function guardrailLine(item: Item): string {
    const g = item.guardrail!;
    // GUARD-2: who, whom, when and the subject — the event's own words; never the body.
    if (item.kind === 'guardrail_alert' || item.kind === 'guardrail_poach_suspected') return g.message;
    return `${g.actor?.name ?? 'A member'} was stopped ${g.count} times today from mailing others’ leads`;
}

function NotificationLink({ workspaceId, item, onOpen }: { workspaceId: string; item: Item; onOpen: () => void }) {
    const target = item.task
        ? item.task.targets[0]
        : item.transfer
          ? { type: item.transfer.object, id: item.transfer.recordId }
          : item.invoice
            ? { type: 'opportunity' as const, id: item.invoice.opportunityId }
            : undefined;
    const title = item.task
        ? item.task.title
        : item.transfer
          ? transferLine(item)
          : item.invoice
            ? `${item.invoice.opportunityName}: ${item.invoice.reference}`
            : guardrailLine(item);
    const to = target ? recordPath(workspaceId, target) : item.guardrail ? paths.settingsGuardrails(workspaceId) : null;
    const targets = item.task?.targets ?? [];
    const body = (
        <>
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
                {!item.readAt && <span aria-hidden className="size-1.5 rounded-full bg-accent" />}
                <span>{KIND_LABEL[item.kind]}</span>
                <span aria-hidden>·</span>
                {formatRelative(item.createdAt)}
            </span>
            <span className={item.readAt ? 'block text-sm' : 'block text-sm font-semibold'}>{title}</span>
            {item.transfer?.reason && (
                <span className="block truncate text-xs text-text-muted">{item.transfer.reason}</span>
            )}
            {targets.length > 0 && (
                <span className="block truncate text-xs text-text-muted">{targets.map((t) => t.label).join(', ')}</span>
            )}
        </>
    );
    const className =
        'block px-3 py-2.5 hover:bg-surface-raised focus-visible:bg-surface-raised outline-none max-md:min-h-touch';
    return to ? (
        <Link to={to} onClick={onOpen} className={className}>
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
