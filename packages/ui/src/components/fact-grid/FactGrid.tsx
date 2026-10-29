import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface Fact {
    label: string;
    value: ReactNode;
}

export interface FactGridProps extends HTMLAttributes<HTMLDListElement> {
    facts: readonly Fact[];
    /** Cells per row at full width; the mockup's record drawer uses four. */
    columns?: 2 | 3 | 4;
}

const COLUMNS = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' } as const;

/** Label-over-value cells in one bordered strip: Owner / Source / Email status / Country. */
export const FactGrid = forwardRef<HTMLDListElement, FactGridProps>(function FactGrid(
    { className, facts, columns = 4, ...props },
    ref,
) {
    return (
        <dl
            ref={ref}
            className={cn(
                'grid overflow-hidden rounded-xl border border-border bg-surface shadow-sm',
                COLUMNS[columns],
                className,
            )}
            {...props}
        >
            {facts.map((fact) => (
                <div
                    key={fact.label}
                    className="min-w-0 border-border px-3 py-2.5 not-last:border-r [&:nth-child(2)]:max-sm:border-r-0 max-sm:[&:nth-child(-n+2)]:border-b"
                >
                    <dt className="text-xs text-text-muted">{fact.label}</dt>
                    <dd className="mt-0.5 truncate font-medium">{fact.value}</dd>
                </div>
            ))}
        </dl>
    );
});
