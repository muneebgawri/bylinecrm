import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * The frame every data view sits in: a toolbar (view, filter, columns), a sticky header row,
 * a scrolling body, and a footer (selection count, totals, pagination). It owns layout only;
 * columns, virtualisation and the row model arrive with TanStack in P1-UI-2 and render into
 * the slots. Keeping the frame separate is what lets the pipeline list, the people grid and the
 * importer's counts all look like one product.
 */
export interface DataTableShellProps extends HTMLAttributes<HTMLDivElement> {
    toolbar?: ReactNode;
    header?: ReactNode;
    /** The scrolling region; a virtualiser renders rows into it. */
    children: ReactNode;
    footer?: ReactNode;
    /** Accessible name for the table region. */
    label: string;
}

export const DataTableShell = forwardRef<HTMLDivElement, DataTableShellProps>(function DataTableShell(
    { className, toolbar, header, children, footer, label, ...props },
    ref,
) {
    return (
        <div
            ref={ref}
            role="region"
            aria-label={label}
            className={cn('flex min-h-0 flex-col rounded-lg border border-border bg-surface-raised', className)}
            {...props}
        >
            {toolbar && <div className="flex items-center gap-2 border-b border-border px-3 py-2">{toolbar}</div>}
            {header && (
                <div className="sticky top-0 z-10 border-b border-border bg-surface text-xs font-medium text-text-muted">
                    {header}
                </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto">{children}</div>
            {footer && (
                <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-sm text-text-muted">
                    {footer}
                </div>
            )}
        </div>
    );
});
