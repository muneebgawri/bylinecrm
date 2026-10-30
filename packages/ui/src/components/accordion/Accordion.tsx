import { ChevronDown } from 'lucide-react';
import { forwardRef, type DetailsHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

/** A stack of disclosure rows divided by hairlines; each is a native `<details>`, so it needs no script. */
export function Accordion({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn('divide-y divide-border', className)} {...props} />;
}

export interface AccordionItemProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'title'> {
    title: ReactNode;
}

/** One row: the title with a chevron that turns when open, and the body beneath. */
export const AccordionItem = forwardRef<HTMLDetailsElement, AccordionItemProps>(function AccordionItem(
    { className, title, children, ...props },
    ref,
) {
    return (
        <details ref={ref} className={cn('group', className)} {...props}>
            <summary
                className={cn(
                    'flex cursor-pointer list-none items-center justify-between gap-4 rounded-md py-4 text-left text-sm font-medium hover:underline [&::-webkit-details-marker]:hidden',
                    focusRing,
                )}
            >
                {title}
                <ChevronDown
                    aria-hidden
                    className="size-4 shrink-0 text-text-muted transition-transform group-open:rotate-180"
                />
            </summary>
            <div className="pb-4 text-sm text-text-muted">{children}</div>
        </details>
    );
});
