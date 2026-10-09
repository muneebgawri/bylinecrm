import type { RecordTarget } from '@bylinecrm/shared';
import {
    ActivityTimeline,
    Badge,
    Button,
    EmptyState,
    Skeleton,
    cn,
    focusRing,
    type ActivityItem,
    type Tone,
} from '@bylinecrm/ui';
import { useQueries } from '@tanstack/react-query';
import { ArrowRightLeft, DollarSign, FileText, Mail, Paperclip, Pencil, SquareCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { people } from '../../../api/endpoints';
import { keys, useMembersSummary, useTimeline } from '../../../api/queries';
import type { TimelineActivityView } from '../../../api/types';
import { formatWhen } from '../../../lib/format';
import { wordsFor, type TimelineWords } from './timeline-items';

/** The kind chips over the timeline; each is a `kinds` prefix list the API filters by. */
const FILTERS = [
    { id: 'all', label: 'All', kinds: undefined },
    { id: 'notes', label: 'Notes', kinds: 'linked-note' },
    { id: 'tasks', label: 'Tasks', kinds: 'linked-task' },
    { id: 'stages', label: 'Stages', kinds: 'deal.,opportunity.' },
    { id: 'external', label: 'External', kinds: 'external.' },
] as const;

const ICON: Record<TimelineWords['family'], { icon: React.ReactNode; tone: Tone }> = {
    record: { icon: <Pencil />, tone: 'neutral' },
    note: { icon: <FileText />, tone: 'warning' },
    task: { icon: <SquareCheck />, tone: 'info' },
    attachment: { icon: <Paperclip />, tone: 'neutral' },
    stage: { icon: <ArrowRightLeft />, tone: 'accent' },
    external: { icon: <DollarSign />, tone: 'success' },
    mail: { icon: <Mail />, tone: 'accent' },
};

/**
 * The record's activity (doc 50 §A): one list for every kind, newest first, with kind chips and
 * "Load older". A company's list carries its people's entries, tagged with their origin. A
 * failed load leaves the record page usable: the panel says so and offers retry (partial state,
 * FR-CRMS-UI-7).
 */
export function TimelinePanel({
    workspaceId,
    target,
    stageNames,
}: {
    workspaceId: string;
    target: RecordTarget;
    /** A deal's stage ids → names, for its stage-move entries. */
    stageNames?: ReadonlyMap<string, string>;
}) {
    const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
    const kinds = FILTERS.find((f) => f.id === filter)?.kinds;
    const query = useTimeline(workspaceId, target, kinds);
    const members = useMembersSummary(workspaceId);

    const entries = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
    const names = useOriginNames(workspaceId, target, entries);

    const items = useMemo<ActivityItem[]>(() => {
        const memberNames = new Map((members.data ?? []).map((m) => [m.memberId, m.name ?? 'Unnamed member']));
        return entries.map((entry) => {
            const words = wordsFor(entry, {
                members: memberNames,
                own: target,
                recordNames: names,
                ...(stageNames ? { stages: stageNames } : {}),
            });
            const look = ICON[words.family];
            const chips =
                words.detail || words.origin ? (
                    <>
                        {words.origin && <Badge shape="pill">{words.origin}</Badge>}
                        {words.detail?.map((d, i) => (
                            <Badge
                                key={`${d.label}-${i}`}
                                status={d.tone === 'neutral' ? 'neutral' : (d.tone ?? 'neutral')}
                            >
                                {d.label}
                            </Badge>
                        ))}
                    </>
                ) : undefined;
            return {
                id: entry.id,
                icon: look.icon,
                tone: look.tone,
                actor: words.actor,
                action: words.action,
                time: formatWhen(entry.happenedAt),
                dateTime: entry.happenedAt,
                ...(chips ? { chips } : {}),
            };
        });
    }, [entries, members.data, names, target, stageNames]);

    return (
        <section className="rounded-lg border border-border bg-surface shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                <h3 className="m-0 text-[13px] font-medium text-text-muted">Activity</h3>
                <div role="group" aria-label="Show" className="ml-auto flex gap-1">
                    {FILTERS.map((f) => (
                        <button
                            key={f.id}
                            type="button"
                            aria-pressed={filter === f.id}
                            onClick={() => setFilter(f.id)}
                            className={cn(
                                'h-7 rounded-md px-2.5 text-xs font-medium text-text-muted hover:text-text max-md:min-h-touch max-md:min-w-touch',
                                filter === f.id && 'border border-border bg-surface-raised text-text',
                                focusRing,
                            )}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>
            <div className="px-4 py-2">
                {query.isPending ? (
                    <div
                        className="flex flex-col gap-3 py-2"
                        role="status"
                        aria-busy="true"
                        aria-label="Loading activity"
                    >
                        <Skeleton className="h-10" />
                        <Skeleton className="h-10" />
                        <Skeleton className="h-10" />
                    </div>
                ) : query.isError ? (
                    <div className="flex items-center gap-3 rounded-md bg-surface-raised px-3 py-2 text-[13px] text-text-muted">
                        <span>Activity could not be loaded — the record above is current.</span>
                        <Button size="xs" shape="square" className="ml-auto" onClick={() => void query.refetch()}>
                            Retry
                        </Button>
                    </div>
                ) : items.length === 0 ? (
                    <EmptyState
                        className="my-2 py-8"
                        title={
                            filter === 'all'
                                ? 'Nothing yet'
                                : `No ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} yet`
                        }
                        body={
                            filter === 'all'
                                ? 'Add a note or a task; what happens to this record shows here.'
                                : undefined
                        }
                    />
                ) : (
                    <>
                        <ActivityTimeline items={items} />
                        {query.hasNextPage && (
                            <div className="flex justify-center py-2">
                                <Button
                                    size="sm"
                                    shape="square"
                                    variant="ghost"
                                    disabled={query.isFetchingNextPage}
                                    onClick={() => void query.fetchNextPage()}
                                >
                                    {query.isFetchingNextPage ? 'Loading…' : 'Load older'}
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </div>
        </section>
    );
}

/**
 * On a merged timeline the entries of other records need names. Only people merge into a
 * company today, so the distinct person ids are looked up (cached per record, so a person the
 * page already loaded costs nothing).
 */
function useOriginNames(
    workspaceId: string,
    own: RecordTarget,
    entries: readonly TimelineActivityView[],
): ReadonlyMap<string, string> {
    const ids = useMemo(
        () => [
            ...new Set(
                entries
                    .filter((e) => e.target.type === 'person' && (e.target.type !== own.type || e.target.id !== own.id))
                    .map((e) => e.target.id),
            ),
        ],
        [entries, own],
    );
    const results = useQueries({
        queries: ids.map((id) => ({
            queryKey: keys.record(workspaceId, 'person', id),
            queryFn: ({ signal }: { signal: AbortSignal }) => people.get(workspaceId, id, signal),
            staleTime: 60_000,
        })),
    });
    return useMemo(() => {
        const map = new Map<string, string>();
        results.forEach((r, i) => {
            const id = ids[i];
            if (id && r.data)
                map.set(id, `${r.data.nameFirst} ${r.data.nameLast}`.trim() || r.data.emails.primary || 'Person');
        });
        return map;
    }, [results, ids]);
}
