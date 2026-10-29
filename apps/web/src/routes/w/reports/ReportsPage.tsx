import {
    Avatar,
    Badge,
    BarChart,
    Button,
    CHART_BGS,
    CHART_TEXT,
    Card,
    CardContent,
    CardFooter,
    CardHeader,
    CardTitle,
    Delta,
    DistributionBar,
    DonutChart,
    Input,
    LoadingRegion,
    PageHeader,
    Skeleton,
    Sparkline,
    StackedBarChart,
    cn,
    toneSolid,
} from '@bylinecrm/ui';
import {
    Activity,
    AlertTriangle,
    ArrowUpRight,
    CalendarCheck,
    CircleDollarSign,
    ExternalLink,
    Handshake,
    RefreshCw,
    Search,
    Target,
    Timer,
    TrendingUp,
    UserPlus,
    UsersRound,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useDefaultBoard } from '../../../api/deals';
import { useMeetingKpis } from '../../../api/meetings';
import { useProfile } from '../../../api/queries';
import { useMembers } from '../../../api/team';
import type { OpportunityView } from '../../../api/types';
import { formatMoneyCompact } from '../../../lib/money';
import { formatRelative } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { STAGE_TONES } from '../deals/dealsView';
import { periodBounds } from '../team/TeamPage';
import {
    atRisk,
    averageCycleDays,
    averageDaysInStage,
    boardCurrency,
    byMonth,
    bySource,
    count,
    deals,
    forecast,
    lastMonths,
    lost,
    open,
    percentChange,
    probabilityOf,
    sumOf,
    winRate,
    won,
    wonByOwner,
} from './reportsData';

const compact = (currency: string) => (amountMinor: number) => formatMoneyCompact({ amountMinor, currency });

/**
 * Reports: the pipeline's performance, health and the team's results, every figure from the API.
 * The stage counts and sums are exact; lists, months and sources are read from the deals the
 * board loaded, and the page says so where it matters.
 */
export function ReportsPage() {
    const workspaceId = useWorkspaceId();
    const { board } = useDefaultBoard(workspaceId);
    const data = board.data;
    const currency = boardCurrency(data);
    const money = compact(currency);
    const months = useMemo(() => lastMonths(9), []);
    const wonDeals = deals(won(data));
    const lostDeals = deals(lost(data));
    const wonMonthly = byMonth(wonDeals, (d) => d.closedAt, months, currency);
    const lostMonthly = byMonth(lostDeals, (d) => d.closedAt, months, currency);
    const newMonthly = byMonth(deals(data?.columns ?? []), (d) => d.createdAt, months, currency);
    const last = months.length - 1;
    const revenueChange = percentChange(wonMonthly.amounts[last - 1] ?? 0, wonMonthly.amounts[last] ?? 0);
    const wonChange = percentChange(wonMonthly.counts[last - 1] ?? 0, wonMonthly.counts[last] ?? 0);
    const newChange = percentChange(newMonthly.counts[last - 1] ?? 0, newMonthly.counts[last] ?? 0);
    const risky = atRisk(data);
    const rate = winRate(data);
    const cycle = averageCycleDays(data);

    return (
        <div className="flex flex-col gap-4 p-4 md:p-6">
            <PageHeader
                className="mb-0 border-b border-border pb-4"
                title="Reports"
                chip={
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-text-muted">
                        <span aria-hidden className="size-1.5 rounded-full bg-success" />
                        Live
                    </span>
                }
                subtitle="Monitor sales performance, pipeline health and team results."
                actions={
                    <Button
                        variant="secondary"
                        size="sm"
                        loading={board.isFetching}
                        onClick={() => void board.refetch()}
                    >
                        <RefreshCw aria-hidden /> Refresh
                    </Button>
                }
            >
                {board.dataUpdatedAt > 0 && (
                    <p className="m-0 mt-2 flex items-center gap-1.5 text-xs text-text-muted">
                        <RefreshCw aria-hidden className="size-3" />
                        Updated {formatRelative(new Date(board.dataUpdatedAt).toISOString())}
                    </p>
                )}
            </PageHeader>

            <WelcomeCard workspaceId={workspaceId} money={money} currency={currency} />

            <div className="grid grid-cols-12 gap-4">
                <ReportKpi
                    className="col-span-12 md:col-span-6 xl:col-span-3"
                    icon={<CircleDollarSign />}
                    tone="success"
                    label="Total revenue"
                    value={data ? money(sumOf(won(data), currency).amountMinor) : null}
                    change={revenueChange}
                    spark={
                        <Sparkline values={wonMonthly.amounts} label="Won revenue by month" className={CHART_TEXT[2]} />
                    }
                    rows={[
                        ['Deals won', count(won(data)).toLocaleString()],
                        [
                            'Average deal',
                            wonDeals.length
                                ? money(sumOf(won(data), currency).amountMinor / Math.max(count(won(data)), 1))
                                : '—',
                        ],
                    ]}
                />
                <ReportKpi
                    className="col-span-12 md:col-span-6 xl:col-span-3"
                    icon={<Handshake />}
                    tone="info"
                    label="Deals won"
                    value={data ? count(won(data)).toLocaleString() : null}
                    change={wonChange}
                    spark={
                        <Sparkline values={wonMonthly.counts} label="Deals won by month" className={CHART_TEXT[0]} />
                    }
                    rows={[
                        ['This month', (wonMonthly.counts[last] ?? 0).toLocaleString()],
                        ['Win rate', rate === null ? '—' : `${rate}%`],
                    ]}
                />
                <PipelineHealthCard className="col-span-12 xl:col-span-6" money={money} currency={currency} />
            </div>

            <div className="grid grid-cols-12 gap-4">
                <ReportKpi
                    className="col-span-12 md:col-span-6 xl:col-span-3"
                    icon={<UserPlus />}
                    tone="info"
                    label="New deals"
                    value={data ? (newMonthly.counts[last] ?? 0).toLocaleString() : null}
                    change={newChange}
                    spark={
                        <Sparkline values={newMonthly.counts} label="New deals by month" className={CHART_TEXT[0]} />
                    }
                    footnote="created this month, from the deals on the board"
                />
                <ReportKpi
                    className="col-span-12 md:col-span-6 xl:col-span-3"
                    icon={<AlertTriangle />}
                    tone="warning"
                    label="At-risk deals"
                    value={data ? risky.length.toLocaleString() : null}
                    footnote="overdue a touch, or past their stage's threshold"
                />
                <ReportKpi
                    className="col-span-12 md:col-span-6 xl:col-span-3"
                    icon={<Timer />}
                    tone="accent"
                    label="Average sales cycle"
                    value={data ? (cycle === null ? '—' : `${cycle} ${cycle === 1 ? 'day' : 'days'}`) : null}
                    footnote="from creation to close, over the deals closed"
                />
                <MeetingsKpi workspaceId={workspaceId} className="col-span-12 md:col-span-6 xl:col-span-3" />
            </div>

            <div className="grid grid-cols-12 gap-4">
                <TopDealsCard workspaceId={workspaceId} className="col-span-12 xl:col-span-8" money={money} />
                <Card className="col-span-12 gap-4 xl:col-span-4">
                    <CardHeader>
                        <CardTitle className="text-base">Pipeline by stage</CardTitle>
                        <p className="m-0 text-sm text-text-muted">Current opportunity distribution</p>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        {!data ? (
                            <LoadingRegion label="Loading stages">
                                <Skeleton className="h-56" />
                            </LoadingRegion>
                        ) : (
                            <>
                                <div className="flex items-end justify-between border-b border-border pb-3">
                                    <div>
                                        <div className="text-2xl font-semibold tracking-tight tabular-nums">
                                            {money(sumOf(open(data), currency).amountMinor)}
                                        </div>
                                        <div className="text-xs text-text-muted">Active pipeline value</div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-lg font-semibold tabular-nums">{count(open(data))}</div>
                                        <div className="text-xs text-text-muted">Open deals</div>
                                    </div>
                                </div>
                                <BarChart
                                    label="Deal value by stage"
                                    format={money}
                                    data={data.columns.map((c) => ({
                                        label: c.stage.name,
                                        value: c.amountMinorByCurrency[currency] ?? 0,
                                        fill: toneSolid[STAGE_TONES[c.stage.colour]],
                                    }))}
                                />
                            </>
                        )}
                    </CardContent>
                </Card>
            </div>

            <div className="grid grid-cols-12 gap-4">
                <Card className="col-span-12 gap-4 lg:col-span-4">
                    <CardHeader>
                        <CardTitle className="text-base">Lead sources</CardTitle>
                        <p className="m-0 text-sm text-text-muted">Where the deals on the board came from</p>
                    </CardHeader>
                    <CardContent>
                        {!data ? (
                            <Skeleton className="h-56" />
                        ) : (
                            <DonutChart
                                label="Deals by lead source"
                                data={bySource(deals(data.columns)).slice(0, 5)}
                                total={deals(data.columns).length.toLocaleString()}
                                totalLabel="deals"
                            />
                        )}
                    </CardContent>
                </Card>
                <TeamCard workspaceId={workspaceId} className="col-span-12 lg:col-span-4" />
                <TopOpenDealsCard workspaceId={workspaceId} className="col-span-12 lg:col-span-4" money={money} />
            </div>

            <div className="grid grid-cols-12 gap-4">
                <Card className="col-span-12 gap-4">
                    <CardHeader className="flex flex-row items-start justify-between">
                        <div>
                            <CardTitle className="text-base">Won vs lost</CardTitle>
                            <p className="m-0 mt-1 text-sm text-text-muted">Deal outcomes by month they closed</p>
                        </div>
                        <div className="text-right">
                            <div className="text-2xl font-semibold tracking-tight tabular-nums">
                                {rate === null ? '—' : `${rate}%`}
                            </div>
                            <div className="text-xs text-text-muted">Win rate</div>
                        </div>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border">
                            <Stat dot={CHART_BGS[2]} label="Won" value={count(won(data)).toLocaleString()} />
                            <Stat dot={CHART_BGS[4]} label="Lost" value={count(lost(data)).toLocaleString()} />
                            <Stat label="Best month" value={bestMonth(months, wonMonthly.counts)} />
                        </div>
                        {!data ? (
                            <Skeleton className="h-52" />
                        ) : (
                            <StackedBarChart
                                label="Won and lost deals by month"
                                format={(n) => n.toLocaleString()}
                                series={[
                                    { name: 'Won deals', fill: 'fill-chart-3', bg: CHART_BGS[2] },
                                    { name: 'Lost deals', fill: 'fill-chart-5', bg: CHART_BGS[4] },
                                ]}
                                data={months.map((m, i) => ({
                                    label: m.label,
                                    values: [wonMonthly.counts[i] ?? 0, lostMonthly.counts[i] ?? 0],
                                }))}
                            />
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

function bestMonth(months: readonly { label: string }[], counts: readonly number[]): ReactNode {
    let best = -1;
    counts.forEach((c, i) => {
        if (c > (counts[best] ?? 0)) best = i;
    });
    if (best < 0 || (counts[best] ?? 0) === 0) return '—';
    return (
        <>
            {months[best]!.label} <span className="text-sm font-normal text-text-muted">· {counts[best]} won</span>
        </>
    );
}

function Stat({ dot, label, value }: { dot?: string; label: string; value: ReactNode }) {
    return (
        <div className="px-4 py-3">
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
                {dot && <span aria-hidden className={cn('size-2 rounded-full', dot)} />}
                {label}
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
        </div>
    );
}

/** The welcome band: who, how the pipeline is doing in a sentence, three numbers, the team. */
function WelcomeCard({
    workspaceId,
    money,
    currency,
}: {
    workspaceId: string;
    money: (n: number) => string;
    currency: string;
}) {
    const profile = useProfile();
    const members = useMembers(workspaceId);
    const { board } = useDefaultBoard(workspaceId);
    const data = board.data;
    const name = profile.data?.displayName ?? profile.data?.email ?? '';
    const openCount = count(open(data));
    const risky = atRisk(data).length;
    const today = new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
    const team = (members.data ?? []).map((m) => m.displayName ?? m.email);
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
                            {risky > 0 ? (
                                <>
                                    , with <b className="font-semibold text-text">{risky}</b> needing your attention.
                                </>
                            ) : (
                                ', and nothing overdue.'
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

/** A report tile: icon, label, big number, change chip, a sparkline and two footer rows. */
function ReportKpi({
    className,
    icon,
    tone,
    label,
    value,
    change,
    spark,
    rows,
    footnote,
}: {
    className?: string | undefined;
    icon: ReactNode;
    tone: 'success' | 'info' | 'warning' | 'accent' | 'danger';
    label: string;
    value: ReactNode | null;
    change?: number | null;
    spark?: ReactNode;
    rows?: readonly [string, string][];
    footnote?: string;
}) {
    return (
        <Card className={cn('gap-4', className)}>
            <CardContent className="flex flex-col gap-4">
                <div className="flex items-start justify-between">
                    <span className="grid size-11 place-items-center rounded-lg border border-border bg-surface p-0.5 shadow-sm">
                        <span
                            aria-hidden
                            className={cn(
                                'grid size-full place-items-center rounded-md text-primary-foreground [&_svg]:size-5',
                                toneSolid[tone],
                            )}
                        >
                            {icon}
                        </span>
                    </span>
                    {change !== undefined && change !== null && (
                        <Delta direction={change >= 0 ? 'up' : 'down'}>{Math.abs(change)}%</Delta>
                    )}
                </div>
                <div>
                    <div className="text-sm text-text-muted">{label}</div>
                    {value === null ? (
                        <Skeleton className="mt-1 h-8 w-24" />
                    ) : (
                        <div className="text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
                    )}
                </div>
                {spark}
                {rows && (
                    <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
                        {rows.map(([k, v]) => (
                            <div key={k} className="contents">
                                <dt className="text-text-muted">{k}</dt>
                                <dd className="m-0 text-right font-medium tabular-nums">{v}</dd>
                            </div>
                        ))}
                    </dl>
                )}
                {footnote && <p className="m-0 text-xs text-text-muted">{footnote}</p>}
            </CardContent>
        </Card>
    );
}

/** Meetings held this month, from the team's meeting KPIs. */
function MeetingsKpi({ workspaceId, className }: { workspaceId: string; className?: string }) {
    const bounds = useMemo(() => periodBounds('month'), []);
    const kpis = useMeetingKpis(workspaceId, bounds);
    const rows = kpis.data?.rows ?? [];
    const held = rows.reduce((n, r) => n + r.held, 0);
    const booked = rows.reduce((n, r) => n + r.booked, 0);
    return (
        <ReportKpi
            className={className}
            icon={<CalendarCheck />}
            tone="danger"
            label="Meetings held"
            value={kpis.data ? held.toLocaleString() : kpis.isError ? '—' : null}
            footnote={kpis.data ? `${booked.toLocaleString()} booked this month` : 'this month'}
        />
    );
}

/** The pipeline's health: its value split by open stage, and four figures beneath. */
function PipelineHealthCard({
    className,
    money,
    currency,
}: {
    className?: string;
    money: (n: number) => string;
    currency: string;
}) {
    const workspaceId = useWorkspaceId();
    const { board } = useDefaultBoard(workspaceId);
    const data = board.data;
    const stages = open(data);
    const rate = winRate(data);
    return (
        <Card className={cn('gap-4', className)}>
            <CardHeader className="flex flex-row items-center gap-3">
                <span className="grid size-11 place-items-center rounded-lg border border-border bg-surface p-0.5 shadow-sm">
                    <span
                        aria-hidden
                        className="grid size-full place-items-center rounded-md bg-primary text-primary-foreground [&_svg]:size-5"
                    >
                        <Activity />
                    </span>
                </span>
                <CardTitle className="text-base">Sales pipeline health</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
                {!data ? (
                    <LoadingRegion label="Loading the pipeline">
                        <Skeleton className="h-24" />
                    </LoadingRegion>
                ) : (
                    <>
                        <div>
                            <div className="mb-2.5 flex items-center justify-between text-sm">
                                <span className="font-medium">Pipeline distribution</span>
                                <span className="text-text-muted">by open deal value</span>
                            </div>
                            <DistributionBar
                                items={stages.map((c) => ({
                                    name: c.stage.name,
                                    value: c.amountMinorByCurrency[currency] ?? 0,
                                    bg: toneSolid[STAGE_TONES[c.stage.colour]],
                                }))}
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                            <MiniStat icon={<Target />} label="Open deals" value={count(stages).toLocaleString()} />
                            <MiniStat icon={<Handshake />} label="Win rate" value={rate === null ? '—' : `${rate}%`} />
                            <MiniStat
                                icon={<TrendingUp />}
                                label="Forecast"
                                value={money(forecast(data, currency).amountMinor)}
                            />
                            <MiniStat icon={<Timer />} label="Avg. in stage" value={`${averageDaysInStage(data)}d`} />
                        </div>
                    </>
                )}
            </CardContent>
        </Card>
    );
}

function MiniStat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
    return (
        <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between text-xs text-text-muted [&_svg]:size-4">
                {label}
                <span aria-hidden>{icon}</span>
            </div>
            <div className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</div>
        </div>
    );
}

/** The open deals worth the most, searchable, with stage, value, forecast and the odds. */
function TopDealsCard({
    workspaceId,
    className,
    money,
}: {
    workspaceId: string;
    className?: string;
    money: (n: number) => string;
}) {
    const { board } = useDefaultBoard(workspaceId);
    const data = board.data;
    const [q, setQ] = useState('');
    const rows = useMemo(() => {
        const term = q.trim().toLowerCase();
        return deals(open(data))
            .filter((d) => !term || d.name.toLowerCase().includes(term) || d.company?.name.toLowerCase().includes(term))
            .sort((a, b) => (b.amount?.amountMinor ?? 0) - (a.amount?.amountMinor ?? 0))
            .slice(0, 6);
    }, [data, q]);
    const stageOf = (d: OpportunityView) => data?.columns.find((c) => c.stage.id === d.stageId)?.stage;
    return (
        <Card className={cn('gap-0 py-0', className)}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b border-border py-5">
                <div>
                    <CardTitle className="text-base">Top performing deals</CardTitle>
                    <p className="m-0 mt-1 text-sm text-text-muted">Highest-value open opportunities</p>
                </div>
                <label className="relative block w-full max-w-72">
                    <Search
                        aria-hidden
                        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-faint"
                    />
                    <Input
                        aria-label="Search deals"
                        placeholder="Search deals…"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        className="pl-9"
                    />
                </label>
            </CardHeader>
            <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                    <thead>
                        <tr className="text-left text-xs text-text-muted">
                            <th className="px-6 py-3 font-medium">Deal</th>
                            <th className="px-3 py-3 font-medium">Stage</th>
                            <th className="px-3 py-3 text-right font-medium">Value</th>
                            <th className="px-3 py-3 text-right font-medium">Forecast</th>
                            <th className="px-6 py-3 text-right font-medium">Win</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border border-t border-border">
                        {!data ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-6">
                                    <Skeleton className="h-6" />
                                </td>
                            </tr>
                        ) : rows.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-8 text-center text-text-muted">
                                    No open deals{q ? ' match' : ' yet'}.
                                </td>
                            </tr>
                        ) : (
                            rows.map((d) => {
                                const stage = stageOf(d);
                                const p = probabilityOf(d, data);
                                return (
                                    <tr key={d.id} className="hover:bg-surface-raised/60">
                                        <td className="px-6 py-3">
                                            <Link
                                                to={paths.deal(workspaceId, d.id)}
                                                className="font-semibold hover:underline"
                                            >
                                                {d.name}
                                            </Link>
                                            <div className="text-xs text-text-muted">
                                                {[d.company?.name, d.owner?.name].filter(Boolean).join(' · ') || '—'}
                                            </div>
                                        </td>
                                        <td className="px-3 py-3">
                                            {stage && (
                                                <Badge dot status={STAGE_TONES[stage.colour]} shape="pill">
                                                    {stage.name}
                                                </Badge>
                                            )}
                                        </td>
                                        <td className="px-3 py-3 text-right font-semibold tabular-nums">
                                            {d.amount ? money(d.amount.amountMinor) : '—'}
                                        </td>
                                        <td className="px-3 py-3 text-right text-text-muted tabular-nums">
                                            {d.amount ? money(Math.round((d.amount.amountMinor * p) / 100)) : '—'}
                                        </td>
                                        <td className="px-6 py-3">
                                            <div className="flex items-center justify-end gap-2">
                                                <span className="h-1 w-16 overflow-hidden rounded-full bg-surface-raised">
                                                    <span
                                                        className="block h-full rounded-full bg-primary"
                                                        style={{ width: `${p}%` }}
                                                    />
                                                </span>
                                                <span className="w-9 text-right text-text-muted tabular-nums">
                                                    {p}%
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>
            <CardFooter className="border-t border-border py-3 text-xs text-text-muted">
                Forecast = deal value × win probability, from the deals on the board.
            </CardFooter>
        </Card>
    );
}

/** Members ranked by deals won, with a way to each one's record of meetings. */
function TeamCard({ workspaceId, className }: { workspaceId: string; className?: string }) {
    const { board } = useDefaultBoard(workspaceId);
    const rows = wonByOwner(board.data).slice(0, 5);
    return (
        <Card className={cn('gap-0 py-0', className)}>
            <CardHeader className="flex flex-row items-center justify-between border-b border-border py-5">
                <div>
                    <CardTitle className="text-base">Top performing team</CardTitle>
                    <p className="m-0 mt-1 text-sm text-text-muted">Deals won, by owner</p>
                </div>
                <Button asChild variant="secondary" size="sm">
                    <Link to={paths.team(workspaceId)}>
                        View all <ArrowUpRight aria-hidden />
                    </Link>
                </Button>
            </CardHeader>
            <CardContent className="px-0">
                {!board.data ? (
                    <Skeleton className="m-6 h-24" />
                ) : rows.length === 0 ? (
                    <p className="m-0 px-6 py-8 text-center text-sm text-text-muted">No deals won yet.</p>
                ) : (
                    <>
                        <div className="grid grid-cols-[1fr_auto] px-6 py-2.5 text-[11px] font-medium tracking-wide text-text-muted uppercase">
                            <span>Team member</span>
                            <span>Won</span>
                        </div>
                        <ul className="m-0 list-none divide-y divide-border border-t border-border p-0">
                            {rows.map((r) => (
                                <li key={r.id} className="flex items-center gap-3 px-6 py-3">
                                    <Avatar name={r.name} size="md" />
                                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{r.name}</span>
                                    <span className="text-right">
                                        <span className="block text-sm font-semibold tabular-nums">{r.won}</span>
                                        <span className="block text-[11px] text-text-muted">
                                            {r.won === 1 ? 'deal' : 'deals'}
                                        </span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </CardContent>
            <CardFooter className="border-t border-border py-4">
                <Button asChild variant="secondary" className="w-full">
                    <Link to={paths.team(workspaceId)}>
                        <UsersRound aria-hidden /> View all team members
                    </Link>
                </Button>
            </CardFooter>
        </Card>
    );
}

/** The largest opportunities still in play, each with its odds. */
function TopOpenDealsCard({
    workspaceId,
    className,
    money,
}: {
    workspaceId: string;
    className?: string;
    money: (n: number) => string;
}) {
    const { board } = useDefaultBoard(workspaceId);
    const data = board.data;
    const rows = deals(open(data))
        .filter((d) => d.amount)
        .sort((a, b) => (b.amount?.amountMinor ?? 0) - (a.amount?.amountMinor ?? 0))
        .slice(0, 5);
    const stageOf = (d: OpportunityView) => data?.columns.find((c) => c.stage.id === d.stageId)?.stage;
    return (
        <Card className={cn('gap-4', className)}>
            <CardHeader className="flex flex-row items-center justify-between">
                <div>
                    <CardTitle className="text-base">Top open deals</CardTitle>
                    <p className="m-0 mt-1 text-sm text-text-muted">Largest opportunities still in play</p>
                </div>
                {data && (
                    <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-text-muted">
                        {count(open(data))} {count(open(data)) === 1 ? 'deal' : 'deals'}
                    </span>
                )}
            </CardHeader>
            <CardContent>
                {!data ? (
                    <Skeleton className="h-40" />
                ) : rows.length === 0 ? (
                    <p className="m-0 py-6 text-center text-sm text-text-muted">No open deals with an amount yet.</p>
                ) : (
                    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                        {rows.map((d) => {
                            const stage = stageOf(d);
                            const p = probabilityOf(d, data);
                            const tone = STAGE_TONES[stage?.colour ?? 'neutral'];
                            return (
                                <li key={d.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
                                    <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-raised text-text-muted [&_svg]:size-4">
                                        <Handshake aria-hidden />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <Link
                                            to={paths.deal(workspaceId, d.id)}
                                            className="block truncate text-sm font-semibold hover:underline"
                                        >
                                            {d.name}
                                        </Link>
                                        <div className="flex items-center gap-1.5 text-xs text-text-muted">
                                            {d.company?.name && <span className="truncate">{d.company.name}</span>}
                                            {stage && (
                                                <>
                                                    <span aria-hidden>•</span>
                                                    <Badge status={tone} className="h-auto px-1.5 py-0 text-[11px]">
                                                        {stage.name}
                                                    </Badge>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-sm font-semibold tabular-nums">
                                            {money(d.amount!.amountMinor)}
                                        </div>
                                        <div className="mt-1 flex items-center justify-end gap-1.5">
                                            <span className="h-1 w-14 overflow-hidden rounded-full bg-surface-raised">
                                                <span
                                                    className={cn('block h-full rounded-full', toneSolid[tone])}
                                                    style={{ width: `${p}%` }}
                                                />
                                            </span>
                                            <span className="text-[11px] text-text-muted tabular-nums">{p}%</span>
                                        </div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}
