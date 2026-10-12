import { cn, focusRing, LoadingRegion, Skeleton } from '@bylinecrm/ui';
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router';

/** The right rail's card: a muted heading with a count, an action, and rows beneath (mockup v3 `.rel`); a named region. */
export function RailCard({
    title,
    count,
    action,
    children,
    className,
}: {
    title: string;
    count?: number | undefined;
    action?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    const headingId = useId();
    return (
        <section
            aria-labelledby={headingId}
            className={cn('rounded-lg border border-border bg-surface shadow-sm', className)}
        >
            <h3 className="m-0 flex items-center gap-2 border-b border-border px-4 py-3 text-[13px] font-medium text-text-muted">
                <span id={headingId}>{title}</span>
                {count !== undefined && <span className="tabular-nums text-text-faint">{count}</span>}
                {action && <span className="ml-auto">{action}</span>}
            </h3>
            {children}
        </section>
    );
}

/** One row of a rail card: a bold line and a muted line, as a link or static. */
export function RailRow({
    to,
    title,
    subtitle,
    onClick,
}: {
    to?: string | undefined;
    title: ReactNode;
    subtitle?: ReactNode;
    onClick?: (() => void) | undefined;
}) {
    const body = (
        <>
            <span className="block truncate font-medium text-text">{title}</span>
            {subtitle && <span className="block truncate text-xs text-text-muted">{subtitle}</span>}
        </>
    );
    const classes = cn(
        'block w-full border-b border-border px-4 py-2.5 text-left last:border-b-0',
        (to || onClick) && 'hover:bg-surface-raised',
        focusRing,
    );
    if (to) {
        return (
            <Link to={to} className={classes}>
                {body}
            </Link>
        );
    }
    if (onClick) {
        return (
            <button type="button" onClick={onClick} className={classes}>
                {body}
            </button>
        );
    }
    return <div className={classes}>{body}</div>;
}

/** The rail card's "nothing here" line; a sentence, never a blank card. */
export function RailEmpty({ children }: { children: ReactNode }) {
    return <p className="m-0 px-4 py-3 text-[13px] text-text-faint">{children}</p>;
}

/** A rail card while its rows load: the shape, not "nothing here" (loading is not empty, FR-CRMS-UI-7). */
export function RailLoading() {
    return (
        <LoadingRegion label="Loading" className="px-4 py-3">
            <Skeleton className="h-8" />
        </LoadingRegion>
    );
}
