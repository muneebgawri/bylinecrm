import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/**
 * Status semantics — the ONE definition of what each colour means across the product:
 *   neutral  informational, no judgement (a tag, a count)
 *   success  done, verified, healthy, paid
 *   warning  needs attention but nothing is broken (stale, warming, risky)
 *   danger   broken, refused, failed, paused by a rule
 *   info     in progress, scheduled, system-originated
 * A component that needs a colour for a state picks the meaning, never the hue.
 */
export const badgeVariants = cva(
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
    {
        variants: {
            status: {
                neutral: 'border-border bg-surface text-text-muted',
                success: 'border-transparent bg-success-soft text-success',
                warning: 'border-transparent bg-warning-soft text-warning',
                danger: 'border-transparent bg-danger-soft text-danger',
                info: 'border-transparent bg-info-soft text-info',
            },
        },
        defaultVariants: { status: 'neutral' },
    },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
    /** A leading dot in the status colour, for lists where the word alone is too quiet. */
    dot?: boolean;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
    { className, status, dot = false, children, ...props },
    ref,
) {
    return (
        <span ref={ref} className={cn(badgeVariants({ status }), className)} {...props}>
            {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
            {children}
        </span>
    );
});
