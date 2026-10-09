import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { toneSoft } from '../../lib/tones';

export interface DeltaProps extends HTMLAttributes<HTMLSpanElement> {
    /** Which way the number moved. `good` says whether that is welcome — a falling bounce rate is `down` and good. */
    direction: 'up' | 'down';
    good?: boolean;
}

/** A small change chip: arrow + value, green when the change is welcome, red when it is not. */
export const Delta = forwardRef<HTMLSpanElement, DeltaProps>(function Delta(
    { className, direction, good = direction === 'up', children, ...props },
    ref,
) {
    const Arrow = direction === 'up' ? ArrowUpRight : ArrowDownRight;
    return (
        <span
            ref={ref}
            className={cn(
                'inline-flex items-center gap-0.5 rounded-full border border-transparent px-1.75 py-0.5 text-xs font-medium',
                good ? toneSoft.success : toneSoft.danger,
                className,
            )}
            {...props}
        >
            <Arrow aria-hidden className="size-3" />
            <span className="sr-only">{direction === 'up' ? 'up' : 'down'} </span>
            {children}
        </span>
    );
});
