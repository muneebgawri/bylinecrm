import { LIST_COUNT_CAP, type TodaySection } from '@bylinecrm/shared';
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
    EmptyState,
    Input,
    KpiCard,
    LoadingRegion,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Skeleton,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
    toast,
} from '@bylinecrm/ui';
import { useQueryClient } from '@tanstack/react-query';
import {
    AlarmClock,
    CalendarClock,
    CalendarPlus,
    Check,
    Hourglass,
    ListChecks,
    Mail,
    MailWarning,
    MoreHorizontal,
    Phone,
    UserPlus,
    type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { usePipeline } from '../../../api/deals';
import { ResponsivePanel } from '../../../components/ResponsivePanel';
import { useUpdateMyTask } from '../../../api/notifications';
import { useMembersSummary, usePatchRecord, useRecord } from '../../../api/records';
import { todayKeys, useToday, useTodayMore, type TodayParams } from '../../../api/today';
import type {
    MyTaskView,
    TodayDealView,
    TodayLeadView,
    TodayPersonView,
    TodayReplyView,
    TodayView,
} from '../../../api/types';
import { can, useCan, useMembership } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { formatDay, formatWhen } from '../../../lib/format';
import { formatMoney } from '../../../lib/money';
import { useWorkspaceId } from '../../params';
import { useDealMove } from '../deals/useDealMove';
import { RecordCompose, type RecordComposeHandle } from '../mail/RecordCompose';
import { withThread } from '../mail/thread';
import { CallPanel } from '../records/CallPanel';
import { withOpen } from '../records/targets';

/** What a row's person action opens: the composer or the call panel, for whom and about which deal. */
interface PersonAction {
    kind: 'email' | 'call';
    person: TodayPersonView;
    dealId?: string | undefined;
    /** A fresh composer each time, even for the same person. */
    nonce: number;
}

interface RowContext {
    workspaceId: string;
    search: string;
    act: (action: Omit<PersonAction, 'nonce'>) => void;
    /** A row acted on leaves the list at once; the next read agrees once the server has caught up. */
    done: (section: TodaySection, id: string) => void;
    /** Undo from a task's notice: the status or due time put back, and the row with it. The page owns the
     *  mutation, as the row is gone by the time Undo is chosen. */
    undoTask: (task: MyTaskView, before: { status?: MyTaskView['status']; dueAt?: string | null }) => void;
    canWrite: boolean;
    /** `deal:move` — without it there is no Move action, as on the board. */
    canMove: boolean;
}

const SECTION_META: Record<
    TodaySection,
    { title: string; icon: LucideIcon; tone: 'danger' | 'warning' | 'info' | 'accent' | 'neutral' }
> = {
    replies: { title: 'Replies waiting', icon: MailWarning, tone: 'danger' },
    followUps: { title: 'Follow-ups due', icon: CalendarClock, tone: 'warning' },
    newLeads: { title: 'New leads', icon: UserPlus, tone: 'info' },
    tasks: { title: 'Tasks due', icon: ListChecks, tone: 'accent' },
    stalled: { title: 'Stalled deals', icon: Hourglass, tone: 'neutral' },
};

function countText(count: number, exact: boolean): string {
    return exact || count < LIST_COUNT_CAP ? count.toLocaleString() : `${count.toLocaleString()}+`;
}

/**
 * The day's work (#360), on the dashboard: the member's day, most urgent first — the replies nobody has answered, the deals whose follow-up is
 * due, the new leads nobody has contacted, the tasks due and the deals gone quiet. Every row carries what to do
 * about it: open it, email or call the person, move the deal or plan its next follow-up, finish or snooze the task.
 * An admin can read any member's day. Each list is counted and paged by the API, so a backlog of thousands reads
 * the same as a handful.
 */
export function TodayWork({
    workspaceId,
    params,
    onMemberChange,
}: {
    workspaceId: string;
    /** Whose day and where "today" is; the page owns them (the welcome counts the same list). */
    params: TodayParams;
    onMemberChange: (memberId: string | undefined) => void;
}) {
    const memberId = params.memberId;
    const membership = useMembership();
    const admin = can(membership, 'workspace:admin');
    const canWrite = useCan('record:write');
    const canMove = useCan('deal:move');
    const location = useLocation();
    const client = useQueryClient();
    const day = useToday(workspaceId, params);
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    const [action, setAction] = useState<PersonAction | null>(null);
    const taskUpdate = useUpdateMyTask(workspaceId);
    if (day.isError) throw day.error;

    const refresh = () => void client.invalidateQueries({ queryKey: todayKeys.all(workspaceId) });
    const context: RowContext = {
        workspaceId,
        search: location.search,
        act: (a) => setAction({ ...a, nonce: Date.now() }),
        done: (section, id) => setHidden((h) => new Set(h).add(`${section}:${id}`)),
        undoTask: (task, before) =>
            taskUpdate.mutate(
                { taskId: task.id, ...before },
                {
                    onSuccess: () => {
                        setHidden((h) => {
                            const next = new Set(h);
                            next.delete(`tasks:${task.id}`);
                            return next;
                        });
                        toast({ title: `Put back: ${task.title}`, tone: 'success' });
                    },
                    onError: (error) =>
                        toast({ title: 'The task was not put back', description: failureText(error), tone: 'danger' }),
                },
            ),
        canWrite,
        canMove,
    };
    const data = day.data;
    const own = !memberId || memberId === membership?.memberId;

    return (
        <section aria-labelledby="today-title" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 id="today-title" className="m-0 text-base font-semibold">
                        Today
                    </h2>
                    <p className="m-0 text-sm text-text-muted">
                        {data
                            ? `${formatDay(data.date)} · ${own ? 'what needs you now' : `what needs ${data.member.name ?? 'this member'} now`}`
                            : 'What needs you now.'}
                    </p>
                </div>
                {admin && <MemberPicker workspaceId={workspaceId} value={memberId} onChange={onMemberChange} />}
            </div>
            <TodaySummary data={data} />
            <div className="grid grid-cols-12 gap-4">
                <SectionCard
                    section="replies"
                    data={data}
                    params={params}
                    hidden={hidden}
                    description={data ? `Their latest message is unanswered · last ${data.windows.replyDays} days` : ''}
                    empty="No one is waiting for an answer."
                    className="col-span-12 xl:col-span-6"
                    render={(item) => <ReplyRow key={item.messageId} reply={item} context={context} />}
                />
                <SectionCard
                    section="tasks"
                    data={data}
                    params={params}
                    hidden={hidden}
                    description="Due today or overdue"
                    empty="No task is due today."
                    className="col-span-12 xl:col-span-6"
                    render={(item) => <TaskRow key={item.id} task={item} context={context} />}
                />
                <SectionCard
                    section="followUps"
                    data={data}
                    params={params}
                    hidden={hidden}
                    description="The cadence or a planned follow-up falls due by tonight"
                    empty="No follow-up is due."
                    className="col-span-12 xl:col-span-6"
                    render={(item) => <DealRow key={item.id} deal={item} section="followUps" context={context} />}
                />
                <SectionCard
                    section="newLeads"
                    data={data}
                    params={params}
                    hidden={hidden}
                    description={data ? `Made in the last ${data.windows.newLeadDays} days, never contacted` : ''}
                    empty="No new lead is waiting for a first touch."
                    className="col-span-12 xl:col-span-6"
                    render={(item) => <LeadRow key={item.id} lead={item} context={context} />}
                />
                <SectionCard
                    section="stalled"
                    data={data}
                    params={params}
                    hidden={hidden}
                    description={data ? `No activity for ${data.windows.stalledDays} days and nothing planned` : ''}
                    empty="No deal has gone quiet."
                    className="col-span-12"
                    render={(item) => <DealRow key={item.id} deal={item} section="stalled" context={context} />}
                />
            </div>
            {action?.kind === 'email' && (
                <EmailSheet key={action.nonce} workspaceId={workspaceId} action={action} onSent={refresh} />
            )}
            {action?.kind === 'call' && (
                <CallPanel
                    workspaceId={workspaceId}
                    personId={action.person.id}
                    personName={action.person.name}
                    phone={action.person.phones.primary}
                    open
                    onOpenChange={(open) => {
                        if (open) return;
                        setAction(null);
                        refresh();
                    }}
                />
            )}
        </section>
    );
}

/** An admin's choice of whose day to read; everyone else reads their own. */
function MemberPicker({
    workspaceId,
    value,
    onChange,
}: {
    workspaceId: string;
    value: string | undefined;
    onChange: (memberId: string | undefined) => void;
}) {
    const members = useMembersSummary(workspaceId);
    const membership = useMembership();
    const me = membership?.memberId ?? '';
    const current = (members.data ?? []).filter((m) => m.leftAt === null);
    return (
        <Select value={value ?? me} onValueChange={(id) => onChange(id === me ? undefined : id)}>
            <SelectTrigger aria-label="Whose day" className="w-56">
                <SelectValue placeholder="Choose a member" />
            </SelectTrigger>
            <SelectContent>
                {current.map((m) => (
                    <SelectItem key={m.memberId} value={m.memberId}>
                        {m.memberId === me ? `${m.name ?? 'You'} (you)` : (m.name ?? 'Unnamed member')}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

/** The five counts at a glance; each jumps to its list. */
function TodaySummary({ data }: { data: TodayView | undefined }) {
    const sections: TodaySection[] = ['replies', 'followUps', 'newLeads', 'tasks', 'stalled'];
    return (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 xl:grid-cols-5">
            {sections.map((s) => {
                const meta = SECTION_META[s];
                const Icon = meta.icon;
                return data ? (
                    <a key={s} href={`#today-${s}`} className="rounded-xl no-underline">
                        <KpiCard
                            className="gap-1 py-4"
                            icon={<Icon />}
                            tone={meta.tone}
                            label={meta.title}
                            value={countText(data[s].count, data[s].countIsExact)}
                        />
                    </a>
                ) : (
                    <Skeleton key={s} className="h-21 rounded-xl" />
                );
            })}
        </div>
    );
}

type ItemOf<S extends TodaySection> = TodayView[S]['items'][number];

/** One section: its title and count, its rows (the overview's first page, then any "Show more" pages). */
function SectionCard<S extends TodaySection>({
    section,
    data,
    params,
    hidden,
    description,
    empty,
    className,
    render,
}: {
    section: S;
    data: TodayView | undefined;
    params: TodayParams;
    hidden: ReadonlySet<string>;
    description: string;
    empty: string;
    className?: string;
    render: (item: ItemOf<S>) => ReactNode;
}) {
    const workspaceId = useWorkspaceId();
    const first = data?.[section];
    // "Show more" continues from the first page's cursor; a new first page (another member, a refresh that moved
    // things) starts over, as its cursor is not the one the extra pages came from.
    const [expandedFrom, setExpandedFrom] = useState<string | null>(null);
    const firstCursor = first?.nextCursor ?? null;
    const expanded = expandedFrom !== null && expandedFrom === firstCursor;
    const more = useTodayMore(workspaceId, section, params, firstCursor, expanded);
    const meta = SECTION_META[section];
    const titleId = `today-${section}-title`;
    const rowId = (item: ItemOf<S>) => ('messageId' in item ? item.messageId : item.id);
    const items = [
        ...((first?.items ?? []) as ItemOf<S>[]),
        ...(expanded ? (more.data?.pages ?? []).flatMap((p) => p.items as ItemOf<S>[]) : []),
    ].filter((item) => !hidden.has(`${section}:${rowId(item)}`));
    const hasMore = expanded ? more.hasNextPage : (first?.nextCursor ?? null) !== null;

    return (
        <Card
            id={`today-${section}`}
            role="region"
            className={cn('scroll-mt-4 gap-3', className)}
            aria-labelledby={titleId}
        >
            <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <h2 id={titleId} className="m-0 text-sm font-semibold">
                            {meta.title}
                        </h2>
                        {first && (
                            <span className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[11px] font-medium text-text-muted">
                                {countText(first.count, first.countIsExact)}
                            </span>
                        )}
                    </div>
                    {description && <p className="m-0 mt-0.5 text-xs text-text-muted">{description}</p>}
                </div>
            </CardHeader>
            <CardContent>
                {!first ? (
                    <LoadingRegion label={`Loading ${meta.title.toLowerCase()}`}>
                        <Skeleton className="h-12" />
                        <Skeleton className="mt-2 h-12" />
                    </LoadingRegion>
                ) : items.length === 0 && !hasMore ? (
                    <EmptyState title="All clear" body={empty} />
                ) : (
                    <>
                        <ul className="m-0 list-none divide-y divide-border p-0">{items.map(render)}</ul>
                        {hasMore && (
                            <div className="mt-2 flex justify-center">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    loading={more.isFetching}
                                    onClick={() =>
                                        expanded ? void more.fetchNextPage() : setExpandedFrom(firstCursor)
                                    }
                                >
                                    Show more
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}

/** A row: what it is (and a link to open it), when, and its actions on the right. */
function Row({
    icon: Icon,
    tone,
    title,
    meta,
    detail,
    actions,
}: {
    icon: LucideIcon;
    tone: string;
    title: ReactNode;
    meta: ReactNode;
    detail?: ReactNode;
    actions: ReactNode;
}) {
    return (
        <li className="flex items-start gap-3 py-3">
            <span
                aria-hidden
                className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-full [&_svg]:size-4', tone)}
            >
                <Icon />
            </span>
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{title}</div>
                <div className="flex flex-wrap items-center gap-x-3 text-xs text-text-muted">{meta}</div>
                {detail && <p className="m-0 mt-1 line-clamp-2 text-xs text-text-muted">{detail}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
        </li>
    );
}

const linkClass =
    'text-text underline-offset-2 hover:underline max-md:inline-flex max-md:min-h-touch max-md:items-center';
const metaLinkClass =
    'underline-offset-2 hover:text-text hover:underline max-md:inline-flex max-md:min-h-touch max-md:items-center';

/**
 * An action's name on hover and focus (the icon alone does not say it). A disabled button takes no focus,
 * so a wrapper does and the tooltip stays reachable — the record actions' pattern.
 */
function WithTip({ label, disabled, children }: { label: string; disabled?: boolean; children: ReactNode }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                {disabled ? (
                    <span tabIndex={0} className="inline-flex rounded-md">
                        {children}
                    </span>
                ) : (
                    children
                )}
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
        </Tooltip>
    );
}

/** Email and call: the person's two ways to reach them, as icon buttons. */
function PersonButtons({
    person,
    dealId,
    context,
}: {
    person: TodayPersonView;
    dealId?: string | undefined;
    context: RowContext;
}) {
    const noEmail = !person.email || !context.canWrite;
    const noPhone = !person.phones.primary || !context.canWrite;
    return (
        <>
            <WithTip
                label={!context.canWrite ? 'Email' : person.email ? 'Email' : 'No email address'}
                disabled={noEmail}
            >
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Email ${person.name}`}
                    disabled={noEmail}
                    onClick={() => context.act({ kind: 'email', person, dealId })}
                >
                    <Mail />
                </Button>
            </WithTip>
            <WithTip
                label={!context.canWrite ? 'Call' : person.phones.primary ? 'Call' : 'No phone number'}
                disabled={noPhone}
            >
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Call ${person.name}`}
                    disabled={noPhone}
                    onClick={() => context.act({ kind: 'call', person, dealId })}
                >
                    <Phone />
                </Button>
            </WithTip>
        </>
    );
}

function ReplyRow({ reply, context }: { reply: TodayReplyView; context: RowContext }) {
    const person = reply.person;
    return (
        <Row
            icon={MailWarning}
            tone="bg-danger-soft text-danger"
            title={
                <Link to={{ search: withThread(context.search, reply.threadId) }} className={linkClass}>
                    {reply.subject || '(no subject)'}
                </Link>
            }
            meta={
                <>
                    <Link
                        to={{ search: withOpen(context.search, { type: 'person', id: person.id }) }}
                        className={metaLinkClass}
                    >
                        {person.name}
                    </Link>
                    {person.company && <span>{person.company.name}</span>}
                    <span>{formatWhen(reply.receivedAt)}</span>
                </>
            }
            detail={reply.snippet}
            actions={<PersonButtons person={person} context={context} />}
        />
    );
}

function LeadRow({ lead, context }: { lead: TodayLeadView; context: RowContext }) {
    return (
        <Row
            icon={UserPlus}
            tone="bg-info-soft text-info"
            title={
                <Link to={{ search: withOpen(context.search, { type: 'person', id: lead.id }) }} className={linkClass}>
                    {lead.name}
                </Link>
            }
            meta={
                <>
                    {lead.company && <span>{lead.company.name}</span>}
                    {lead.source && <span>{lead.source}</span>}
                    <span>Added {formatWhen(lead.createdAt)}</span>
                </>
            }
            actions={<PersonButtons person={lead} context={context} />}
        />
    );
}

/** Tomorrow (or in a week) at 9 in the morning, on the reader's clock. */
function snoozeTo(days: number, now = new Date()): string {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9).toISOString();
}

function TaskRow({ task, context }: { task: MyTaskView; context: RowContext }) {
    const update = useUpdateMyTask(context.workspaceId);
    const canTask = useCan('task:write');
    const overdue = task.dueAt !== null && new Date(task.dueAt) < new Date(new Date().setHours(0, 0, 0, 0));
    const failed = (error: unknown) =>
        toast({ title: 'The task was not changed', description: failureText(error), tone: 'danger' });
    // Done and Snooze act at once and offer Undo from the toast: the task's status (or due time) is put back.
    const change = (patch: { status?: 'done'; dueAt?: string }, said: string) =>
        update.mutate(
            { taskId: task.id, ...patch },
            {
                onSuccess: () => {
                    context.done('tasks', task.id);
                    const before = patch.status ? { status: task.status } : { dueAt: task.dueAt };
                    toast({
                        title: said,
                        tone: 'success',
                        action: { label: 'Undo', onSelect: () => context.undoTask(task, before) },
                    });
                },
                onError: failed,
            },
        );
    return (
        <Row
            icon={overdue ? AlarmClock : CalendarClock}
            tone={overdue ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning'}
            title={task.title}
            meta={
                <>
                    {task.targets.map((t) => (
                        <Link
                            key={`${t.type}:${t.id}`}
                            to={{ search: withOpen(context.search, t) }}
                            className={metaLinkClass}
                        >
                            {t.label}
                        </Link>
                    ))}
                    {task.dueAt && (
                        <span className={overdue ? 'text-danger' : undefined}>Due {formatWhen(task.dueAt)}</span>
                    )}
                </>
            }
            actions={
                canTask ? (
                    <>
                        <DropdownMenu>
                            <WithTip label="Due later: tomorrow or next week">
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        aria-label={`Snooze: ${task.title}`}
                                        disabled={update.isPending}
                                    >
                                        <AlarmClock />
                                        Snooze
                                    </Button>
                                </DropdownMenuTrigger>
                            </WithTip>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
                                <DropdownMenuItem
                                    onSelect={() =>
                                        change({ dueAt: snoozeTo(1) }, `Snoozed to tomorrow: ${task.title}`)
                                    }
                                >
                                    Tomorrow, 9:00
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onSelect={() => change({ dueAt: snoozeTo(7) }, `Snoozed a week: ${task.title}`)}
                                >
                                    Next week, 9:00
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <WithTip label="Mark done — Undo from the notice">
                            <Button
                                variant="secondary"
                                size="sm"
                                aria-label={`Done: ${task.title}`}
                                disabled={update.isPending}
                                onClick={() => change({ status: 'done' }, `Done: ${task.title}`)}
                            >
                                <Check />
                                Done
                            </Button>
                        </WithTip>
                    </>
                ) : null
            }
        />
    );
}

function DealRow({
    deal,
    section,
    context,
}: {
    deal: TodayDealView;
    section: 'followUps' | 'stalled';
    context: RowContext;
}) {
    const due = section === 'followUps';
    const when = due
        ? deal.dueAt && `Due ${formatWhen(deal.dueAt)}`
        : deal.lastActivityAt && `Quiet since ${formatDay(deal.lastActivityAt)}`;
    return (
        <Row
            icon={due ? CalendarClock : Hourglass}
            tone={due ? 'bg-warning-soft text-warning' : 'bg-surface-raised text-text-muted'}
            title={
                <Link
                    to={{ search: withOpen(context.search, { type: 'opportunity', id: deal.id }) }}
                    className={linkClass}
                >
                    {deal.name}
                </Link>
            }
            meta={
                <>
                    <span>{deal.stage.name}</span>
                    {deal.amount && <span>{formatMoney(deal.amount)}</span>}
                    {deal.contact && (
                        <Link
                            to={{ search: withOpen(context.search, { type: 'person', id: deal.contact.id }) }}
                            className={metaLinkClass}
                        >
                            {deal.contact.name}
                        </Link>
                    )}
                    {when && <span className={due && deal.cadenceOverdue ? 'text-danger' : undefined}>{when}</span>}
                </>
            }
            actions={
                <>
                    {deal.contact && <PersonButtons person={deal.contact} dealId={deal.id} context={context} />}
                    {context.canWrite && <FollowUpButton deal={deal} section={section} context={context} />}
                    {context.canMove && <StageMenu deal={deal} context={context} />}
                </>
            }
        />
    );
}

function tomorrowDate(): string {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Next follow-up": a date, saved on the deal (which keeps its one follow-up task due that day). */
function FollowUpButton({
    deal,
    section,
    context,
}: {
    deal: TodayDealView;
    section: 'followUps' | 'stalled';
    context: RowContext;
}) {
    const patch = usePatchRecord(context.workspaceId, 'opportunity', deal.id);
    const [open, setOpen] = useState(false);
    const [date, setDate] = useState(tomorrowDate);
    const save = () =>
        patch.mutate(
            { nextFollowUpDate: date },
            {
                onSuccess: () => {
                    setOpen(false);
                    context.done(section, deal.id);
                    toast({ title: `Follow-up set for ${formatDay(date)}`, description: deal.name, tone: 'success' });
                },
                onError: (error) =>
                    toast({ title: 'The follow-up was not set', description: failureText(error), tone: 'danger' }),
            },
        );
    return (
        <Tooltip>
            <ResponsivePanel
                title="Next follow-up"
                open={open}
                onOpenChange={setOpen}
                widthClass="w-64"
                trigger={
                    <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Set next follow-up for ${deal.name}`}>
                            <CalendarPlus />
                        </Button>
                    </TooltipTrigger>
                }
                footer={
                    <Button variant="primary" size="sm" loading={patch.isPending} disabled={!date} onClick={save}>
                        Save
                    </Button>
                }
            >
                <label className="mb-1 block text-xs font-medium text-text" htmlFor={`follow-up-${deal.id}`}>
                    Next follow-up for {deal.name}
                </label>
                <Input
                    id={`follow-up-${deal.id}`}
                    type="date"
                    value={date}
                    min={tomorrowDate()}
                    onChange={(e) => setDate(e.target.value)}
                />
            </ResponsivePanel>
            <TooltipContent>Plan the next follow-up</TooltipContent>
        </Tooltip>
    );
}

/** "Move to…": the deal's pipeline's other stages, through the board's own move (close and backward moves ask first). */
function StageMenu({ deal, context }: { deal: TodayDealView; context: RowContext }) {
    const [open, setOpen] = useState(false);
    const pipeline = usePipeline(context.workspaceId, deal.pipelineId);
    // The full deal (amount, close fields) only once someone means to move it.
    const record = useRecord(context.workspaceId, 'opportunity', open ? deal.id : '');
    const move = useDealMove(context.workspaceId, pipeline.data);
    const stages = (pipeline.data?.stages ?? []).filter((s) => s.id !== deal.stage.id);
    return (
        <>
            <DropdownMenu open={open} onOpenChange={setOpen}>
                <WithTip label="Move to another stage">
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Move ${deal.name} to another stage`}>
                            <MoreHorizontal />
                        </Button>
                    </DropdownMenuTrigger>
                </WithTip>
                <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Move to</DropdownMenuLabel>
                    {stages.map((s) => (
                        <DropdownMenuItem
                            key={s.id}
                            disabled={!record.data || move.isMoving}
                            onSelect={() => {
                                if (!record.data) return;
                                move.request(record.data, s.id);
                            }}
                        >
                            {s.name}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
            {move.dialogs}
        </>
    );
}

/** The composer as a sheet over Today, opened as soon as it mounts. */
function EmailSheet({
    workspaceId,
    action,
    onSent,
}: {
    workspaceId: string;
    action: PersonAction;
    onSent: () => void;
}) {
    const handle = useRef<RecordComposeHandle>(null);
    useEffect(() => handle.current?.start(), []);
    const { person } = action;
    return (
        <RecordCompose
            workspaceId={workspaceId}
            person={{ id: person.id, name: person.name, email: person.email, source: person.source }}
            dealId={action.dealId}
            handle={handle}
            sheet
            onSent={onSent}
        />
    );
}
