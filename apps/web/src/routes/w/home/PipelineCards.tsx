import {
    Badge,
    Button,
    Card,
    CardContent,
    CardFooter,
    CardHeader,
    CardTitle,
    KpiCard,
    LoadingRegion,
    Skeleton,
    cn,
    toneSolid,
} from '@bylinecrm/ui';
import { Building2, CircleDollarSign, Handshake, TrendingUp, Users } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useDefaultBoard } from '../../../api/deals';
import { useViewCounts } from '../../../api/lists';
import type { BoardColumn, BoardView, OpportunityView } from '../../../api/types';
import { formatMoneyCompact, formatSums } from '../../../lib/money';
import { paths, withCreate } from '../../paths';
import { STAGE_TONES } from '../deals/dealsView';

/** Each column's exact sum in the board's one currency, when it has one; `null` when currencies mix. */
function sumMinor(columns: readonly BoardColumn[]): { amountMinor: number; currency: string } | null {
    let currency: string | undefined;
    let amountMinor = 0;
    for (const column of columns) {
        for (const [c, minor] of Object.entries(column.amountMinorByCurrency)) {
            if (currency !== undefined && currency !== c) return null;
            currency = c;
            amountMinor += minor;
        }
    }
    return currency === undefined ? { amountMinor: 0, currency: 'USD' } : { amountMinor, currency };
}

function money(sum: { amountMinor: number; currency: string } | null, columns: readonly BoardColumn[]): string {
    if (sum) return formatMoneyCompact(sum);
    const merged: Record<string, number> = {};
    for (const column of columns)
        for (const [c, minor] of Object.entries(column.amountMinorByCurrency)) merged[c] = (merged[c] ?? 0) + minor;
    return formatSums(merged);
}

const skeletonKpi = (
    <div className="h-33.5 rounded-xl border border-border bg-surface shadow-sm">
        <Skeleton className="m-6 h-4 w-24" />
    </div>
);

/** The four tiles: people, open deals, pipeline value, won revenue — all counted by the API. */
export function DashboardKpis({ workspaceId }: { workspaceId: string }) {
    const counts = useViewCounts(workspaceId, 'person', [undefined]);
    const companies = useViewCounts(workspaceId, 'company', [undefined]);
    const { board } = useDefaultBoard(workspaceId);
    const columns = board.data?.columns ?? [];
    const open = columns.filter((c) => c.stage.kind === 'open');
    const won = columns.filter((c) => c.stage.kind === 'won');
    const openCount = open.reduce((n, c) => n + c.count, 0);
    const wonCount = won.reduce((n, c) => n + c.count, 0);
    const people = counts.get(undefined);
    const companyCount = companies.get(undefined);
    const ready = board.data || board.isError;
    return (
        <div className="grid grid-cols-12 gap-4">
            <div className="col-span-12 sm:col-span-6 xl:col-span-3">
                {people ? (
                    <KpiCard
                        icon={<Users />}
                        tone="info"
                        label="People"
                        value={people.total.toLocaleString() + (people.exact ? '' : '+')}
                        footnote={companyCount ? `across ${companyCount.total.toLocaleString()} companies` : undefined}
                    />
                ) : (
                    skeletonKpi
                )}
            </div>
            <div className="col-span-12 sm:col-span-6 xl:col-span-3">
                {ready ? (
                    <KpiCard
                        icon={<Handshake />}
                        tone="accent"
                        label="Open deals"
                        value={openCount.toLocaleString()}
                        footnote={`in ${open.length} ${open.length === 1 ? 'stage' : 'stages'}`}
                    />
                ) : (
                    skeletonKpi
                )}
            </div>
            <div className="col-span-12 sm:col-span-6 xl:col-span-3">
                {ready ? (
                    <KpiCard
                        icon={<TrendingUp />}
                        tone="success"
                        label="Pipeline value"
                        value={money(sumMinor(open), open)}
                        footnote="open deals, at face value"
                    />
                ) : (
                    skeletonKpi
                )}
            </div>
            <div className="col-span-12 sm:col-span-6 xl:col-span-3">
                {ready ? (
                    <KpiCard
                        icon={<CircleDollarSign />}
                        tone="warning"
                        label="Won revenue"
                        value={money(sumMinor(won), won)}
                        footnote={`${wonCount.toLocaleString()} ${wonCount === 1 ? 'deal' : 'deals'} won`}
                    />
                ) : (
                    skeletonKpi
                )}
            </div>
        </div>
    );
}

/** A three-dot header menu is the template's; here the header is the title and a chip. */
function CardHead({ title, chip }: { title: string; chip?: string | undefined }) {
    return (
        <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
                <CardTitle>{title}</CardTitle>
                {chip && (
                    <span className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[11px] font-medium text-text-muted">
                        {chip}
                    </span>
                )}
            </div>
        </CardHeader>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-xs text-text-muted">{label}</span>
            <span className="text-sm font-semibold tabular-nums">{value}</span>
        </div>
    );
}

/** The open deals worth the most, as the board's first page shows them. */
function topDeals(columns: readonly BoardColumn[], n: number): OpportunityView[] {
    return columns
        .filter((c) => c.stage.kind === 'open')
        .flatMap((c) => c.deals)
        .filter((d) => d.amount)
        .sort((a, b) => (b.amount?.amountMinor ?? 0) - (a.amount?.amountMinor ?? 0))
        .slice(0, n);
}

/**
 * The pipeline at a glance: its value, open deals, the average time a deal has sat in its stage,
 * the three biggest open deals, and the ways into the board.
 */
export function PipelinePulseCard({ workspaceId, className }: { workspaceId: string; className?: string }) {
    const { board } = useDefaultBoard(workspaceId);
    const data = board.data;
    const columns = data?.columns ?? [];
    const open = columns.filter((c) => c.stage.kind === 'open');
    const openDeals = open.flatMap((c) => c.deals);
    const avgDays = openDeals.length
        ? Math.round(openDeals.reduce((n, d) => n + d.daysInStage, 0) / openDeals.length)
        : 0;
    const stageOf = (deal: OpportunityView) => columns.find((c) => c.stage.id === deal.stageId)?.stage;
    const top = topDeals(columns, 3);
    return (
        <Card className={cn('gap-4', className)}>
            <CardHead title="Pipeline pulse" chip={data?.pipeline.name} />
            <CardContent className="flex flex-1 flex-col gap-4">
                {!data ? (
                    <LoadingRegion label="Loading the pipeline" className="grid gap-2">
                        <Skeleton className="h-5" />
                        <Skeleton className="h-5" />
                        <Skeleton className="h-5" />
                    </LoadingRegion>
                ) : (
                    <>
                        <div className="divide-y divide-border">
                            <Metric label="Pipeline value" value={money(sumMinor(open), open)} />
                            <Metric label="Open deals" value={open.reduce((n, c) => n + c.count, 0).toString()} />
                            <Metric label="Avg. time in stage" value={`${avgDays} ${avgDays === 1 ? 'day' : 'days'}`} />
                        </div>
                        <div className="rounded-lg bg-surface-raised p-4">
                            <p className="m-0 mb-2 text-sm font-semibold">Deals in motion</p>
                            {top.length === 0 ? (
                                <p className="m-0 text-xs text-text-muted">No open deals with an amount yet.</p>
                            ) : (
                                <ul className="m-0 list-none divide-y divide-border p-0">
                                    {top.map((deal) => {
                                        const stage = stageOf(deal);
                                        return (
                                            <li key={deal.id} className="flex items-center gap-3 py-2">
                                                <div className="min-w-0 flex-1">
                                                    <Link
                                                        to={paths.deal(workspaceId, deal.id)}
                                                        className="block truncate text-sm font-medium hover:underline"
                                                    >
                                                        {deal.name}
                                                    </Link>
                                                    {deal.company && (
                                                        <span className="block truncate text-xs text-text-muted">
                                                            {deal.company.name}
                                                        </span>
                                                    )}
                                                </div>
                                                <span className="text-sm font-semibold tabular-nums">
                                                    {formatMoneyCompact(deal.amount)}
                                                </span>
                                                {stage && (
                                                    <Badge status={STAGE_TONES[stage.colour]} shape="pill">
                                                        {stage.name}
                                                    </Badge>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </>
                )}
            </CardContent>
            <CardFooter className="grid grid-cols-2 gap-3">
                <Button asChild variant="secondary" className="w-full">
                    <Link to={withCreate(paths.deals(workspaceId))}>New deal</Link>
                </Button>
                <Button asChild variant="primary" className="w-full">
                    <Link to={paths.deals(workspaceId)}>Open pipeline</Link>
                </Button>
            </CardFooter>
        </Card>
    );
}

/** One bar per stage, in the pipeline's order, sized against the fullest stage. */
export function DealsByStageCard({ workspaceId, className }: { workspaceId: string; className?: string }) {
    const { board } = useDefaultBoard(workspaceId);
    const columns = board.data?.columns ?? [];
    const max = Math.max(1, ...columns.map((c) => c.count));
    return (
        <Card className={cn('gap-4', className)}>
            <CardHead title="Deals by stage" />
            <CardContent>
                {!board.data ? (
                    <LoadingRegion label="Loading stages" className="grid gap-2.5">
                        <Skeleton className="h-4" />
                        <Skeleton className="h-4" />
                        <Skeleton className="h-4" />
                    </LoadingRegion>
                ) : (
                    <ul className="m-0 list-none space-y-2.5 p-0">
                        {columns.map((column) => {
                            const tone = STAGE_TONES[column.stage.colour];
                            return (
                                <li key={column.stage.id} className="flex items-center gap-3">
                                    <span className="flex w-28 shrink-0 items-center gap-2">
                                        <span
                                            aria-hidden
                                            className={cn('size-2 shrink-0 rounded-full', toneSolid[tone])}
                                        />
                                        <span className="truncate text-xs font-medium">{column.stage.name}</span>
                                    </span>
                                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-raised">
                                        <span
                                            className={cn('block h-full rounded-full', toneSolid[tone])}
                                            style={{ width: `${(column.count / max) * 100}%` }}
                                        />
                                    </span>
                                    <span className="w-8 shrink-0 text-right text-sm font-medium text-text-muted tabular-nums">
                                        {column.count}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

/** Companies ranked by the open deal value against them, from the board's loaded cards. */
export function TopCompaniesCard({ workspaceId, className }: { workspaceId: string; className?: string }) {
    const { board } = useDefaultBoard(workspaceId);
    const rows = useMemo(() => rankCompanies(board.data), [board.data]);
    const max = rows[0]?.amountMinor ?? 1;
    return (
        <Card className={cn('gap-4', className)}>
            <CardHead title="Top companies" chip="by open value" />
            <CardContent>
                {!board.data ? (
                    <LoadingRegion label="Loading companies" className="grid gap-2.5">
                        <Skeleton className="h-6" />
                        <Skeleton className="h-6" />
                    </LoadingRegion>
                ) : rows.length === 0 ? (
                    <p className="m-0 text-xs text-text-muted">No open deals are linked to a company yet.</p>
                ) : (
                    <ol className="m-0 list-none divide-y divide-border p-0">
                        {rows.slice(0, 5).map((row, i) => (
                            <li key={row.id} className="flex items-center gap-3 py-2.5">
                                <span className="w-4 text-xs text-text-muted tabular-nums">{i + 1}</span>
                                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-raised text-text-muted [&_svg]:size-3.5">
                                    <Building2 aria-hidden />
                                </span>
                                <Link
                                    to={paths.company(workspaceId, row.id)}
                                    className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                                >
                                    {row.label}
                                </Link>
                                <span className="text-sm font-semibold tabular-nums">
                                    {formatMoneyCompact({ amountMinor: row.amountMinor, currency: row.currency })}
                                </span>
                                <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-surface-raised sm:block">
                                    <span
                                        className="block h-full rounded-full bg-primary"
                                        style={{ width: `${(row.amountMinor / max) * 100}%` }}
                                    />
                                </span>
                            </li>
                        ))}
                    </ol>
                )}
            </CardContent>
        </Card>
    );
}

interface CompanyRow {
    id: string;
    label: string;
    amountMinor: number;
    currency: string;
    deals: number;
}

function rankCompanies(board: BoardView | undefined): CompanyRow[] {
    const byId = new Map<string, CompanyRow>();
    for (const column of board?.columns ?? []) {
        if (column.stage.kind !== 'open') continue;
        for (const deal of column.deals) {
            if (!deal.company) continue;
            const row = byId.get(deal.company.id) ?? {
                id: deal.company.id,
                label: deal.company.name,
                amountMinor: 0,
                currency: deal.amount?.currency ?? deal.currency,
                deals: 0,
            };
            row.deals += 1;
            if (deal.amount && deal.amount.currency === row.currency) row.amountMinor += deal.amount.amountMinor;
            byId.set(row.id, row);
        }
    }
    return [...byId.values()].sort((a, b) => b.amountMinor - a.amountMinor || b.deals - a.deals);
}
