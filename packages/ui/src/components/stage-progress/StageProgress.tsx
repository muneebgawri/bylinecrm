import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface Stage {
    label: string;
}

export interface StageProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
    /** "Deal · Acme Series B PR" */
    title: ReactNode;
    /** Right of the title, muted: "$12,000 · Replied" */
    meta?: ReactNode;
    stages: readonly Stage[];
    /** Index of the current stage; earlier ones read as done. */
    current: number;
}

/** A deal's position in its pipeline: a bar with a marker and the stage chips beneath. */
export const StageProgress = forwardRef<HTMLDivElement, StageProgressProps>(function StageProgress(
    { className, title, meta, stages, current, ...props },
    ref,
) {
    const index = Math.max(0, Math.min(stages.length - 1, current));
    const percent = stages.length <= 1 ? 100 : (index / (stages.length - 1)) * 100;
    const currentLabel = stages[index]?.label ?? '';
    return (
        <div ref={ref} className={cn('rounded-md border border-border px-3.5 py-3', className)} {...props}>
            <div className="flex items-center gap-2 font-medium">
                {title}
                {meta && <span className="ml-auto text-[13px] font-normal text-text-muted">{meta}</span>}
            </div>
            <div
                role="progressbar"
                aria-label="Pipeline stage"
                aria-valuenow={index + 1}
                aria-valuemin={1}
                aria-valuemax={stages.length}
                aria-valuetext={`Stage ${index + 1} of ${stages.length}: ${currentLabel}`}
                className="relative mt-2.5 h-2 rounded-sm bg-accent-soft"
            >
                <span className="block h-full rounded-sm bg-accent" style={{ width: `${percent}%` }} />
                <span
                    aria-hidden
                    className="absolute -top-1 size-4 -translate-x-1/2 rounded-full border-[3px] border-surface bg-primary"
                    style={{ left: `${percent}%` }}
                />
            </div>
            <ol className="mt-2.5 flex flex-wrap gap-1.5 text-xs text-text-muted">
                {stages.map((stage, i) => (
                    <li
                        key={stage.label}
                        aria-current={i === index ? 'step' : undefined}
                        className={cn(
                            'rounded-full border border-border px-2 py-0.5',
                            i < index && 'border-transparent bg-accent-soft text-accent',
                            i === index && 'border-accent bg-accent text-accent-foreground',
                        )}
                    >
                        {stage.label}
                    </li>
                ))}
            </ol>
        </div>
    );
});
