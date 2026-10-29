import {
    Avatar,
    Badge,
    Button,
    Card,
    DataTableChrome,
    DropdownMenuItem,
    EmptyState,
    Input,
    LoadingRegion,
    PageHeader,
    Progress,
    SegmentedControl,
    Skeleton,
    cn,
    focusRing,
    toast,
} from '@bylinecrm/ui';
import {
    CalendarCheck,
    CalendarDays,
    Handshake,
    LayoutGrid,
    List,
    Mail,
    Search,
    SearchX,
    ShieldCheck,
    Trophy,
    UserPlus,
    UsersRound,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
    useAcceptSuggestion,
    useDismissSuggestion,
    useLeadSuggestions,
    useMeetingKpis,
    useMeetings,
} from '../../../api/meetings';
import { useDefaultBoard } from '../../../api/deals';
import { useMembersById } from '../../../api/records';
import { useMembers } from '../../../api/team';
import type { BoardView, LeadSuggestionView, MeetingKpiRowView, MeetingView, MemberView } from '../../../api/types';
import { formatMoneyCompact } from '../../../lib/money';
import { boardCurrency, count, open, sumOf, won } from '../reports/reportsData';
import { failureText } from '../../../lib/errors';
import { can, useMembership } from '../../../auth/capabilities';
import { formatDate, formatDay } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';

/** The periods the page offers; each is `[from, to)` in the reader's own time zone. */
const PERIODS = [
    { value: 'week', label: 'This week' },
    { value: 'month', label: 'This month' },
    { value: 'last-month', label: 'Last month' },
] as const;
type Period = (typeof PERIODS)[number]['value'];

/** The period's bounds, from the reader's calendar: a week starts on Monday. */
export function periodBounds(period: Period, now: Date = new Date()): { from: string; to: string } {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (period === 'week') {
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        return { from: start.toISOString(), to: end.toISOString() };
    }
    const month = period === 'month' ? now.getMonth() : now.getMonth() - 1;
    return {
        from: new Date(now.getFullYear(), month, 1).toISOString(),
        to: new Date(now.getFullYear(), month + 1, 1).toISOString(),
    };
}

/**
 * The team's meetings (CAL-1): what each member booked and held with people outside the workspace —
 * read from their Google Calendars — and the leads those meetings brought in. An admin sees every
 * member; anyone else sees their own row and meetings (the API decides).
 */
export function TeamPage() {
    const workspaceId = useWorkspaceId();
    const membership = useMembership();
    const admin = can(membership, 'workspace:admin');
    const [period, setPeriod] = useState<Period>('week');
    const [q, setQ] = useState('');
    const [view, setView] = useState<'grid' | 'list'>('grid');
    // The bounds only change with the period: the query key stays put while the page is open.
    const bounds = useMemo(() => periodBounds(period), [period]);
    const kpis = useMeetingKpis(workspaceId, bounds);
    const list = useMeetings(workspaceId, bounds);
    const members = useMembers(workspaceId);
    const { board } = useDefaultBoard(workspaceId);
    if (kpis.isError) throw kpis.error;
    if (list.isError) throw list.error;

    const rows = kpis.data?.rows;
    const total = (key: keyof Omit<MeetingKpiRowView, 'member'>) => (rows ?? []).reduce((sum, r) => sum + r[key], 0);
    const byOwner = useMemo(() => dealsByOwner(board.data), [board.data]);
    const currency = boardCurrency(board.data);
    const term = q.trim().toLowerCase();
    const cards = (members.data ?? []).filter(
        (m) => !term || (m.displayName ?? '').toLowerCase().includes(term) || m.email.toLowerCase().includes(term),
    );
    const signedIn = (members.data ?? []).filter((m) => m.hasSignedIn).length;

    return (
        <div className="flex flex-col gap-4 p-4 md:p-6">
            <PageHeader
                className="mb-0"
                title="Team"
                chip={
                    members.data && (
                        <span className="rounded-full bg-surface-raised px-2.5 py-0.5 text-xs font-medium text-text-muted">
                            {members.data.length} {members.data.length === 1 ? 'member' : 'members'}
                        </span>
                    )
                }
                subtitle={
                    admin
                        ? 'Your team, their deals, and the meetings they booked and held with people outside the workspace.'
                        : 'Your team, and your meetings with people outside the workspace, from your Google Calendar.'
                }
                actions={
                    admin && (
                        <Button asChild variant="primary" data-primary-action>
                            <Link to={paths.settingsInvites(workspaceId)}>
                                <UserPlus aria-hidden /> Invite member
                            </Link>
                        </Button>
                    )
                }
            />
            {rows && members.data ? (
                <div className="grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
                    <TeamStat
                        icon={<UsersRound />}
                        label="Team members"
                        value={members.data.length}
                        note={`${signedIn} signed in · ${members.data.length - signedIn} invited`}
                    />
                    <TeamStat
                        icon={<Handshake />}
                        label="Open deals"
                        value={count(open(board.data))}
                        note="across the whole team"
                    />
                    <TeamStat
                        icon={<Trophy />}
                        label="Deals won"
                        value={count(won(board.data))}
                        note={`${formatMoneyCompact(sumOf(won(board.data), currency))} closed`}
                    />
                    <TeamStat
                        icon={<CalendarCheck />}
                        label="Meetings held"
                        value={total('held')}
                        note={`${total('booked')} booked · ${total('upcoming')} to come`}
                    />
                </div>
            ) : (
                <LoadingRegion
                    label="Loading team KPIs"
                    className="grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1"
                >
                    <Skeleton className="h-27" />
                    <Skeleton className="h-27" />
                    <Skeleton className="h-27" />
                    <Skeleton className="h-27" />
                </LoadingRegion>
            )}
            <div className="flex flex-wrap items-center gap-3 border-b border-border pb-4">
                <label className="relative block w-full max-w-96">
                    <Search
                        aria-hidden
                        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-faint"
                    />
                    <Input
                        aria-label="Search members"
                        placeholder="Search by name or email…"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        className="pl-9"
                    />
                </label>
                <SegmentedControl
                    aria-label="Period"
                    value={period}
                    onValueChange={(value) => setPeriod(value as Period)}
                    options={PERIODS}
                />
                <div className="ml-auto flex rounded-lg bg-surface-raised p-[3px]" role="group" aria-label="Layout">
                    {(
                        [
                            ['grid', LayoutGrid, 'Cards'],
                            ['list', List, 'Table'],
                        ] as const
                    ).map(([id, Icon, label]) => (
                        <button
                            key={id}
                            type="button"
                            aria-pressed={view === id}
                            aria-label={label}
                            onClick={() => setView(id)}
                            className={cn(
                                'grid size-8 place-items-center rounded-md text-text-muted transition-colors hover:text-text',
                                view === id && 'bg-surface text-text shadow-sm',
                                focusRing,
                            )}
                        >
                            <Icon aria-hidden className="size-4" />
                        </button>
                    ))}
                </div>
            </div>
            {view === 'grid' ? (
                !members.data ? (
                    <LoadingRegion
                        label="Loading members"
                        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
                    >
                        <Skeleton className="h-72" />
                        <Skeleton className="h-72" />
                        <Skeleton className="h-72" />
                    </LoadingRegion>
                ) : cards.length === 0 ? (
                    <EmptyState
                        icon={<SearchX />}
                        title="No team members found"
                        body="Try a different search."
                        action={
                            <Button variant="secondary" size="sm" onClick={() => setQ('')}>
                                Clear search
                            </Button>
                        }
                    />
                ) : (
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                        {cards.map((m) => (
                            <MemberCard
                                key={m.id}
                                member={m}
                                you={m.id === membership?.memberId}
                                deals={byOwner.get(m.id)}
                                currency={currency}
                                meetings={rows?.find((r) => r.member.memberId === m.id)}
                            />
                        ))}
                    </div>
                )
            ) : (
                <KpiTable workspaceId={workspaceId} rows={rows} />
            )}
            <h2 className="m-0 mt-2 mb-0 text-sm font-semibold">Suggested leads</h2>
            <SuggestionTable workspaceId={workspaceId} admin={admin} />
            <h2 className="m-0 mt-2 mb-0 text-sm font-semibold">Meetings</h2>
            <MeetingTable workspaceId={workspaceId} meetings={list.data?.items} />
        </div>
    );
}

function TeamStat({ icon, label, value, note }: { icon: ReactNode; label: string; value: number; note: string }) {
    return (
        <Card className="flex-row items-start gap-4 px-5 py-5">
            <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-surface-raised text-text-muted [&_svg]:size-5">
                {icon}
            </span>
            <div className="min-w-0">
                <div className="text-sm text-text-muted">{label}</div>
                <div className="text-2xl font-semibold tracking-tight tabular-nums">{value.toLocaleString()}</div>
                <div className="mt-0.5 truncate text-xs text-text-muted">{note}</div>
            </div>
        </Card>
    );
}

interface OwnerDeals {
    open: number;
    won: number;
    revenueMinor: number;
}

/** Open and won deals, and won value, per owner, from the deals the board loaded. */
function dealsByOwner(board: BoardView | undefined): Map<string, OwnerDeals> {
    const map = new Map<string, OwnerDeals>();
    for (const column of board?.columns ?? []) {
        if (column.stage.kind === 'lost') continue;
        for (const deal of column.deals) {
            if (!deal.owner) continue;
            const row = map.get(deal.owner.memberId) ?? { open: 0, won: 0, revenueMinor: 0 };
            if (column.stage.kind === 'open') row.open += 1;
            else {
                row.won += 1;
                row.revenueMinor += deal.amount?.amountMinor ?? 0;
            }
            map.set(deal.owner.memberId, row);
        }
    }
    return map;
}

/** One member: who they are, their role and whether they have signed in, their deals and meetings. */
function MemberCard({
    member,
    you,
    deals,
    currency,
    meetings,
}: {
    member: MemberView;
    you: boolean;
    deals: OwnerDeals | undefined;
    currency: string;
    meetings: MeetingKpiRowView | undefined;
}) {
    const name = member.displayName ?? member.email;
    const held = meetings?.held ?? 0;
    const booked = meetings?.booked ?? 0;
    const attainment = booked ? Math.round((held / booked) * 100) : 0;
    return (
        <Card className="gap-0 py-0">
            <div className="flex items-start gap-3 p-5 pb-4">
                <span className="relative">
                    <Avatar name={name} size="lg" className="size-12 text-base" />
                    <span
                        aria-hidden
                        className={cn(
                            'absolute right-0 bottom-0 size-3 rounded-full ring-2 ring-surface',
                            member.hasSignedIn ? 'bg-success' : 'bg-warning',
                        )}
                    />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="truncate text-base font-semibold">{name}</span>
                        {you && (
                            <span className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[11px] font-medium text-text-muted">
                                You
                            </span>
                        )}
                    </div>
                    <div className="truncate text-sm text-text-muted">{member.roleName}</div>
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 px-5 pb-4">
                <Badge className="gap-1.5">
                    <ShieldCheck aria-hidden className="size-3 text-text-muted" />
                    {member.roleName}
                </Badge>
                <Badge dot shape="pill" status={member.hasSignedIn ? 'success' : 'warning'}>
                    {member.hasSignedIn ? 'Active' : 'Invited'}
                </Badge>
            </div>
            <div className="flex flex-col gap-1.5 px-5 pb-4 text-sm text-text-muted">
                <span className="flex items-center gap-2 truncate">
                    <Mail aria-hidden className="size-4 shrink-0" />
                    <span className="truncate">{member.email}</span>
                </span>
            </div>
            <div className="mx-5 grid grid-cols-3 rounded-lg bg-surface-raised px-3 py-3 text-center">
                <div>
                    <div className="text-lg font-semibold tabular-nums">{deals?.open ?? 0}</div>
                    <div className="text-xs text-text-muted">Open</div>
                </div>
                <div>
                    <div className="text-lg font-semibold tabular-nums">{deals?.won ?? 0}</div>
                    <div className="text-xs text-text-muted">Won</div>
                </div>
                <div>
                    <div className="text-lg font-semibold tabular-nums">
                        {formatMoneyCompact({ amountMinor: deals?.revenueMinor ?? 0, currency })}
                    </div>
                    <div className="text-xs text-text-muted">Revenue</div>
                </div>
            </div>
            <div className="px-5 pt-4 pb-4">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="text-text-muted">Meetings held</span>
                    <span className={cn('font-medium', attainment >= 70 ? 'text-success' : 'text-warning')}>
                        {held} of {booked}
                    </span>
                </div>
                <Progress
                    value={attainment}
                    tone={attainment >= 70 ? 'success' : 'warning'}
                    label="Meetings held of those booked"
                />
            </div>
            <div className="flex items-center justify-between border-t border-border px-5 py-3 text-xs text-text-muted">
                <span>Joined {formatDay(member.createdAt)}</span>
                <span>{member.hasSignedIn ? 'Signed in' : 'Not yet signed in'}</span>
            </div>
        </Card>
    );
}

function KpiTable({ workspaceId, rows }: { workspaceId: string; rows: MeetingKpiRowView[] | undefined }) {
    const membership = useMembership();
    const count = (key: keyof Omit<MeetingKpiRowView, 'member'>) => (r: MeetingKpiRowView) => (
        <span className="tabular-nums">{r[key]}</span>
    );
    return (
        <DataTableChrome
            data={{
                label: 'Meeting KPIs by member',
                loading: rows === undefined,
                rows: rows ?? [],
                getRowId: (r) => r.member.memberId,
                empty: <EmptyState className="m-4" title="No members" body="Nobody was in the workspace then." />,
                columns: [
                    {
                        id: 'member',
                        header: 'Member',
                        phone: 'primary',
                        cell: (r) => (
                            <span className="font-medium">
                                {r.member.memberId === membership?.memberId
                                    ? 'You'
                                    : (r.member.name ?? 'Unnamed member')}
                                {r.member.leftAt && <span className="text-text-muted"> · left</span>}
                            </span>
                        ),
                    },
                    { id: 'booked', header: 'Booked', phone: 'secondary', cell: count('booked') },
                    {
                        id: 'slotline',
                        header: 'Via Slotline',
                        phone: 'meta',
                        muted: true,
                        cell: count('bookedViaSlotline'),
                    },
                    { id: 'held', header: 'Held', phone: 'secondary', cell: count('held') },
                    { id: 'upcoming', header: 'To come', phone: 'meta', muted: true, cell: count('upcoming') },
                    { id: 'cancelled', header: 'Cancelled', phone: 'meta', muted: true, cell: count('cancelled') },
                    { id: 'people', header: 'People met', phone: 'meta', cell: count('peopleMet') },
                    { id: 'leads', header: 'New leads', phone: 'meta', cell: count('newLeads') },
                    {
                        id: 'awaiting',
                        header: 'Awaiting customer',
                        phone: 'meta',
                        muted: true,
                        cell: count('awaitingCustomer'),
                    },
                ],
            }}
            footer={
                <p className="m-0 px-4 py-3 text-xs text-text-muted">
                    A meeting counts for a member once one of the people outside it is in the CRM and theirs — awaiting
                    customer are the meetings that do not count yet. Booked counts a meeting once, for whoever organised
                    it — in their Google Calendar or as a booking on Slotline. Held and to come count it once for every
                    member it counts for, even when both their calendar and Slotline hold it. A member’s calendar is
                    read once they connect it on{' '}
                    <Link className="text-accent underline" to={paths.mailboxes(workspaceId)}>
                        Mailboxes
                    </Link>
                    .
                </p>
            }
        />
    );
}

function MeetingTable({ workspaceId, meetings }: { workspaceId: string; meetings: MeetingView[] | undefined }) {
    const names = useMembersById(workspaceId);
    const membership = useMembership();
    const memberName = (id: string) => (id === membership?.memberId ? 'You' : (names.get(id) ?? 'A member'));
    return (
        <DataTableChrome
            data={{
                label: 'Meetings',
                loading: meetings === undefined,
                rows: meetings ?? [],
                getRowId: (m) => m.id,
                leading: () => <CalendarDays aria-hidden className="size-4 text-text-muted" />,
                empty: (
                    <EmptyState
                        className="m-4"
                        icon={<CalendarDays />}
                        title="No meetings in this period"
                        body="Meetings with people outside the workspace appear here once members connect their Google Calendar."
                        action={
                            <Button asChild variant="secondary">
                                <Link to={paths.mailboxes(workspaceId)}>Connect a calendar</Link>
                            </Button>
                        }
                    />
                ),
                columns: [
                    {
                        id: 'meeting',
                        header: 'Meeting',
                        phone: 'primary',
                        cell: (m) => (
                            <span>
                                <span className="font-medium">{m.title || 'Untitled meeting'}</span>
                                {m.bookedVia === 'slotline' && (
                                    <>
                                        {' '}
                                        {m.slotlineUrl ? (
                                            <a
                                                className="text-xs text-accent underline max-md:inline-flex max-md:min-h-touch max-md:min-w-touch max-md:items-center"
                                                href={m.slotlineUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                            >
                                                Slotline
                                            </a>
                                        ) : (
                                            <Badge status="neutral" shape="pill">
                                                Slotline
                                            </Badge>
                                        )}
                                    </>
                                )}
                            </span>
                        ),
                    },
                    {
                        id: 'when',
                        header: 'When',
                        phone: 'secondary',
                        muted: true,
                        cell: (m) => (m.allDay ? formatDay(m.startsAt) : formatDate(m.startsAt)),
                    },
                    { id: 'host', header: 'Booked by', phone: 'secondary', cell: (m) => memberName(m.hostMemberId) },
                    {
                        id: 'with',
                        header: 'With',
                        phone: 'meta',
                        cell: (m) => <MeetingPeople workspaceId={workspaceId} meeting={m} />,
                    },
                    {
                        id: 'status',
                        header: 'Status',
                        phone: 'meta',
                        cell: (m) =>
                            m.status === 'cancelled' ? (
                                <Badge status="neutral">Cancelled</Badge>
                            ) : m.countsFor.length === 0 ? (
                                // Counts once a person outside it is the member's: added from a suggestion, or assigned.
                                <Badge
                                    status="warning"
                                    title="None of the people outside it is a member’s customer yet"
                                >
                                    Not counted
                                </Badge>
                            ) : new Date(m.startsAt).getTime() > Date.now() ? (
                                <Badge status="info">To come</Badge>
                            ) : (
                                <Badge status="success">Held</Badge>
                            ),
                    },
                ],
            }}
        />
    );
}

/** The people outside the workspace a meeting was with, each a link to their record; a new lead is marked. */
function MeetingPeople({ workspaceId, meeting }: { workspaceId: string; meeting: MeetingView }) {
    const people = meeting.attendees.filter((a) => a.memberId === null && a.personId !== null);
    if (people.length === 0) return <span className="text-text-muted">—</span>;
    return (
        <span className="flex flex-wrap gap-x-2 gap-y-1">
            {people.map((a) => (
                <span key={a.address}>
                    <Link
                        className="text-accent underline max-md:inline-flex max-md:min-h-touch max-md:min-w-touch max-md:items-center"
                        to={paths.person(workspaceId, a.personId!)}
                    >
                        {a.displayName || a.address}
                    </Link>
                    {a.leadCreated && (
                        <>
                            {' '}
                            <Badge status="accent" shape="pill">
                                New lead
                            </Badge>
                        </>
                    )}
                </span>
            ))}
        </span>
    );
}

/**
 * Meeting attendees suggested as leads (CAL-3): people sync did not add on its own — the member was invited by
 * someone outside, or they are at a free-mail domain. Adding one makes them the member's, and their meetings
 * count; "Not a lead" dismisses them for good.
 */
function SuggestionTable({ workspaceId, admin }: { workspaceId: string; admin: boolean }) {
    const suggestions = useLeadSuggestions(workspaceId);
    const accept = useAcceptSuggestion(workspaceId);
    const dismiss = useDismissSuggestion(workspaceId);
    const names = useMembersById(workspaceId);
    const membership = useMembership();
    if (suggestions.isError) throw suggestions.error;
    const decide = (s: LeadSuggestionView, add: boolean) => {
        const input = { address: s.address, ...(s.memberId !== membership?.memberId ? { memberId: s.memberId } : {}) };
        const name = s.displayName || s.address;
        const options = {
            onSuccess: () => toast({ title: add ? `${name} added as a lead` : `${name} will not be suggested again` }),
            onError: (e: unknown) =>
                toast({ title: 'That did not work', description: failureText(e), tone: 'danger' as const }),
        };
        if (add) accept.mutate(input, options);
        else dismiss.mutate(input, options);
    };
    return (
        <DataTableChrome
            data={{
                label: 'Suggested leads',
                loading: suggestions.data === undefined,
                rows: suggestions.data ?? [],
                getRowId: (s) => `${s.memberId}:${s.address}`,
                empty: (
                    <EmptyState
                        className="m-4"
                        title="No suggestions"
                        body="People from meetings who may or may not be leads appear here to add or dismiss."
                    />
                ),
                columns: [
                    {
                        id: 'person',
                        header: 'Person',
                        phone: 'primary',
                        cell: (s) => (
                            <span>
                                <span className="font-medium">{s.displayName || s.address}</span>
                                {s.displayName && <span className="text-text-muted"> · {s.address}</span>}
                            </span>
                        ),
                    },
                    {
                        id: 'meetings',
                        header: 'Meetings',
                        phone: 'secondary',
                        muted: true,
                        cell: (s) => s.meetings.map((m) => m.title || 'Untitled meeting').join(', '),
                    },
                    ...(admin
                        ? [
                              {
                                  id: 'for',
                                  header: 'For',
                                  phone: 'secondary' as const,
                                  cell: (s: LeadSuggestionView) =>
                                      s.memberId === membership?.memberId
                                          ? 'You'
                                          : (names.get(s.memberId) ?? 'A member'),
                              },
                          ]
                        : []),
                ],
                rowActions: {
                    label: (s) => s.displayName || s.address,
                    items: (s) => (
                        <>
                            <DropdownMenuItem onSelect={() => decide(s, true)}>Add as lead</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => decide(s, false)}>Not a lead</DropdownMenuItem>
                        </>
                    ),
                },
            }}
        />
    );
}
