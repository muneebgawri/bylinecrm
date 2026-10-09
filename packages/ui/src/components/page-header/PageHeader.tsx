import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface PageHeaderProps extends HTMLAttributes<HTMLDivElement> {
    title: string;
    /** A chip inline after the title: a count, a "Live" status. */
    chip?: ReactNode;
    subtitle?: ReactNode;
    /** Buttons, right-aligned; the primary one is black. */
    actions?: ReactNode;
}

/** The page's heading row: 24px/600 title with an optional chip, muted subtitle, actions right. */
export const PageHeader = forwardRef<HTMLDivElement, PageHeaderProps>(function PageHeader(
    { className, title, chip, subtitle, actions, children, ...props },
    ref,
) {
    return (
        <div ref={ref} className={cn('mb-5 flex flex-wrap items-start gap-4', className)} {...props}>
            <div className="min-w-0">
                <h1 className="flex items-center gap-2.5 text-2xl leading-[1.25] font-semibold tracking-tight">
                    {title}
                    {chip}
                </h1>
                {subtitle && <p className="mt-1 text-text-muted">{subtitle}</p>}
                {children}
            </div>
            {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
});
