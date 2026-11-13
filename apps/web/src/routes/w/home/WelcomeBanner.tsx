import { Avatar, Button, Card, CardContent, Skeleton } from '@bylinecrm/ui';
import { Activity, ExternalLink, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import { useDefaultBoard } from '../../../api/deals';
import { useProfile } from '../../../api/queries';
import { useMembersSummary } from '../../../api/records';
import { formatMoneyCompact } from '../../../lib/money';
import { paths } from '../../paths';
import { boardCurrency, count, open, sumOf, valuedCount, won } from '../reports/reportsData';

/**
 * The dashboard's welcome (moved from Reports, #360): the pipeline live, the reader by name, one line on the
 * open pipeline and how much of the day's work list waits (`attention`: the sections' counts for the member
 * viewed; null while loading), the three headline figures, the team, and the way to the pipeline.
 */
export function WelcomeBanner({ workspaceId, attention }: { workspaceId: string; attention: number | null }) {
    const profile = useProfile();
    // The summary, not the admin's member list: every member may read who is on the team.
    const members = useMembersSummary(workspaceId);
    const { board } = useDefaultBoard(workspaceId);
    const data = board.data;
    const currency = boardCurrency(data);
    const money = (amountMinor: number) => formatMoneyCompact({ amountMinor, currency });
    const name = profile.data?.displayName ?? profile.data?.email ?? '';
    const openCount = count(open(data));
    // The value is the sum of the deals that have one: say how many those are, or a few priced deals read as all.
    const valued = valuedCount(open(data));
    const risky = attention ?? 0;
    const today = new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
    const team = (members.data ?? []).filter((m) => m.leftAt === null).map((m) => m.name ?? 'Unnamed member');
    return (
        <Card className="relative gap-0 overflow-hidden py-4 bg-[linear-gradient(120deg,var(--color-info-soft),var(--color-surface)_45%,var(--color-success-soft))]">
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 text-border [background-image:radial-gradient(currentColor_1px,transparent_1px)] [background-size:16px_16px] [mask-image:linear-gradient(to_right,transparent,white)]"
            />
            <CardContent className="relative flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-4 xl:flex-nowrap">
                <div className="min-w-0 max-w-2xl xl:flex-1">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/80 px-2.5 py-1 text-text-muted">
                            <Activity aria-hidden className="size-3.5" />
                            {data ? `${data.pipeline.name} · live` : 'Loading the pipeline'}
                        </span>
                    </div>
                    <h2 className="m-0 text-xl font-semibold tracking-tight">Welcome back{name ? `, ${name}` : ''}</h2>
                    {data ? (
                        <p className="m-0 mt-1 text-sm leading-6 text-text-muted">
                            Here's how your pipeline is performing today —{' '}
                            <b className="font-semibold text-text">{openCount.toLocaleString()}</b> open{' '}
                            {openCount === 1 ? 'deal' : 'deals'}
                            {valued === openCount
                                ? ' worth '
                                : `; the ${valued.toLocaleString()} with a value are worth `}
                            <b className="font-semibold text-text">{money(sumOf(open(data), currency).amountMinor)}</b>
                            {attention === null ? (
                                '.'
                            ) : risky > 0 ? (
                                <>
                                    , with <b className="font-semibold text-text">{risky.toLocaleString()}</b> needing
                                    your attention.
                                </>
                            ) : (
                                ', and nothing waiting for you.'
                            )}
                        </p>
                    ) : (
                        <Skeleton className="mt-1 h-5 w-96" />
                    )}
                </div>
                <div className="flex shrink-0 flex-col gap-2 max-md:w-full md:items-end">
                    <div className="flex gap-2">
                        <Button asChild variant="secondary" size="sm">
                            <Link to={paths.deals(workspaceId)}>
                                <ExternalLink aria-hidden /> Open pipeline
                            </Link>
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            loading={board.isFetching}
                            onClick={() => void board.refetch()}
                        >
                            <RefreshCw aria-hidden /> Refresh data
                        </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 md:justify-end">
                        <HeroStat
                            label="Pipeline value"
                            value={data ? money(sumOf(open(data), currency).amountMinor) : '…'}
                            note={
                                data && valued !== openCount
                                    ? `${valued.toLocaleString()} deals with a value`
                                    : undefined
                            }
                        />
                        <HeroStat label="Deals won" value={data ? count(won(data)).toLocaleString() : '…'} />
                        <HeroStat label="Open deals" value={data ? openCount.toLocaleString() : '…'} dot />
                        {team.length > 0 && (
                            <div className="flex items-center gap-2">
                                <div className="flex -space-x-2">
                                    {team.slice(0, 3).map((n) => (
                                        <Avatar key={n} name={n} size="md" className="ring-2 ring-surface" />
                                    ))}
                                    {team.length > 3 && (
                                        <span className="grid size-8 place-items-center rounded-full bg-surface-raised text-xs font-medium text-text-muted ring-2 ring-surface">
                                            +{team.length - 3}
                                        </span>
                                    )}
                                </div>
                                <span className="text-sm text-text-muted">
                                    {team.length} {team.length === 1 ? 'teammate' : 'teammates'}
                                </span>
                            </div>
                        )}
                    </div>
                    <span className="text-xs text-text-muted">{today}</span>
                </div>
            </CardContent>
        </Card>
    );
}

function HeroStat({
    label,
    value,
    note,
    dot = false,
}: {
    label: string;
    value: string;
    /** What the figure counts, under it, when the label alone would mislead. */
    note?: string | undefined;
    dot?: boolean;
}) {
    return (
        <div className="border-r border-border/60 pr-5 last:border-r-0">
            <div className="text-[11px] font-medium tracking-wide text-text-muted uppercase">{label}</div>
            <div className="flex items-center gap-1.5 text-lg font-semibold tracking-tight tabular-nums">
                {dot && <span aria-hidden className="size-1.5 rounded-full bg-success" />}
                {value}
            </div>
            {note && <div className="text-[11px] text-text-muted">{note}</div>}
        </div>
    );
}
