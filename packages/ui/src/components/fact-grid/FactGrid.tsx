import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface Fact {
    label: string;
    value: ReactNode;
}

export interface FactGridProps extends HTMLAttributes<HTMLDListElement> {
    facts: readonly Fact[];
    /** The most cells per row, reached only where each still has room (9rem); the record drawer uses four. */
    columns?: 2 | 3 | 4;
}

/**
 * Label-over-value cells in one bordered strip: Owner / Source / Email status / Country. The strip
 * fits as many columns as its own width allows, up to `columns`, and a long value wraps rather than
 * being cut off. Every cell draws its right and bottom rule; the list overhangs the frame by 1px so
 * the rules on the outer edge are clipped, whatever the column count.
 */
export const FactGrid = forwardRef<HTMLDListElement, FactGridProps>(function FactGrid(
    { className, facts, columns = 4, style, ...props },
    ref,
) {
    return (
        <div className={cn('overflow-hidden rounded-xl border border-border bg-surface shadow-sm', className)}>
            <dl
                ref={ref}
                style={{ '--fact-columns': columns, ...style } as CSSProperties}
                className="-mr-px -mb-px grid grid-cols-[repeat(auto-fill,minmax(max(9rem,calc(100%/var(--fact-columns))),1fr))]"
                {...props}
            >
                {facts.map((fact) => (
                    <div key={fact.label} className="min-w-0 border-r border-b border-border px-3 py-2.5">
                        <dt className="text-xs text-text-muted">{fact.label}</dt>
                        <dd className="mt-0.5 font-medium [overflow-wrap:anywhere]">{fact.value}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
});
