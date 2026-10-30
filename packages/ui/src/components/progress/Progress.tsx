import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { toneSolid, type Tone } from '../../lib/tones';

export interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
    /** 0–100. */
    value: number;
    tone?: Tone;
    /** Read out with the bar: "Quota attainment". */
    label: string;
    /** `sm` is the 6px bar on a card; `md` is 8px. */
    size?: 'sm' | 'md';
}

/** A horizontal bar filled to `value` percent, rounded, on the raised surface. */
export const Progress = forwardRef<HTMLDivElement, ProgressProps>(function Progress(
    { className, value, tone = 'accent', label, size = 'sm', ...props },
    ref,
) {
    const clamped = Math.max(0, Math.min(100, value));
    return (
        <div
            ref={ref}
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clamped)}
            className={cn(
                'w-full overflow-hidden rounded-full bg-surface-raised',
                size === 'sm' ? 'h-1.5' : 'h-2',
                className,
            )}
            {...props}
        >
            <span
                className={cn('block h-full rounded-full transition-[width]', toneSolid[tone])}
                style={{ width: `${clamped}%` }}
            />
        </div>
    );
});
