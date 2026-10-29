import {
    Button,
    Checkbox,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Input,
    PageHeader,
    Tabs,
    TabsList,
    TabsTrigger,
    cn,
    focusRing,
} from '@bylinecrm/ui';
import { useQuery } from '@tanstack/react-query';
import { CalendarX2, ChevronLeft, ChevronRight, ExternalLink, Link2, MapPin, Search, Video } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useDefaultBoard } from '../../../api/deals';
import { meetings as meetingsApi } from '../../../api/meetings';
import { useMyTasks } from '../../../api/notifications';
import { keys } from '../../../api/queries';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { recordPath } from '../records/targets';
import {
    CALENDAR_VIEWS,
    EVENT_TYPES,
    EVENT_TYPE_CONFIG,
    addDays,
    eventsOn,
    formatTime,
    fromDeals,
    fromMeetings,
    fromTasks,
    isSameDay,
    isSameMonth,
    monthGrid,
    rangeFor,
    startOfDay,
    weekDays,
    whenLabel,
    type CalendarEvent,
    type CalendarView,
    type EventType,
} from './calendarData';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 14 }, (_, i) => 7 + i);
const HOUR_PX = 56;

/**
 * The calendar: meetings from members' calendars, the member's own tasks by due time, and deals
 * by their expected close date, on a month, week, day or agenda view. There is no "new event":
 * meetings come from Google Calendar and Slotline, tasks from the records they are about.
 */
export function CalendarPage() {
    const workspaceId = useWorkspaceId();
    const [view, setView] = useState<CalendarView>('month');
    const [date, setDate] = useState(() => startOfDay(new Date()));
    const [search, setSearch] = useState('');
    const [active, setActive] = useState<EventType[]>([...EVENT_TYPES]);
    const [selected, setSelected] = useState<CalendarEvent | null>(null);
    const now = new Date();
    const range = useMemo(() => rangeFor(view, date), [view, date]);
    const bounds = useMemo(() => ({ from: range.from.toISOString(), to: range.to.toISOString() }), [range]);

    const meetings = useQuery({
        queryKey: [...keys.meetingList(workspaceId, bounds), 'calendar'] as const,
        queryFn: ({ signal }) => meetingsApi.list(workspaceId, { ...bounds, limit: 100 }, signal),
    });
    const tasks = useMyTasks(workspaceId);
    const { board } = useDefaultBoard(workspaceId);

    const all = useMemo<CalendarEvent[]>(
        () => [
            ...fromMeetings(meetings.data?.items ?? []),
            ...fromTasks(tasks.data ?? [], (t) => (t.targets[0] ? recordPath(workspaceId, t.targets[0]) : undefined)),
            ...fromDeals(
                (board.data?.columns ?? []).flatMap((c) => c.deals),
                (d) => paths.deal(workspaceId, d.id),
            ),
        ],
        [meetings.data, tasks.data, board.data, workspaceId],
    );
    const inRange = all.filter((e) => e.start < range.to && e.end > range.from);
    const typeCounts = Object.fromEntries(
        EVENT_TYPES.map((t) => [t, inRange.filter((e) => e.type === t).length]),
    ) as Record<EventType, number>;
    const term = search.trim().toLowerCase();
    const visible = inRange.filter((e) => active.includes(e.type) && (!term || e.title.toLowerCase().includes(term)));
    const upcoming = all
        .filter((e) => e.end >= now && active.includes(e.type))
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .slice(0, 6);

    const move = (dir: 1 | -1) => {
        if (view === 'day') setDate(addDays(date, dir));
        else if (view === 'week') setDate(addDays(date, 7 * dir));
        else setDate(new Date(date.getFullYear(), date.getMonth() + dir, 1));
    };
    const label =
        view === 'day'
            ? date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
            : view === 'week'
              ? `${weekDays(date)[0]!.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${weekDays(date)[6]!.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
              : date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    return (
        <div className="flex min-h-full flex-col gap-4 p-4 md:p-6">
            <PageHeader
                className="mb-0"
                title="Calendar"
                subtitle="Meetings, follow-up tasks and expected close dates, in one place."
                actions={
                    <Button asChild variant="secondary">
                        <Link to={paths.mailboxes(workspaceId)}>
                            <Link2 aria-hidden /> Connect a calendar
                        </Link>
                    </Button>
                }
            />
            <div className="flex min-h-0 flex-1 gap-4">
                <aside className="hidden w-72 shrink-0 flex-col gap-4 xl:flex">
                    <MiniMonth date={date} now={now} events={all} onPick={(d) => setDate(d)} />
                    <div className="rounded-xl border border-border bg-surface p-3">
                        <h3 className="m-0 mb-2 px-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
                            Event types
                        </h3>
                        <div className="space-y-0.5">
                            {EVENT_TYPES.map((t) => {
                                const c = EVENT_TYPE_CONFIG[t];
                                const on = active.includes(t);
                                return (
                                    <label
                                        key={t}
                                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-surface-raised"
                                    >
                                        <Checkbox
                                            checked={on}
                                            onCheckedChange={() =>
                                                setActive((a) => (on ? a.filter((x) => x !== t) : [...a, t]))
                                            }
                                        />
                                        <span aria-hidden className={cn('size-2.5 rounded-full', c.dot)} />
                                        <span className="flex-1">{c.label}</span>
                                        <span className="text-xs text-text-muted tabular-nums">{typeCounts[t]}</span>
                                    </label>
                                );
                            })}
                        </div>
                    </div>
                    <div className="rounded-xl border border-border bg-surface p-3">
                        <h3 className="m-0 mb-2 px-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
                            Upcoming
                        </h3>
                        {upcoming.length === 0 ? (
                            <p className="m-0 px-2 py-3 text-sm text-text-muted">Nothing coming up.</p>
                        ) : (
                            <div className="space-y-1">
                                {upcoming.map((e) => (
                                    <button
                                        key={e.id}
                                        type="button"
                                        onClick={() => setSelected(e)}
                                        className={cn(
                                            'flex w-full items-stretch gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-raised',
                                            focusRing,
                                        )}
                                    >
                                        <span
                                            aria-hidden
                                            className={cn('w-1 shrink-0 rounded-full', EVENT_TYPE_CONFIG[e.type].bar)}
                                        />
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm font-medium">{e.title}</span>
                                            <span className="block text-xs text-text-muted">{whenLabel(e)}</span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </aside>

                <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                            <Button variant="secondary" onClick={() => setDate(startOfDay(new Date()))}>
                                Today
                            </Button>
                            <div className="flex items-center">
                                <Button
                                    variant="secondary"
                                    size="icon"
                                    className="rounded-r-none"
                                    aria-label="Previous"
                                    onClick={() => move(-1)}
                                >
                                    <ChevronLeft aria-hidden />
                                </Button>
                                <Button
                                    variant="secondary"
                                    size="icon"
                                    className="-ml-px rounded-l-none"
                                    aria-label="Next"
                                    onClick={() => move(1)}
                                >
                                    <ChevronRight aria-hidden />
                                </Button>
                            </div>
                            <h2 className="m-0 ml-1 text-lg font-semibold tracking-tight">{label}</h2>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <label className="relative block w-full sm:w-56">
                                <Search
                                    aria-hidden
                                    className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-faint"
                                />
                                <Input
                                    aria-label="Search events"
                                    placeholder="Search events…"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    className="pl-9"
                                />
                            </label>
                            <Tabs value={view} onValueChange={(v) => setView(v as CalendarView)}>
                                <TabsList variant="pill" aria-label="View">
                                    {CALENDAR_VIEWS.map((v) => (
                                        <TabsTrigger key={v.value} value={v.value} className="text-xs">
                                            {v.label}
                                        </TabsTrigger>
                                    ))}
                                </TabsList>
                            </Tabs>
                        </div>
                    </div>

                    <div className="flex min-h-[680px] flex-col overflow-hidden rounded-xl border border-border bg-surface">
                        {view === 'month' && (
                            <MonthView
                                date={date}
                                now={now}
                                events={visible}
                                onOpen={setSelected}
                                onShowDay={(d) => {
                                    setDate(d);
                                    setView('day');
                                }}
                            />
                        )}
                        {(view === 'week' || view === 'day') && (
                            <TimeGrid
                                days={view === 'week' ? weekDays(date) : [date]}
                                now={now}
                                events={visible}
                                onOpen={setSelected}
                            />
                        )}
                        {view === 'agenda' && (
                            <AgendaView date={date} now={now} events={visible} onOpen={setSelected} />
                        )}
                    </div>
                </div>
            </div>

            <EventDialog event={selected} onClose={() => setSelected(null)} />
        </div>
    );
}

function MiniMonth({
    date,
    now,
    events,
    onPick,
}: {
    date: Date;
    now: Date;
    events: readonly CalendarEvent[];
    onPick: (d: Date) => void;
}) {
    const [shown, setShown] = useState(new Date(date.getFullYear(), date.getMonth(), 1));
    const days = monthGrid(shown);
    const has = (d: Date) => events.some((e) => isSameDay(e.start, d));
    return (
        <div className="rounded-xl border border-border bg-surface p-3">
            <div className="mb-2 flex items-center justify-between px-1">
                <button
                    type="button"
                    aria-label="Previous month"
                    onClick={() => setShown(new Date(shown.getFullYear(), shown.getMonth() - 1, 1))}
                    className={cn(
                        'grid size-7 place-items-center rounded-md text-text-muted hover:bg-surface-raised',
                        focusRing,
                    )}
                >
                    <ChevronLeft aria-hidden className="size-4" />
                </button>
                <span className="text-sm font-medium">
                    {shown.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                </span>
                <button
                    type="button"
                    aria-label="Next month"
                    onClick={() => setShown(new Date(shown.getFullYear(), shown.getMonth() + 1, 1))}
                    className={cn(
                        'grid size-7 place-items-center rounded-md text-text-muted hover:bg-surface-raised',
                        focusRing,
                    )}
                >
                    <ChevronRight aria-hidden className="size-4" />
                </button>
            </div>
            <div className="grid grid-cols-7 text-center text-[11px] text-text-muted">
                {WEEKDAYS.map((d) => (
                    <span key={d} className="py-1">
                        {d.slice(0, 2)}
                    </span>
                ))}
            </div>
            <div className="grid grid-cols-7">
                {days.map((d) => {
                    const today = isSameDay(d, now);
                    const picked = isSameDay(d, date);
                    return (
                        <button
                            key={d.toISOString()}
                            type="button"
                            onClick={() => onPick(d)}
                            aria-label={d.toDateString()}
                            aria-pressed={picked}
                            className={cn(
                                'mx-auto my-0.5 grid size-8 place-items-center rounded-md text-sm tabular-nums hover:bg-surface-raised',
                                !isSameMonth(d, shown) && 'text-text-faint',
                                has(d) && 'font-semibold',
                                today && 'ring-1 ring-border-strong',
                                picked && 'bg-primary text-primary-foreground hover:bg-primary',
                                focusRing,
                            )}
                        >
                            {d.getDate()}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function Chip({ event, onOpen }: { event: CalendarEvent; onOpen: (e: CalendarEvent) => void }) {
    const c = EVENT_TYPE_CONFIG[event.type];
    return (
        <button
            type="button"
            onClick={() => onOpen(event)}
            className={cn(
                'flex w-full items-center gap-1.5 truncate rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium',
                c.chip,
                focusRing,
            )}
        >
            <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', c.dot)} />
            {!event.allDay && <span className="shrink-0 tabular-nums">{formatTime(event.start)}</span>}
            <span className="truncate">{event.title}</span>
        </button>
    );
}

function MonthView({
    date,
    now,
    events,
    onOpen,
    onShowDay,
}: {
    date: Date;
    now: Date;
    events: readonly CalendarEvent[];
    onOpen: (e: CalendarEvent) => void;
    onShowDay: (d: Date) => void;
}) {
    const days = monthGrid(date);
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="grid grid-cols-7 border-b border-border bg-surface-raised/40">
                {WEEKDAYS.map((d) => (
                    <div key={d} className="px-2 py-2 text-xs font-medium text-text-muted">
                        {d}
                    </div>
                ))}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
                {days.map((day) => {
                    const list = eventsOn(events, day);
                    const shown = list.slice(0, 3);
                    const hidden = list.length - shown.length;
                    const today = isSameDay(day, now);
                    return (
                        <div
                            key={day.toISOString()}
                            className={cn(
                                'flex min-h-0 flex-col gap-1 overflow-hidden border-r border-b border-border p-1.5 [&:nth-child(7n)]:border-r-0 [&:nth-last-child(-n+7)]:border-b-0',
                                !isSameMonth(day, date) && 'bg-surface-raised/30 text-text-muted',
                            )}
                        >
                            <button
                                type="button"
                                onClick={() => onShowDay(day)}
                                className={cn(
                                    'grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium',
                                    today ? 'bg-primary text-primary-foreground' : 'hover:bg-surface-raised',
                                    focusRing,
                                )}
                            >
                                {day.getDate()}
                            </button>
                            <div className="flex flex-col gap-0.5">
                                {shown.map((e) => (
                                    <Chip key={e.id} event={e} onOpen={onOpen} />
                                ))}
                            </div>
                            {hidden > 0 && (
                                <button
                                    type="button"
                                    onClick={() => onShowDay(day)}
                                    className="px-1.5 text-left text-[11px] font-medium text-text-muted hover:text-text"
                                >
                                    +{hidden} more
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function TimeGrid({
    days,
    now,
    events,
    onOpen,
}: {
    days: Date[];
    now: Date;
    events: readonly CalendarEvent[];
    onOpen: (e: CalendarEvent) => void;
}) {
    const top = (d: Date) => ((d.getHours() + d.getMinutes() / 60 - HOURS[0]!) / HOURS.length) * 100;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div
                className="grid border-b border-border"
                style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0,1fr))` }}
            >
                <div />
                {days.map((d) => (
                    <div key={d.toISOString()} className="border-l border-border px-2 py-2 text-xs">
                        <span className="text-text-muted">{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>{' '}
                        <span
                            className={cn(
                                'inline-grid size-6 place-items-center rounded-full font-medium',
                                isSameDay(d, now) && 'bg-primary text-primary-foreground',
                            )}
                        >
                            {d.getDate()}
                        </span>
                    </div>
                ))}
            </div>
            <div
                className="grid border-b border-border"
                style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0,1fr))` }}
            >
                <div className="px-2 py-1 text-[11px] text-text-muted">all day</div>
                {days.map((d) => (
                    <div key={d.toISOString()} className="flex min-h-7 flex-col gap-0.5 border-l border-border p-1">
                        {eventsOn(events, d)
                            .filter((e) => e.allDay)
                            .map((e) => (
                                <Chip key={e.id} event={e} onOpen={onOpen} />
                            ))}
                    </div>
                ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                <div
                    className="grid"
                    style={{
                        gridTemplateColumns: `56px repeat(${days.length}, minmax(0,1fr))`,
                        height: HOURS.length * HOUR_PX,
                    }}
                >
                    <div className="relative">
                        {HOURS.map((h, i) => (
                            <span
                                key={h}
                                className="absolute right-2 -translate-y-1/2 text-[11px] text-text-muted tabular-nums"
                                style={{ top: i * HOUR_PX }}
                            >
                                {new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}
                            </span>
                        ))}
                    </div>
                    {days.map((d) => (
                        <div key={d.toISOString()} className="relative border-l border-border">
                            {HOURS.map((h, i) => (
                                <span
                                    key={h}
                                    aria-hidden
                                    className="absolute inset-x-0 border-t border-border"
                                    style={{ top: i * HOUR_PX }}
                                />
                            ))}
                            {eventsOn(events, d)
                                .filter((e) => !e.allDay)
                                .map((e) => {
                                    const c = EVENT_TYPE_CONFIG[e.type];
                                    const start = Math.max(top(e.start), 0);
                                    const end = Math.min(top(e.end), 100);
                                    return (
                                        <button
                                            key={e.id}
                                            type="button"
                                            onClick={() => onOpen(e)}
                                            className={cn(
                                                'absolute inset-x-1 overflow-hidden rounded-md border-l-2 px-1.5 py-1 text-left text-[11px] leading-tight',
                                                c.chip,
                                                focusRing,
                                            )}
                                            style={{
                                                top: `${start}%`,
                                                height: `${Math.max(end - start, 3)}%`,
                                                borderLeftColor: 'currentColor',
                                            }}
                                        >
                                            <span className="block truncate font-semibold">{e.title}</span>
                                            <span className="block truncate">
                                                {formatTime(e.start)} – {formatTime(e.end)}
                                            </span>
                                        </button>
                                    );
                                })}
                            {isSameDay(d, now) && now.getHours() >= HOURS[0]! && (
                                <span
                                    aria-hidden
                                    className="absolute inset-x-0 h-px bg-danger"
                                    style={{ top: `${top(now)}%` }}
                                />
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function AgendaView({
    date,
    now,
    events,
    onOpen,
}: {
    date: Date;
    now: Date;
    events: readonly CalendarEvent[];
    onOpen: (e: CalendarEvent) => void;
}) {
    const first = new Date(date.getFullYear(), date.getMonth(), 1);
    const n = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const groups = Array.from({ length: n }, (_, i) => addDays(first, i))
        .map((day) => ({ day, list: eventsOn(events, day) }))
        .filter((g) => g.list.length > 0);
    if (groups.length === 0) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-text-muted">
                <CalendarX2 aria-hidden className="size-8" />
                <p className="m-0 text-sm">Nothing this month.</p>
            </div>
        );
    }
    return (
        <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
            {groups.map(({ day, list }) => (
                <div key={day.toISOString()} className="flex gap-4 p-4">
                    <div className="w-14 shrink-0 text-center">
                        <div className="text-[11px] font-medium text-text-muted uppercase">
                            {day.toLocaleDateString(undefined, { weekday: 'short' })}
                        </div>
                        <div
                            className={cn(
                                'mx-auto mt-1 grid size-9 place-items-center rounded-full text-lg font-semibold',
                                isSameDay(day, now) && 'bg-primary text-primary-foreground',
                            )}
                        >
                            {day.getDate()}
                        </div>
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                        {list.map((e) => {
                            const c = EVENT_TYPE_CONFIG[e.type];
                            return (
                                <button
                                    key={e.id}
                                    type="button"
                                    onClick={() => onOpen(e)}
                                    className={cn(
                                        'flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left hover:bg-surface-raised',
                                        focusRing,
                                    )}
                                >
                                    <span aria-hidden className={cn('h-8 w-1 rounded-full', c.bar)} />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm font-medium">{e.title}</span>
                                        <span className="block truncate text-xs text-text-muted">
                                            {e.allDay ? 'All day' : `${formatTime(e.start)} – ${formatTime(e.end)}`}
                                            {e.subtitle ? ` · ${e.subtitle}` : ''}
                                        </span>
                                    </span>
                                    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', c.chip)}>
                                        {c.label}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}

function EventDialog({ event, onClose }: { event: CalendarEvent | null; onClose: () => void }) {
    const c = event ? EVENT_TYPE_CONFIG[event.type] : null;
    const m = event?.meeting;
    return (
        <Dialog open={event !== null} onOpenChange={(o) => !o && onClose()}>
            {event && c && (
                <DialogContent>
                    <div className="flex items-start gap-3">
                        <span aria-hidden className={cn('mt-1 h-10 w-1 rounded-full', c.bar)} />
                        <div className="min-w-0 flex-1">
                            <DialogTitle>{event.title}</DialogTitle>
                            <DialogDescription>
                                {event.allDay
                                    ? event.start.toLocaleDateString(undefined, {
                                          weekday: 'long',
                                          month: 'long',
                                          day: 'numeric',
                                      })
                                    : `${event.start.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · ${formatTime(event.start)} – ${formatTime(event.end)}`}
                            </DialogDescription>
                        </div>
                        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', c.chip)}>
                            {c.label}
                        </span>
                    </div>
                    <DialogBody className="flex flex-col gap-2 text-sm">
                        {m?.location && (
                            <p className="m-0 flex items-center gap-2 text-text-muted">
                                <MapPin aria-hidden className="size-4" /> {m.location}
                            </p>
                        )}
                        {m?.conferenceUrl && (
                            <a
                                href={m.conferenceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="flex items-center gap-2 text-accent underline-offset-4 hover:underline"
                            >
                                <Video aria-hidden className="size-4" /> Join the call
                            </a>
                        )}
                        {m && m.attendees.length > 0 && (
                            <div>
                                <p className="m-0 mb-1 text-xs font-medium text-text-muted">Attendees</p>
                                <ul className="m-0 list-none p-0 text-sm">
                                    {m.attendees.map((a) => (
                                        <li key={a.address} className="flex items-center justify-between gap-2 py-0.5">
                                            <span className="truncate">{a.displayName || a.address}</span>
                                            <span className="text-xs text-text-muted">
                                                {a.responseStatus.replace('_', ' ')}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        {!m && event.subtitle && <p className="m-0 text-text-muted">{event.subtitle}</p>}
                    </DialogBody>
                    <DialogFooter>
                        {event.href && (
                            <Button asChild variant="primary">
                                <Link to={event.href}>
                                    Open <ExternalLink aria-hidden />
                                </Link>
                            </Button>
                        )}
                        <Button variant="secondary" onClick={onClose}>
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            )}
        </Dialog>
    );
}
