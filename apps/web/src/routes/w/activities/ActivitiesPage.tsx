import type { RecordObject } from '@bylinecrm/shared';
import {
    Avatar,
    Badge,
    Button,
    EmptyState,
    Input,
    LoadingRegion,
    PageHeader,
    Skeleton,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    cn,
    toneSoft,
    type Tone,
} from '@bylinecrm/ui';
import { useQueries } from '@tanstack/react-query';
import {
    Activity,
    ArrowRightLeft,
    CalendarDays,
    DollarSign,
    FileText,
    Mail,
    Paperclip,
    Pencil,
    Search,
    SquareCheck,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { recordEndpoints, useActivityFeed, useMembersSummary } from '../../../api/records';
import { keys } from '../../../api/queries';
import type { TimelineActivityView } from '../../../api/types';
import { formatWhen } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { OBJECT_LABEL, recordPath } from '../records/targets';
import { wordsFor, type TimelineWords } from '../records/timeline-items';

const TABS = [
    { id: 'all', label: 'All activity', kinds: undefined },
    { id: 'notes', label: 'Notes', kinds: 'linked-note' },
    { id: 'tasks', label: 'Tasks', kinds: 'linked-task' },
    { id: 'emails', label: 'Emails', kinds: 'linked-email' },
    { id: 'meetings', label: 'Meetings', kinds: 'linked-meeting' },
    { id: 'stages', label: 'Stage changes', kinds: 'deal.,opportunity.' },
    { id: 'external', label: 'External', kinds: 'external.' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const ICON: Record<TimelineWords['family'], { icon: ReactNode; tone: Tone }> = {
    record: { icon: <Pencil />, tone: 'neutral' },
    note: { icon: <FileText />, tone: 'warning' },
    task: { icon: <SquareCheck />, tone: 'info' },
    attachment: { icon: <Paperclip />, tone: 'neutral' },
    stage: { icon: <ArrowRightLeft />, tone: 'accent' },
    external: { icon: <DollarSign />, tone: 'success' },
    mail: { icon: <Mail />, tone: 'accent' },
    meeting: { icon: <CalendarDays />, tone: 'info' },
};

/**
 * The workspace's activity feed: everything that happened to the records the member may read,
 * newest first, as cards with the record each one is about. The same words as a record's own
 * timeline, so the feed and the record never disagree.
 */
export function ActivitiesPage() {
    const workspaceId = useWorkspaceId();
    const [tab, setTab] = useState<TabId>('all');
    const [q, setQ] = useState('');
    const kinds = TABS.find((t) => t.id === tab)?.kinds;
    const feed = useActivityFeed(workspaceId, kinds);
    const members = useMembersSummary(workspaceId);
    const entries = useMemo(() => feed.data?.pages.flatMap((p) => p.items) ?? [], [feed.data]);
    const names = useRecordNames(workspaceId, entries);
    const memberNames = useMemo(
        () => new Map((members.data ?? []).map((m) => [m.memberId, m.name ?? 'Unnamed member'])),
        [members.data],
    );
    const items = useMemo(
        () =>
            entries.map((entry) => ({
                entry,
                words: wordsFor(entry, { members: memberNames, own: { type: 'person', id: '' }, recordNames: names }),
            })),
        [entries, memberNames, names],
    );
    const term = q.trim().toLowerCase();
    const shown = items.filter(
        ({ entry, words }) =>
            !term ||
            words.action.toLowerCase().includes(term) ||
            words.actor.toLowerCase().includes(term) ||
            (names.get(entry.target.id) ?? '').toLowerCase().includes(term),
    );
    const today = new Date().toDateString();
    const groups = groupByDay(shown);

    return (
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="flex flex-col gap-4 p-4 md:p-6">
            <PageHeader
                className="mb-0"
                title="Activities"
                subtitle="Everything that happened across your records, newest first."
            />
            <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 overflow-x-auto">
                    <TabsList variant="pill" aria-label="Kind">
                        {TABS.map((t) => (
                            <TabsTrigger key={t.id} value={t.id} className="text-xs">
                                {t.label}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                </div>
                <label className="relative ml-auto block w-full max-w-72">
                    <Search
                        aria-hidden
                        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-faint"
                    />
                    <Input
                        aria-label="Search activity"
                        placeholder="Search activity…"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        className="pl-9"
                    />
                </label>
            </div>
            <TabsContent value={tab} className="pt-0">
                {feed.isPending ? (
                    <LoadingRegion label="Loading activity" className="flex flex-col gap-3">
                        <Skeleton className="h-20" />
                        <Skeleton className="h-20" />
                        <Skeleton className="h-20" />
                    </LoadingRegion>
                ) : feed.isError ? (
                    <EmptyState
                        tone="error"
                        icon={<Activity />}
                        title="Activity could not be loaded"
                        body="Check your connection and try again."
                        action={
                            <Button variant="secondary" size="sm" onClick={() => void feed.refetch()}>
                                Retry
                            </Button>
                        }
                    />
                ) : shown.length === 0 ? (
                    <EmptyState
                        icon={<Activity />}
                        title={term ? 'Nothing matches' : 'Nothing yet'}
                        body={
                            term
                                ? 'Try different words, or another kind.'
                                : 'Notes, tasks, emails, meetings and stage changes show here as they happen.'
                        }
                    />
                ) : (
                    <div className="flex flex-col gap-6">
                        {groups.map(({ day, list }) => (
                            <section key={day} aria-label={day}>
                                <h2 className="m-0 mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
                                    {day === today
                                        ? 'Today'
                                        : new Date(day).toLocaleDateString(undefined, {
                                              weekday: 'long',
                                              month: 'long',
                                              day: 'numeric',
                                          })}
                                </h2>
                                <div className="flex flex-col gap-2">
                                    {list.map(({ entry, words }) => (
                                        <ActivityCard
                                            key={entry.id}
                                            entry={entry}
                                            words={words}
                                            name={names.get(entry.target.id)}
                                            workspaceId={workspaceId}
                                        />
                                    ))}
                                </div>
                            </section>
                        ))}
                        {feed.hasNextPage && (
                            <Button
                                variant="secondary"
                                className="self-center"
                                loading={feed.isFetchingNextPage}
                                onClick={() => void feed.fetchNextPage()}
                            >
                                Load older
                            </Button>
                        )}
                    </div>
                )}
            </TabsContent>
        </Tabs>
    );
}

function groupByDay<T extends { entry: TimelineActivityView }>(items: readonly T[]): { day: string; list: T[] }[] {
    const out: { day: string; list: T[] }[] = [];
    for (const item of items) {
        const day = new Date(item.entry.happenedAt).toDateString();
        const last = out[out.length - 1];
        if (last && last.day === day) last.list.push(item);
        else out.push({ day, list: [item] });
    }
    return out;
}

function ActivityCard({
    entry,
    words,
    name,
    workspaceId,
}: {
    entry: TimelineActivityView;
    words: TimelineWords;
    name: string | undefined;
    workspaceId: string;
}) {
    const look = ICON[words.family];
    return (
        <article className="flex items-start justify-between gap-4 rounded-xl border border-border bg-surface p-4 transition-colors hover:bg-surface-raised/60">
            <div className="flex min-w-0 items-start gap-3.5">
                <span
                    aria-hidden
                    className={cn(
                        'grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
                        toneSoft[look.tone],
                    )}
                >
                    {look.icon}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                    <p className="m-0 text-sm">
                        <span className="font-semibold">{words.actor}</span>{' '}
                        <span className="text-text-muted">{words.action}</span>
                    </p>
                    {words.detail && words.detail.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {words.detail.map((d, i) => (
                                <Badge
                                    key={`${d.label}-${i}`}
                                    status={d.tone === 'neutral' ? 'neutral' : (d.tone ?? 'neutral')}
                                >
                                    {d.label}
                                </Badge>
                            ))}
                        </div>
                    )}
                    <p className="m-0 flex items-center gap-1.5 text-xs text-text-muted">
                        <span className="font-medium text-text">{OBJECT_LABEL[entry.target.type]}:</span>
                        <Link
                            to={recordPath(workspaceId, entry.target)}
                            className="truncate hover:underline max-md:flex max-md:min-h-touch max-md:items-center"
                        >
                            {name ?? '…'}
                        </Link>
                    </p>
                </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-text-muted">
                <time dateTime={entry.happenedAt}>{formatWhen(entry.happenedAt)}</time>
                <span className="flex items-center gap-1.5">
                    <Avatar name={words.actor} size="xs" />
                    <span className="hidden sm:inline">{words.actor}</span>
                </span>
            </div>
        </article>
    );
}

/** The name of every record the entries point at, read once each and kept for a minute. */
function useRecordNames(workspaceId: string, entries: readonly TimelineActivityView[]): ReadonlyMap<string, string> {
    const targets = useMemo(() => {
        const seen = new Map<string, { type: RecordObject; id: string }>();
        for (const e of entries) seen.set(`${e.target.type}:${e.target.id}`, e.target);
        return [...seen.values()];
    }, [entries]);
    const results = useQueries({
        queries: targets.map((t) => ({
            queryKey: keys.record(workspaceId, t.type, t.id),
            queryFn: ({ signal }: { signal: AbortSignal }) => recordEndpoints[t.type].get(workspaceId, t.id, signal),
            staleTime: 60_000,
        })),
    });
    return useMemo(() => {
        const map = new Map<string, string>();
        results.forEach((r, i) => {
            const t = targets[i];
            const d = r.data as
                | { name?: string; nameFirst?: string; nameLast?: string; emails?: { primary: string | null } }
                | undefined;
            if (!t || !d) return;
            const name = d.name ?? [d.nameFirst, d.nameLast].filter(Boolean).join(' ') ?? d.emails?.primary;
            map.set(t.id, name || d.emails?.primary || 'Unnamed');
        });
        return map;
    }, [results, targets]);
}
