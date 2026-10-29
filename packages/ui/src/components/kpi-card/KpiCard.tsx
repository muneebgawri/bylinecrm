import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { toneTile, type Tone } from '../../lib/tones';

export interface KpiCardProps extends HTMLAttributes<HTMLDivElement> {
    /** The icon in the tile (a lucide icon); the label carries the meaning. */
    icon: ReactNode;
    tone?: Tone;
    label: string;
    /** The number, as text already formatted for the reader ("4.2%", "$130k"). */
    value: ReactNode;
    /** A `<Delta>` or another small chip. Sits before the footnote. */
    delta?: ReactNode;
    /** One line under the value, muted: "9 of 212 sent this week". */
    footnote?: ReactNode;
    /** A sparkline or other small graphic, right-aligned in the footnote row. */
    sparkline?: ReactNode;
}

/**
 * A KPI tile: the label top-left and a solid-colour icon tile top-right, the number large beneath,
 * then the delta chip and footnote on one line. A faint dot grid sits behind it.
 */
export const KpiCard = forwardRef<HTMLDivElement, KpiCardProps>(function KpiCard(
    { className, icon, tone = 'accent', label, value, delta, footnote, sparkline, ...props },
    ref,
) {
    return (
        <div
            ref={ref}
            className={cn(
                'relative flex flex-col gap-6 overflow-hidden rounded-xl border border-border bg-surface py-6 shadow-sm',
                'text-border [background-image:radial-gradient(currentColor_1px,transparent_1px)] [background-size:16px_16px]',
                className,
            )}
            {...props}
        >
            <div className="flex items-center justify-between px-6 text-text">
                <span className="text-sm font-medium text-text-muted">{label}</span>
                <span className="grid size-10 place-items-center rounded-lg border border-border bg-surface p-0.5 shadow-sm">
                    <span
                        aria-hidden
                        className={cn('grid size-full place-items-center rounded-md [&_svg]:size-5', toneTile[tone])}
                    >
                        {icon}
                    </span>
                </span>
            </div>
            <div className="px-6 text-text">
                <div className="text-xl font-semibold tracking-tight tabular-nums">{value}</div>
                {(delta || footnote || sparkline) && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-text-muted">
                        {delta}
                        {footnote}
                        {sparkline && <span className="ml-auto h-6.5 w-21 [&_svg]:size-full">{sparkline}</span>}
                    </div>
                )}
            </div>
        </div>
    );
});
