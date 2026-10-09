import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { toneSoft } from '../../lib/tones';

/**
 * A status chip. The meaning of each tone is defined once in `lib/tones.ts`; this component only
 * adds the shape — the mockup's 6px "pill" by default, a round one with `shape="pill"`.
 * `StatusBadge` is the same component under the name the shell spec uses.
 */
export const badgeVariants = cva(
    'inline-flex h-5.5 items-center gap-1.5 px-2 text-xs font-medium whitespace-nowrap border border-transparent',
    {
        variants: {
            status: toneSoft,
            shape: {
                square: 'rounded-sm',
                pill: 'rounded-full',
            },
        },
        defaultVariants: { status: 'neutral', shape: 'square' },
    },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
    /** A leading dot in the status colour, for lists where the word alone is too quiet. */
    dot?: boolean;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
    { className, status, shape, dot = false, children, ...props },
    ref,
) {
    return (
        <span ref={ref} className={cn(badgeVariants({ status, shape }), className)} {...props}>
            {dot && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />}
            {children}
        </span>
    );
});

export { Badge as StatusBadge };
export type { BadgeProps as StatusBadgeProps };
