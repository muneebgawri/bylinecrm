import { TRANSFER_REASON_CADENCE_ROTATION } from '@bylinecrm/shared';
import { Button, Switch, Tabs, TabsList, TabsTrigger, cn, toneSoft, type Tone } from '@bylinecrm/ui';
import { ArrowRightLeft, Bell, CalendarClock, Check, CircleDollarSign, ListTodo, ShieldAlert } from 'lucide-react';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMarkNotificationsRead, useNotificationSettings, useUpdateNotificationSettings } from '../api/notifications';
import type { NotificationsView } from '../api/types';
import { ResponsivePanel } from '../components/ResponsivePanel';
import { formatDate, formatRelative } from '../lib/format';
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
    cadence_warning: 'Follow-up overdue',
    cadence_rotated: 'Lead rotated',
    payment_needs_deal: 'Payment received: which deal?',
    payment_created_deal: 'Payment received: deal created',
    payment_unmatched: 'Payment from an unknown client',
};

/** The tile each kind wears: an icon and a tone, so a glance tells a task from a payment. */
const KIND_LOOK: Record<Item['kind'], { icon: ReactNode; tone: Tone }> = {
    task_assigned: { icon: <ListTodo />, tone: 'info' },
    task_due: { icon: <CalendarClock />, tone: 'warning' },
    transfer_proposed: { icon: <ArrowRightLeft />, tone: 'accent' },
    transfer_accepted: { icon: <ArrowRightLeft />, tone: 'success' },
    transfer_declined: { icon: <ArrowRightLeft />, tone: 'danger' },
    transfer_received: { icon: <ArrowRightLeft />, tone: 'success' },
    transfer_taken: { icon: <ArrowRightLeft />, tone: 'neutral' },
    guardrail_repeat_blocks: { icon: <ShieldAlert />, tone: 'warning' },
    guardrail_alert: { icon: <ShieldAlert />, tone: 'danger' },
    invoice_needs_review: { icon: <CircleDollarSign />, tone: 'warning' },
    invoice_coverage_lost: { icon: <CircleDollarSign />, tone: 'danger' },
    guardrail_poach_suspected: { icon: <ShieldAlert />, tone: 'danger' },
    cadence_warning: { icon: <CalendarClock />, tone: 'warning' },
    cadence_rotated: { icon: <ArrowRightLeft />, tone: 'neutral' },
    payment_needs_deal: { icon: <CircleDollarSign />, tone: 'warning' },
    payment_created_deal: { icon: <CircleDollarSign />, tone: 'success' },
    payment_unmatched: { icon: <CircleDollarSign />, tone: 'danger' },
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
            // CADENCE-1: a rotation says why.
            return t.reason === TRANSFER_REASON_CADENCE_ROTATION
                ? `${t.recordLabel} rotated to ${who(t.to)}: its follow-up cadence lapsed`
                : `${t.recordLabel} went to ${who(t.to)}`;
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
    const [tab, setTab] = useState<'all' | 'unread'>('all');
    const unread = inbox?.unread ?? 0;
    const all = inbox?.items ?? [];
    const items = tab === 'unread' ? all.filter((n) => !n.readAt) : all;
    return (
        <ResponsivePanel
            trigger={trigger}
            title="Notifications"
            open={open}
            onOpenChange={onOpenChange}
            widthClass="w-[min(24rem,calc(100vw-2rem))]"
            footer={<DigestSetting workspaceId={workspaceId} />}
        >
            <div className="mb-2 flex items-center justify-between gap-2">
                <Tabs value={tab} onValueChange={(v) => setTab(v as 'all' | 'unread')}>
                    <TabsList variant="pill" aria-label="Which notifications" className="h-8">
                        <TabsTrigger value="all" className="text-xs">
                            All
                        </TabsTrigger>
                        <TabsTrigger value="unread" className="text-xs">
                            Unread
                            {unread > 0 && (
                                <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground tabular-nums">
                                    {unread}
                                </span>
                            )}
                        </TabsTrigger>
                    </TabsList>
                </Tabs>
                {unread > 0 && (
                    <Button size="sm" variant="ghost" shape="square" onClick={() => read.mutate(undefined)}>
                        <Check aria-hidden /> Mark all read
                    </Button>
                )}
            </div>
            {items.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                    <span className="grid size-10 place-items-center rounded-full bg-surface-raised text-text-muted [&_svg]:size-5">
                        <Bell aria-hidden />
                    </span>
                    <p className="m-0 text-sm font-medium">{tab === 'unread' ? 'All caught up' : 'Nothing yet'}</p>
                    <p className="m-0 text-xs text-text-muted">
                        {tab === 'unread'
                            ? 'Every notification has been read.'
                            : 'Tasks, transfers, payments and alerts for you show here.'}
                    </p>
                </div>
            ) : (
                <ul className="m-0 max-h-[60vh] list-none divide-y divide-border overflow-y-auto p-0">
                    {items.map((n) => (
                        <li key={n.id} className="group relative">
                            <NotificationLink
                                workspaceId={workspaceId}
                                item={n}
                                onOpen={() => {
                                    if (!n.readAt) read.mutate([n.id]);
                                    onOpenChange(false);
                                }}
                            />
                            {!n.readAt && (
                                <button
                                    type="button"
                                    aria-label="Mark as read"
                                    title="Mark as read"
                                    onClick={() => read.mutate([n.id])}
                                    className={cn(
                                        'absolute top-2.5 right-2 grid size-7 place-items-center rounded-md text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface-raised hover:text-text focus-visible:opacity-100 max-md:opacity-100',
                                    )}
                                >
                                    <Check aria-hidden className="size-4" />
                                </button>
                            )}
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
            : item.cadence
              ? { type: 'opportunity' as const, id: item.cadence.opportunityId }
              : undefined;
    const pay = item.payment;
    const title = item.task
        ? item.task.title
        : item.transfer
          ? transferLine(item)
          : item.invoice
            ? `${item.invoice.opportunityName}: ${item.invoice.reference}`
            : item.cadence
              ? `${item.cadence.opportunityName} (${item.cadence.stageName}): touch it by ${formatDate(item.cadence.rotateAt)} or it rotates to the next rep`
              : pay
                ? `${pay.clientName ?? 'A client'} paid ${pay.invoiceNumber}${pay.opportunityName ? ` · ${pay.opportunityName}` : ''}`
                : guardrailLine(item);
    // INV-2: a payment on its deal opens the deal; one waiting for a deal opens the page to choose it.
    const to = target
        ? recordPath(workspaceId, target)
        : pay
          ? pay.opportunityId
              ? paths.deal(workspaceId, pay.opportunityId)
              : paths.payment(workspaceId, pay.id)
          : item.guardrail
            ? paths.settingsGuardrails(workspaceId)
            : null;
    const targets = item.task?.targets ?? [];
    const look = KIND_LOOK[item.kind];
    const body = (
        <>
            <span
                aria-hidden
                className={cn('grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4', toneSoft[look.tone])}
            >
                {look.icon}
            </span>
            <span className="min-w-0 flex-1 pr-7">
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                    {!item.readAt && <span aria-hidden className="size-1.5 rounded-full bg-accent" />}
                    <span>{KIND_LABEL[item.kind]}</span>
                    <span aria-hidden>·</span>
                    {formatRelative(item.createdAt)}
                </span>
                <span className={item.readAt ? 'block truncate text-sm' : 'block truncate text-sm font-semibold'}>
                    {title}
                </span>
                {item.transfer?.reason && (
                    <span className="block truncate text-xs text-text-muted">{item.transfer.reason}</span>
                )}
                {targets.length > 0 && (
                    <span className="block truncate text-xs text-text-muted">
                        {targets.map((t) => t.label).join(', ')}
                    </span>
                )}
            </span>
        </>
    );
    const className =
        'flex items-start gap-3 px-3 py-3 hover:bg-surface-raised focus-visible:bg-surface-raised outline-none max-md:min-h-touch';
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
