import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export interface ScoreBarProps extends HTMLAttributes<HTMLSpanElement> {
    value: number;
    max?: number;
}

/** A score out of `max` as filled bars plus the figure, readable as "8 of 10". */
export const ScoreBar = forwardRef<HTMLSpanElement, ScoreBarProps>(function ScoreBar(
    { className, value, max = 10, ...props },
    ref,
) {
    const filled = Math.max(0, Math.min(max, Math.round(value)));
    return (
        <span
            ref={ref}
            role="meter"
            aria-valuenow={filled}
            aria-valuemin={0}
            aria-valuemax={max}
            aria-label={`Score ${filled} of ${max}`}
            className={cn('inline-flex items-center gap-1.5', className)}
            {...props}
        >
            <span aria-hidden className="inline-flex gap-0.5">
                {Array.from({ length: max }, (_, i) => (
                    <span key={i} className={cn('h-3 w-0.75 rounded-[1px]', i < filled ? 'bg-accent' : 'bg-border')} />
                ))}
            </span>
            <span
                aria-hidden
                className="rounded-[5px] border border-border px-1.25 text-xs text-text-muted tabular-nums"
            >
                {filled}/{max}
            </span>
        </span>
    );
});
