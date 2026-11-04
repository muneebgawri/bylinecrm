import { Avatar, Badge, Card, CardContent, CardHeader, EmptyState, LoadingRegion, Skeleton, cn } from '@bylinecrm/ui';
import { ArrowRight, BadgeDollarSign, CircleX, Plus, Trophy, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useDealFeed } from '../../../api/dealFeed';
import type { DealFeedItemView } from '../../../api/types';
import { formatDate, formatWhen } from '../../../lib/format';
import { formatMoney, formatMoneyCompact } from '../../../lib/money';
import { paths } from '../../paths';

type Kind = DealFeedItemView['kind'];

/** Each kind's verb and its marker on the actor's avatar. */
const KIND: Record<Kind, { verb: string; icon: typeof Plus; className: string }> = {
    created: { verb: 'created', icon: Plus, className: 'bg-info text-white' },
    stage: { verb: 'moved', icon: ArrowRight, className: 'bg-text-muted text-surface' },
    won: { verb: 'won', icon: Trophy, className: 'bg-success text-white' },
    lost: { verb: 'lost', icon: CircleX, className: 'bg-danger text-white' },
    paid: { verb: 'recorded a payment on', icon: BadgeDollarSign, className: 'bg-success text-white' },
};

/** How long an entry that arrived since the last poll stays highlighted. */
const FRESH_MS = 4_000;

/** "Today", "Yesterday", or the date: the feed's day headings, on the reader's clock. */
function dayOf(iso: string, now: Date): string {
    const day = new Date(iso);
    const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((start(now) - start(day)) / 86_400_000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return formatDate(iso);
}

/** What the entry says changed, as chips: the stage move, the outcome, a payment. */
function Outcome({ item }: { item: DealFeedItemView }) {
    switch (item.kind) {
        case 'created':
            return <Badge status="info">New deal</Badge>;
        case 'stage':
            return item.toStage ? (
                <span className="inline-flex min-w-0 items-center gap-1 text-xs text-text-muted">
                    {item.fromStage && <span className="truncate">{item.fromStage}</span>}
                    {item.fromStage && <ArrowRight aria-label="to" className="size-3 shrink-0" />}
                    <Badge status="accent" className="min-w-0 truncate">
                        {item.toStage}
                    </Badge>
                </span>
            ) : null;
        case 'won':
            return (
                <Badge status="success" dot>
                    Won
                </Badge>
            );
        case 'lost':
            return (
                <Badge status="danger" dot>
                    Lost
                </Badge>
            );
        case 'paid':
            return <Badge status="success">Invoice paid</Badge>;
    }
}

function FeedEntry({ item, workspaceId, fresh }: { item: DealFeedItemView; workspaceId: string; fresh: boolean }) {
    const kind = KIND[item.kind];
    const Icon = kind.icon;
    const rule = item.actor.kind === 'rule';
    const actor = rule ? 'Automation' : (item.actor.member?.name ?? 'A teammate');
    const owner = item.deal.owner;
    const ownedByActor = owner && item.actor.member && owner.id === item.actor.member.id;
    return (
        <li
            className={cn(
                'flex gap-3 rounded-md px-2 py-2.5 transition-colors duration-700',
                fresh ? 'bg-accent-soft' : 'hover:bg-surface-raised',
            )}
        >
            <span className="relative shrink-0">
                {rule ? (
                    <span className="grid size-8 place-items-center rounded-full bg-surface-raised text-text-muted">
                        <Workflow aria-hidden className="size-4" />
                    </span>
                ) : (
                    <Avatar name={actor} size="md" />
                )}
                <span
                    aria-hidden
                    className={cn(
                        'absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full ring-2 ring-surface',
                        kind.className,
                    )}
                >
                    <Icon className="size-2.5" strokeWidth={3} />
                </span>
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                    <p className="m-0 min-w-0 flex-1 truncate text-sm">
                        <span className="font-medium">{actor}</span>{' '}
                        <span className="text-text-muted">{kind.verb}</span>{' '}
                        {item.deal.canOpen ? (
                            <Link
                                to={paths.deal(workspaceId, item.deal.id)}
                                className="font-medium text-text underline-offset-2 hover:underline"
                            >
                                {item.deal.name}
                            </Link>
                        ) : (
                            <span className="font-medium" title="Owned by a teammate">
                                {item.deal.name}
                            </span>
                        )}
                    </p>
                    <time
                        dateTime={item.happenedAt}
                        title={new Date(item.happenedAt).toLocaleString()}
                        className="shrink-0 text-xs text-text-muted tabular-nums"
                    >
                        {formatWhen(item.happenedAt)}
                    </time>
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-2">
                    <Outcome item={item} />
                    {item.deal.amount && (
                        <span
                            title={formatMoney(item.deal.amount)}
                            className="shrink-0 text-xs font-medium tabular-nums"
                        >
                            {formatMoneyCompact(item.deal.amount)}
                        </span>
                    )}
                    {owner?.name && !ownedByActor && (
                        <span className="min-w-0 truncate text-xs text-text-muted">· {owner.name}’s deal</span>
                    )}
                </div>
            </div>
        </li>
    );
}

/**
 * The live deal feed: what the team does with deals — created, moved, won, lost, paid — newest first and grouped by
 * day, for everyone. Polled; an entry that arrives while the dashboard is open is highlighted for a moment. A deal
 * the member may not open is named, not linked.
 */
export function DealFeedCard({ workspaceId, className }: { workspaceId: string; className?: string }) {
    const feed = useDealFeed(workspaceId);
    const seen = useRef<Set<string> | null>(null);
    const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
    const items = feed.data?.items;

    useEffect(() => {
        if (!items) return;
        const ids = items.map((i) => i.id);
        // The first answer is what was already there; only later ones bring news.
        const arrived = seen.current ? ids.filter((id) => !seen.current!.has(id)) : [];
        seen.current = new Set(ids);
        if (arrived.length === 0) return;
        setFresh(new Set(arrived));
        const timer = setTimeout(() => setFresh(new Set()), FRESH_MS);
        return () => clearTimeout(timer);
    }, [items]);

    if (feed.isError) throw feed.error;
    const now = new Date();
    const days: { day: string; items: DealFeedItemView[] }[] = [];
    for (const item of items ?? []) {
        const day = dayOf(item.happenedAt, now);
        if (days.at(-1)?.day === day) days.at(-1)!.items.push(item);
        else days.push({ day, items: [item] });
    }

    return (
        <Card className={cn('gap-3', className)} aria-labelledby="deal-feed-title">
            <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 id="deal-feed-title" className="m-0 text-sm font-semibold">
                        Live deals
                    </h2>
                    <p className="m-0 mt-0.5 text-xs text-text-muted">
                        What the team is doing with deals, as it happens.
                    </p>
                </div>
                <Badge status="success" shape="pill" className="shrink-0 gap-1.5">
                    <span aria-hidden className="relative flex size-1.5">
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-70 motion-reduce:hidden" />
                        <span className="relative inline-flex size-1.5 rounded-full bg-success" />
                    </span>
                    Live
                </Badge>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">
                {!items ? (
                    <LoadingRegion label="Loading the deal feed">
                        <Skeleton className="h-12" />
                        <Skeleton className="mt-2 h-12" />
                        <Skeleton className="mt-2 h-12" />
                    </LoadingRegion>
                ) : items.length === 0 ? (
                    <EmptyState
                        title="No deal activity yet"
                        body="When anyone creates, moves, wins or loses a deal, it shows here."
                    />
                ) : (
                    // About eight entries show; the rest scroll inside the card, so the dashboard keeps its height.
                    <div
                        role="region"
                        aria-label="Latest deal activity"
                        aria-live="polite"
                        tabIndex={0}
                        className="-mx-2 max-h-[26rem] overflow-y-auto overscroll-contain px-0"
                    >
                        {days.map(({ day, items: entries }) => (
                            <section key={day} aria-label={day}>
                                <h3 className="sticky top-0 z-[1] m-0 bg-surface px-2 py-1.5 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
                                    {day}
                                </h3>
                                <ul className="m-0 list-none p-0">
                                    {entries.map((item) => (
                                        <FeedEntry
                                            key={item.id}
                                            item={item}
                                            workspaceId={workspaceId}
                                            fresh={fresh.has(item.id)}
                                        />
                                    ))}
                                </ul>
                            </section>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
