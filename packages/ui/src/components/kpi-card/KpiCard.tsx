import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { Tone } from '../../lib/tones';
import { IconTile } from '../icon-tile/IconTile';

export interface KpiCardProps extends HTMLAttributes<HTMLDivElement> {
    /** The icon in the tile (a lucide icon); the label carries the meaning. */
    icon: ReactNode;
    tone?: Tone;
    label: string;
    /** The number, as text already formatted for the reader ("4.2%", "$130k"). */
    value: ReactNode;
    /** A `<Delta>`, or a suffix such as "/ 200". Sits beside the value. */
    delta?: ReactNode;
    /** One line under the value, muted: "9 of 212 sent this week". */
    footnote?: ReactNode;
    /** A sparkline or other small graphic, right-aligned in the footnote row. */
    sparkline?: ReactNode;
}

/** The mockup's KPI tile: icon tile top-left, label, large tabular value with its delta, footnote. */
export const KpiCard = forwardRef<HTMLDivElement, KpiCardProps>(function KpiCard(
    { className, icon, tone = 'accent', label, value, delta, footnote, sparkline, ...props },
    ref,
) {
    return (
        <div
            ref={ref}
            className={cn(
                'grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1.5 rounded-lg border border-border bg-surface px-4.5 py-4 shadow-sm',
                className,
            )}
            {...props}
        >
            <IconTile tone={tone} size="lg" className="row-span-2">
                {icon}
            </IconTile>
            <span className="text-[13px] text-text-muted">{label}</span>
            <span className="flex items-center gap-2 text-[26px] leading-[1.1] font-semibold tracking-tight tabular-nums">
                {value}
                {delta}
            </span>
            {(footnote || sparkline) && (
                <span className="col-span-2 mt-1 flex items-center gap-2 text-xs text-text-faint">
                    {footnote}
                    {sparkline && <span className="ml-auto h-6.5 w-21 [&_svg]:size-full">{sparkline}</span>}
                </span>
            )}
        </div>
    );
});
