import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/** A loading placeholder the shape of the content it stands in for — no layout shift when the data lands. */
export const Skeleton = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Skeleton(
    { className, ...props },
    ref,
) {
    return (
        <div
            ref={ref}
            aria-hidden
            className={cn('animate-pulse rounded-md bg-border motion-reduce:animate-none', className)}
            {...props}
        />
    );
});
