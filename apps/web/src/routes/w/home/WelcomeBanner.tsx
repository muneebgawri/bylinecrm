import { Avatar, Button, Card, CardContent, Skeleton } from '@bylinecrm/ui';
import { Activity, ExternalLink, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import { useDefaultBoard } from '../../../api/deals';
import { useProfile } from '../../../api/queries';
import { useMembersSummary } from '../../../api/records';
import { formatMoneyCompact } from '../../../lib/money';
import { paths } from '../../paths';
import { boardCurrency, count, open, sumOf, won } from '../reports/reportsData';

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
    const risky = attention ?? 0;
    const today = new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
    const team = (members.data ?? []).filter((m) => m.leftAt === null).map((m) => m.name ?? 'Unnamed member');
    return (
        <Card className="relative gap-6 overflow-hidden bg-[linear-gradient(120deg,var(--color-info-soft),var(--color-surface)_45%,var(--color-success-soft))]">
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 text-border [background-image:radial-gradient(currentColor_1px,transparent_1px)] [background-size:16px_16px] [mask-image:linear-gradient(to_right,transparent,white)]"
            />
            <CardContent className="relative flex flex-wrap items-start justify-between gap-6">
                <div className="min-w-0 max-w-2xl">
                    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/80 px-2.5 py-1 text-text-muted">
                            <Activity aria-hidden className="size-3.5" />
                            {data ? `${data.pipeline.name} · live` : 'Loading the pipeline'}
                        </span>
                    </div>
                    <h2 className="m-0 text-3xl font-semibold tracking-tight">Welcome back{name ? `, ${name}` : ''}</h2>
                    {data ? (
                        <p className="m-0 mt-3 text-base leading-7 text-text-muted">
                            Here's how your pipeline is performing today —{' '}
                            <b className="font-semibold text-text">{openCount}</b> open{' '}
                            {openCount === 1 ? 'deal' : 'deals'} worth{' '}
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
                        <Skeleton className="mt-3 h-6 w-96" />
                    )}
                    <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border/60 pt-5">
                        <HeroStat
                            label="Pipeline value"
                            value={data ? money(sumOf(open(data), currency).amountMinor) : '…'}
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
                </div>
                <div className="flex flex-col items-end gap-3">
                    <div className="flex gap-2">
                        <Button asChild variant="secondary">
                            <Link to={paths.deals(workspaceId)}>
                                <ExternalLink aria-hidden /> Open pipeline
                            </Link>
                        </Button>
                        <Button variant="primary" loading={board.isFetching} onClick={() => void board.refetch()}>
                            <RefreshCw aria-hidden /> Refresh data
                        </Button>
                    </div>
                    <span className="text-sm text-text-muted">{today}</span>
                </div>
            </CardContent>
        </Card>
    );
}

function HeroStat({ label, value, dot = false }: { label: string; value: string; dot?: boolean }) {
    return (
        <div className="border-r border-border/60 pr-6 last:border-r-0">
            <div className="text-[11px] font-medium tracking-wide text-text-muted uppercase">{label}</div>
            <div className="mt-1 flex items-center gap-1.5 text-2xl font-semibold tracking-tight tabular-nums">
                {dot && <span aria-hidden className="size-1.5 rounded-full bg-success" />}
                {value}
            </div>
        </div>
    );
}
