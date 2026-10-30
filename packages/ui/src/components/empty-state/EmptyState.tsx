import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
    /** What is empty, as a statement: "No deals in this view". */
    title: string;
    /** What to do about it, or why it is empty. */
    body?: ReactNode;
    /** The one action that fills it — a Button. */
    action?: ReactNode;
    /** An illustration or icon, decorative (the title carries the meaning). */
    icon?: ReactNode;
    /** `error` is for "could not load", which is not the same as "nothing here" (FR-CRMS-UI-7). */
    tone?: 'empty' | 'error';
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
    { className, title, body, action, icon, tone = 'empty', ...props },
    ref,
) {
    return (
        <div
            ref={ref}
            role={tone === 'error' ? 'alert' : undefined}
            className={cn(
                'flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-5 py-9 text-center',
                tone === 'error' ? 'border-danger' : 'border-border',
                className,
            )}
            {...props}
        >
            {icon && (
                <div
                    aria-hidden
                    className={cn(
                        'mb-2 grid size-10 place-items-center rounded-full [&_svg]:size-5',
                        tone === 'error' ? 'bg-danger-soft text-danger' : 'bg-surface-raised text-text-muted',
                    )}
                >
                    {icon}
                </div>
            )}
            <p className="m-0 text-sm font-medium text-text">{title}</p>
            {body && <p className="m-0 max-w-xs text-xs leading-relaxed text-text-muted">{body}</p>}
            {action && <div className="mt-3">{action}</div>}
        </div>
    );
});
