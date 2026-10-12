import type { RecordTarget } from '@bylinecrm/shared';
import {
    ActivityTimeline,
    Badge,
    Button,
    cn,
    EmptyState,
    focusRing,
    LoadingRegion,
    Skeleton,
    type ActivityItem,
    type Tone,
} from '@bylinecrm/ui';
import { useQueries } from '@tanstack/react-query';
import { ArrowRightLeft, DollarSign, FileText, Mail, Paperclip, Pencil, SquareCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { people } from '../../../api/records';
import { keys } from '../../../api/queries';
import { useMembersSummary, useTimeline } from '../../../api/records';
import type { TimelineActivityView } from '../../../api/types';
import { useMembership } from '../../../auth/capabilities';
import { formatWhen } from '../../../lib/format';
import { usePendingSends, type PendingSend } from '../mail/sends';
import { SendStatus, pendingAction } from '../mail/SendStatus';
import { withThread } from '../mail/thread';
import { wordsFor, type TimelineWords } from './timeline-items';

/** The kind chips over the timeline; each is a `kinds` prefix list the API filters by. */
const FILTERS = [
    { id: 'all', label: 'All', kinds: undefined },
    { id: 'notes', label: 'Notes', kinds: 'linked-note' },
    { id: 'tasks', label: 'Tasks', kinds: 'linked-task' },
    { id: 'stages', label: 'Stages', kinds: 'deal.,opportunity.' },
    { id: 'external', label: 'External', kinds: 'external.' },
    { id: 'emails', label: 'Emails', kinds: 'linked-email' },
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
 *
 * Mail is part of the one list: a stored email's line opens its thread (`?thread=`), and a send
 * made here shows at the top at once — "Sending…", then "Sent" until the stored copy replaces it;
 * "Failed" with Retry; "Scheduled for …" with Reschedule and Cancel.
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
    const location = useLocation();
    const stored = useMemo(
        () => new Set(entries.flatMap((e) => (e.linked?.type === 'email' ? [e.linked.id] : []))),
        [entries],
    );
    const pending = usePendingSends(workspaceId, target, stored);
    const showPending = filter === 'all' || filter === 'emails';

    const me = useMembership()?.memberId ?? null;
    const memberNames = useMemo(
        () => new Map((members.data ?? []).map((m) => [m.memberId, m.name ?? 'Unnamed member'])),
        [members.data],
    );
    const items = useMemo<ActivityItem[]>(() => {
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
            const threadId = words.threadId;
            return {
                id: entry.id,
                icon: look.icon,
                tone: look.tone,
                actor: words.actor,
                action: threadId ? (
                    <Link
                        to={{ search: withThread(location.search, threadId) }}
                        className={cn(
                            // A phone's finger target: the line is a 44px-tall link there (FR-CRMS-UI-12).
                            'text-text underline decoration-border-strong underline-offset-2 hover:decoration-current max-md:inline-flex max-md:min-h-touch max-md:items-center',
                            focusRing,
                        )}
                    >
                        {words.action}
                    </Link>
                ) : (
                    words.action
                ),
                time: formatWhen(entry.happenedAt),
                dateTime: entry.happenedAt,
                ...(chips ? { chips } : {}),
            };
        });
    }, [entries, memberNames, names, target, stageNames, location.search]);
    const shown = useMemo(
        () => [
            ...(showPending ? pending.sends.map((p) => pendingItem(workspaceId, p, me, memberNames)) : []),
            ...items,
        ],
        [showPending, pending, items, workspaceId, me, memberNames],
    );

    return (
        <section className="rounded-lg border border-border bg-surface shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                <h3 className="m-0 text-[13px] font-medium text-text-muted">Activity</h3>
                <div role="group" aria-label="Show" className="ml-auto flex flex-wrap gap-1">
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
                    <LoadingRegion label="Loading activity" className="flex flex-col gap-3 py-2">
                        <Skeleton className="h-10" />
                        <Skeleton className="h-10" />
                        <Skeleton className="h-10" />
                    </LoadingRegion>
                ) : query.isError ? (
                    <div className="flex items-center gap-3 rounded-md bg-surface-raised px-3 py-2 text-[13px] text-text-muted">
                        <span>Activity could not be loaded — the record above is current.</span>
                        <Button size="xs" shape="square" className="ml-auto" onClick={() => void query.refetch()}>
                            Retry
                        </Button>
                    </div>
                ) : shown.length === 0 ? (
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
                        <ActivityTimeline items={shown} />
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
                {/* Scheduled sends are read a page at a time; this record's may be further on. */}
                {showPending && pending.hasMore && (
                    <div className="flex justify-center py-1">
                        <Button
                            size="sm"
                            shape="square"
                            variant="ghost"
                            disabled={pending.loadingMore}
                            onClick={pending.more}
                        >
                            {pending.loadingMore ? 'Loading…' : 'Show more sends'}
                        </Button>
                    </div>
                )}
            </div>
        </section>
    );
}

/**
 * A send not (yet) on the timeline as stored mail. It is "You" for this tab's send and the caller's
 * own; a colleague's send on a record the caller can read (#133) is named by its sender, and shown
 * read-only unless the caller is an admin. It is dated when it was
 * made — a scheduled one is "Not sent yet" — and this tab's send is "just now" until the server
 * has answered.
 */
function pendingItem(
    workspaceId: string,
    send: PendingSend,
    me: string | null,
    memberNames: ReadonlyMap<string, string>,
): ActivityItem {
    const mine = send.session !== null || send.senderMemberId === null || send.senderMemberId === me;
    return {
        id: `send-${send.messageId}`,
        icon: <Mail />,
        tone: send.status === 'failed' ? 'danger' : 'accent',
        actor: mine ? 'You' : (memberNames.get(send.senderMemberId!) ?? 'A teammate'),
        action: pendingAction(send),
        time: send.status === 'scheduled' ? 'Not sent yet' : send.createdAt ? formatWhen(send.createdAt) : 'Just now',
        ...(send.status !== 'scheduled' && send.createdAt ? { dateTime: send.createdAt } : {}),
        chips: <SendStatus workspaceId={workspaceId} send={send} />,
    };
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
