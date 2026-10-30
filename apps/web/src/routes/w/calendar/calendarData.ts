import type { MeetingView, MyTaskView, OpportunityView } from '../../../api/types';

/**
 * The calendar's events, made from three things the API already has: meetings from members'
 * calendars, the member's own tasks by their due time, and deals by their expected close date.
 */
export type EventType = 'meeting' | 'task' | 'deal';
export type CalendarView = 'month' | 'week' | 'day' | 'agenda';

export interface CalendarEvent {
    id: string;
    type: EventType;
    title: string;
    start: Date;
    end: Date;
    allDay: boolean;
    /** Where it comes from, for the details panel. */
    subtitle?: string | undefined;
    href?: string | undefined;
    meeting?: MeetingView | undefined;
}

export const EVENT_TYPES: readonly EventType[] = ['meeting', 'task', 'deal'];

export const EVENT_TYPE_CONFIG: Record<EventType, { label: string; dot: string; chip: string; bar: string }> = {
    meeting: { label: 'Meeting', dot: 'bg-chart-1', chip: 'bg-info-soft text-info', bar: 'bg-chart-1' },
    task: { label: 'Task', dot: 'bg-chart-2', chip: 'bg-warning-soft text-warning', bar: 'bg-chart-2' },
    deal: { label: 'Deal close', dot: 'bg-chart-3', chip: 'bg-success-soft text-success', bar: 'bg-chart-3' },
};

export const CALENDAR_VIEWS: { value: CalendarView; label: string }[] = [
    { value: 'month', label: 'Month' },
    { value: 'week', label: 'Week' },
    { value: 'day', label: 'Day' },
    { value: 'agenda', label: 'Agenda' },
];

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
};
export const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const isSameMonth = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

/** The six rows of a month grid, Monday first. */
export function monthGrid(date: Date): Date[] {
    const first = new Date(date.getFullYear(), date.getMonth(), 1);
    const start = addDays(first, -((first.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Monday to Sunday of the week the date is in. */
export function weekDays(date: Date): Date[] {
    const start = addDays(startOfDay(date), -((date.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The `[from, to)` the views need: the month grid for month and agenda, the week, or the day. */
export function rangeFor(view: CalendarView, date: Date): { from: Date; to: Date } {
    if (view === 'week') {
        const days = weekDays(date);
        return { from: days[0]!, to: addDays(days[6]!, 1) };
    }
    if (view === 'day') return { from: startOfDay(date), to: addDays(startOfDay(date), 1) };
    const grid = monthGrid(date);
    return { from: grid[0]!, to: addDays(grid[41]!, 1) };
}

export function eventsOn(events: readonly CalendarEvent[], day: Date): CalendarEvent[] {
    const from = startOfDay(day);
    const to = addDays(from, 1);
    return events
        .filter((e) => e.start < to && e.end > from)
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
}

export const formatTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function whenLabel(e: CalendarEvent): string {
    const day = e.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return e.allDay ? day : `${day} · ${formatTime(e.start)}`;
}

export function fromMeetings(meetings: readonly MeetingView[]): CalendarEvent[] {
    return meetings
        .filter((m) => m.status !== 'cancelled')
        .map((m) => ({
            id: `meeting:${m.id}`,
            type: 'meeting',
            title: m.title,
            start: new Date(m.startsAt),
            end: new Date(m.endsAt),
            allDay: m.allDay,
            subtitle: m.location ?? (m.conferenceUrl ? 'Video call' : undefined),
            meeting: m,
        }));
}

export function fromTasks(tasks: readonly MyTaskView[], href: (t: MyTaskView) => string | undefined): CalendarEvent[] {
    return tasks
        .filter((t) => t.dueAt && t.status !== 'done')
        .map((t) => {
            const start = new Date(t.dueAt!);
            const allDay = start.getHours() === 0 && start.getMinutes() === 0;
            return {
                id: `task:${t.id}`,
                type: 'task',
                title: t.title,
                start,
                end: allDay ? addDays(startOfDay(start), 1) : new Date(start.getTime() + 30 * 60_000),
                allDay,
                subtitle: t.targets.map((x) => x.label).join(', ') || undefined,
                href: href(t),
            };
        });
}

export function fromDeals(deals: readonly OpportunityView[], href: (d: OpportunityView) => string): CalendarEvent[] {
    return deals
        .filter((d) => d.closeDate && !d.closedAt)
        .map((d) => {
            const start = new Date(`${d.closeDate}T00:00:00`);
            return {
                id: `deal:${d.id}`,
                type: 'deal',
                title: `${d.name} closes`,
                start,
                end: addDays(start, 1),
                allDay: true,
                subtitle: d.company?.name ?? undefined,
                href: href(d),
            };
        });
}
