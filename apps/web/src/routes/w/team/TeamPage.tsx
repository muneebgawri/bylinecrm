import {
    Badge,
    Button,
    DataTableChrome,
    DropdownMenuItem,
    EmptyState,
    KpiCard,
    LoadingRegion,
    PageHeader,
    SegmentedControl,
    Skeleton,
    toast,
} from '@bylinecrm/ui';
import { CalendarCheck, CalendarDays, CalendarPlus, UserPlus, UsersRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
    useAcceptSuggestion,
    useDismissSuggestion,
    useLeadSuggestions,
    useMeetingKpis,
    useMeetings,
} from '../../../api/meetings';
import { useMembersById } from '../../../api/records';
import type { LeadSuggestionView, MeetingKpiRowView, MeetingView } from '../../../api/types';
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
    // The bounds only change with the period: the query key stays put while the page is open.
    const bounds = useMemo(() => periodBounds(period), [period]);
    const kpis = useMeetingKpis(workspaceId, bounds);
    const list = useMeetings(workspaceId, bounds);
    if (kpis.isError) throw kpis.error;
    if (list.isError) throw list.error;

    const rows = kpis.data?.rows;
    const total = (key: keyof Omit<MeetingKpiRowView, 'member'>) => (rows ?? []).reduce((sum, r) => sum + r[key], 0);
    return (
        <div className="p-7 max-md:p-4">
            <PageHeader
                title="Team"
                subtitle={
                    admin
                        ? 'Meetings each member booked and held with people outside the workspace, from their Google Calendar.'
                        : 'Your meetings with people outside the workspace, from your Google Calendar.'
                }
                actions={
                    <SegmentedControl
                        aria-label="Period"
                        value={period}
                        onValueChange={(value) => setPeriod(value as Period)}
                        options={PERIODS}
                    />
                }
            />
            {rows ? (
                <div className="mb-5 grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
                    <KpiCard icon={<CalendarPlus />} label="Meetings booked" value={total('booked')} />
                    <KpiCard
                        icon={<CalendarCheck />}
                        tone="success"
                        label="Meetings held"
                        value={total('held')}
                        footnote={`${total('upcoming')} still to come`}
                    />
                    <KpiCard icon={<UsersRound />} tone="info" label="People met" value={total('peopleMet')} />
                    <KpiCard icon={<UserPlus />} tone="warning" label="New leads" value={total('newLeads')} />
                </div>
            ) : (
                <LoadingRegion label="Loading meeting KPIs" className="mb-5">
                    <Skeleton className="h-27" />
                </LoadingRegion>
            )}
            <h2 className="m-0 mb-2 text-sm font-semibold">{admin ? 'By member' : 'Your numbers'}</h2>
            <KpiTable workspaceId={workspaceId} rows={rows} />
            <h2 className="m-0 mt-6 mb-2 text-sm font-semibold">Suggested leads</h2>
            <SuggestionTable workspaceId={workspaceId} admin={admin} />
            <h2 className="m-0 mt-6 mb-2 text-sm font-semibold">Meetings</h2>
            <MeetingTable workspaceId={workspaceId} meetings={list.data?.items} />
        </div>
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
