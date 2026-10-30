import { useId, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * The chart kit: small, dependency-free SVG marks drawn from design tokens. Each takes numbers
 * already in the reader's terms and a `format` to name them; identity is never colour alone —
 * every mark has a label or a tooltip, and a legend sits beside any chart with two series or more.
 */

/** The five categorical hues in their fixed order; a sixth series folds into "Other". */
export const CHART_FILLS = ['fill-chart-1', 'fill-chart-2', 'fill-chart-3', 'fill-chart-4', 'fill-chart-5'] as const;
export const CHART_BGS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'] as const;
export const CHART_STROKES = [
    'stroke-chart-1',
    'stroke-chart-2',
    'stroke-chart-3',
    'stroke-chart-4',
    'stroke-chart-5',
] as const;
export const CHART_TEXT = ['text-chart-1', 'text-chart-2', 'text-chart-3', 'text-chart-4', 'text-chart-5'] as const;

export interface SparklineProps {
    values: readonly number[];
    /** A Tailwind text colour; the line and its fade take it through `currentColor`. */
    className?: string;
    /** Named for the reader: "Won revenue by month". */
    label: string;
}

/** A 2px line with a soft fill under it, 100% wide, for a KPI tile; flat when every value is equal. */
export function Sparkline({ values, className, label }: SparklineProps) {
    const id = useId();
    const w = 100;
    const h = 32;
    const n = Math.max(values.length, 2);
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const points = (values.length === 1 ? [values[0]!, values[0]!] : values).map((v, i) => [
        (i / (n - 1)) * w,
        h - 2 - ((v - min) / span) * (h - 4),
    ]);
    const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x!.toFixed(1)} ${y!.toFixed(1)}`).join(' ');
    const area = `${line} L${w} ${h} L0 ${h} Z`;
    return (
        <svg
            role="img"
            aria-label={label}
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="none"
            className={cn('h-12 w-full', className)}
        >
            <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="currentColor" stopOpacity="0.25" />
                    <stop offset="1" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
            </defs>
            <path d={area} fill={`url(#${id})`} />
            <path
                d={line}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

export interface BarDatum {
    label: string;
    value: number;
    /** A Tailwind fill class; defaults to the hue at the datum's index. */
    fill?: string;
}

export interface BarChartProps {
    data: readonly BarDatum[];
    format: (value: number) => string;
    label: string;
    className?: string;
    /** How many gridlines above the baseline. */
    ticks?: number;
}

/** Vertical bars on a dotted plot, each with its value above and its name below; a tooltip on hover. */
export function BarChart({ data, format, label, className, ticks = 4 }: BarChartProps) {
    const [active, setActive] = useState<number | null>(null);
    const max = Math.max(...data.map((d) => d.value), 1);
    return (
        <div className={cn('flex flex-col gap-2', className)}>
            <div
                role="img"
                aria-label={label}
                className="relative grid h-56 grid-cols-[auto_1fr] gap-x-3 text-[11px] text-text-muted"
            >
                <div className="flex flex-col justify-between pb-6 text-right tabular-nums">
                    {Array.from({ length: ticks + 1 }, (_, i) => (
                        <span key={i}>{format((max * (ticks - i)) / ticks)}</span>
                    ))}
                </div>
                <div className="relative pb-6">
                    <div
                        aria-hidden
                        className="absolute inset-x-0 top-0 bottom-6 text-border [background-image:radial-gradient(currentColor_1px,transparent_1px)] [background-size:12px_12px]"
                    />
                    <div aria-hidden className="absolute inset-x-0 top-0 bottom-6 flex flex-col justify-between">
                        {Array.from({ length: ticks + 1 }, (_, i) => (
                            <span key={i} className="block h-px bg-border" />
                        ))}
                    </div>
                    <ul className="relative m-0 flex h-full list-none items-end justify-around gap-2 p-0">
                        {data.map((d, i) => (
                            <li
                                key={d.label}
                                className="relative flex h-full w-full max-w-16 flex-col items-center justify-end"
                                onMouseEnter={() => setActive(i)}
                                onMouseLeave={() => setActive(null)}
                            >
                                <span className="mb-1 text-xs font-semibold text-text tabular-nums">
                                    {format(d.value)}
                                </span>
                                <span
                                    className={cn(
                                        'block w-full rounded-t-[4px] transition-opacity',
                                        d.fill ?? CHART_BGS[i % CHART_BGS.length],
                                        active !== null && active !== i && 'opacity-60',
                                    )}
                                    style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value > 0 ? 4 : 0 }}
                                />
                                <span className="absolute top-full mt-1.5 truncate text-[11px] text-text-muted">
                                    {d.label}
                                </span>
                                {active === i && (
                                    <span
                                        role="tooltip"
                                        className="absolute -top-7 rounded-md border border-border bg-surface px-2 py-1 text-xs whitespace-nowrap text-text shadow-md"
                                    >
                                        {d.label}: {format(d.value)}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>
    );
}

export interface StackedBarDatum {
    label: string;
    /** In series order; each series gets the matching fill. */
    values: readonly number[];
}

export interface StackedBarChartProps {
    data: readonly StackedBarDatum[];
    series: readonly { name: string; fill: string; bg: string }[];
    format: (value: number) => string;
    label: string;
    className?: string;
}

/** Stacked bars with a 2px surface gap between segments, a legend beneath, a tooltip per bar. */
export function StackedBarChart({ data, series, format, label, className }: StackedBarChartProps) {
    const [active, setActive] = useState<number | null>(null);
    const max = Math.max(...data.map((d) => d.values.reduce((a, b) => a + b, 0)), 1);
    return (
        <div className={cn('flex flex-col gap-3', className)}>
            <div
                role="img"
                aria-label={label}
                className="relative grid h-52 grid-cols-[auto_1fr] gap-x-3 text-[11px] text-text-muted"
            >
                <div className="flex flex-col justify-between pb-6 text-right tabular-nums">
                    {[4, 3, 2, 1, 0].map((i) => (
                        <span key={i}>{Number.isInteger((max * i) / 4) ? format((max * i) / 4) : ''}</span>
                    ))}
                </div>
                <div className="relative">
                    <div aria-hidden className="absolute inset-x-0 top-0 bottom-6 flex flex-col justify-between">
                        {[0, 1, 2, 3, 4].map((i) => (
                            <span key={i} className="block h-px border-t border-dashed border-border" />
                        ))}
                    </div>
                    <ul className="relative m-0 flex h-full list-none items-end justify-around gap-2 p-0 pb-6">
                        {data.map((d, i) => {
                            const total = d.values.reduce((a, b) => a + b, 0);
                            return (
                                <li
                                    key={d.label}
                                    className="relative flex h-full w-full max-w-8 flex-col-reverse items-stretch gap-0.5"
                                    onMouseEnter={() => setActive(i)}
                                    onMouseLeave={() => setActive(null)}
                                >
                                    {d.values.map((v, s) => (
                                        <span
                                            key={series[s]?.name ?? s}
                                            className={cn(
                                                'block w-full',
                                                series[s]?.bg,
                                                s === d.values.length - 1 && 'rounded-t-[4px]',
                                                active !== null && active !== i && 'opacity-60',
                                            )}
                                            style={{ height: `${(v / max) * 100}%`, minHeight: v > 0 ? 3 : 0 }}
                                        />
                                    ))}
                                    <span className="absolute top-full left-1/2 mt-1.5 -translate-x-1/2 text-[11px] whitespace-nowrap text-text-muted">
                                        {d.label}
                                    </span>
                                    {active === i && (
                                        <span
                                            role="tooltip"
                                            className="absolute -top-8 left-1/2 -translate-x-1/2 rounded-md border border-border bg-surface px-2 py-1 text-xs whitespace-nowrap text-text shadow-md"
                                        >
                                            {series
                                                .map((sr, s) => `${sr.name} ${format(d.values[s] ?? 0)}`)
                                                .join(' · ')}{' '}
                                            · {format(total)}
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>
            <Legend items={series.map((s) => ({ name: s.name, bg: s.bg }))} />
        </div>
    );
}

export interface DonutDatum {
    label: string;
    value: number;
}

export interface DonutChartProps {
    data: readonly DonutDatum[];
    /** The number in the middle and the word under it. */
    total: ReactNode;
    totalLabel: string;
    label: string;
    className?: string;
}

/** A ring split by share, a 2px surface gap between slices, the total in the middle, a list beneath. */
export function DonutChart({ data, total, totalLabel, label, className }: DonutChartProps) {
    const sum = data.reduce((a, d) => a + d.value, 0) || 1;
    const r = 40;
    const c = 2 * Math.PI * r;
    const starts: number[] = [];
    for (let i = 0, acc = 0; i < data.length; i++) {
        starts.push(acc);
        acc += (data[i]!.value / sum) * c;
    }
    return (
        <div className={cn('flex flex-col gap-4', className)}>
            <div className="relative mx-auto size-40">
                <svg role="img" aria-label={label} viewBox="0 0 100 100" className="size-full -rotate-90">
                    {data.map((d, i) => {
                        const len = (d.value / sum) * c;
                        return (
                            <circle
                                key={d.label}
                                cx="50"
                                cy="50"
                                r={r}
                                fill="none"
                                className={CHART_STROKES[i % CHART_STROKES.length]}
                                strokeWidth="14"
                                strokeDasharray={`${Math.max(len - 2, 0)} ${c - Math.max(len - 2, 0)}`}
                                strokeDashoffset={-(starts[i] ?? 0)}
                            >
                                <title>
                                    {d.label}: {d.value} ({Math.round((d.value / sum) * 100)}%)
                                </title>
                            </circle>
                        );
                    })}
                </svg>
                <div className="absolute inset-0 grid place-items-center text-center">
                    <div>
                        <div className="text-2xl font-semibold tracking-tight tabular-nums">{total}</div>
                        <div className="text-xs text-text-muted">{totalLabel}</div>
                    </div>
                </div>
            </div>
            <ul className="m-0 list-none divide-y divide-border p-0">
                {data.map((d, i) => (
                    <li key={d.label} className="flex items-center gap-2 py-1.5 text-sm">
                        <span aria-hidden className={cn('size-2.5 rounded-full', CHART_BGS[i % CHART_BGS.length])} />
                        <span className="min-w-0 flex-1 truncate font-medium">{d.label}</span>
                        <span className="text-text-muted tabular-nums">{d.value}</span>
                        <span className="w-11 rounded-full bg-surface-raised px-1.5 py-0.5 text-center text-[11px] font-medium text-text-muted tabular-nums">
                            {Math.round((d.value / sum) * 100)}%
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The series key: a dot and a name per series. */
export function Legend({ items, className }: { items: readonly { name: string; bg: string }[]; className?: string }) {
    return (
        <ul
            className={cn(
                'm-0 flex list-none flex-wrap justify-center gap-x-4 gap-y-1 p-0 text-xs text-text-muted',
                className,
            )}
        >
            {items.map((item) => (
                <li key={item.name} className="flex items-center gap-1.5">
                    <span aria-hidden className={cn('size-2 rounded-sm', item.bg)} />
                    {item.name}
                </li>
            ))}
        </ul>
    );
}

/** A thin segmented distribution bar: one segment per share, 2px gaps, the legend beneath. */
export function DistributionBar({
    items,
    className,
}: {
    items: readonly { name: string; value: number; bg: string }[];
    className?: string;
}) {
    const sum = items.reduce((a, i) => a + i.value, 0) || 1;
    return (
        <div className={cn('flex flex-col gap-2.5', className)}>
            <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
                {items.map((item) => (
                    <span
                        key={item.name}
                        className={cn('block h-full rounded-full', item.bg)}
                        style={{ width: `${(item.value / sum) * 100}%` }}
                        title={`${item.name} ${Math.round((item.value / sum) * 100)}%`}
                    />
                ))}
            </div>
            <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-text-muted">
                {items.map((item) => (
                    <li key={item.name} className="flex items-center gap-1.5">
                        <span aria-hidden className={cn('size-2 rounded-full', item.bg)} />
                        {item.name} {Math.round((item.value / sum) * 100)}%
                    </li>
                ))}
            </ul>
        </div>
    );
}
