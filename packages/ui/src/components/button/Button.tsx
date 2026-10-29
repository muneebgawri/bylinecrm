import { Slot, Slottable } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

/**
 * The mockup's buttons: pills by default (`shape="square"` for the 8px toolbar buttons), a black
 * primary, a bordered secondary with the card shadow, a quiet ghost, a danger fill and a link.
 */
export const buttonVariants = cva(
    [
        'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium',
        'transition-colors disabled:pointer-events-none disabled:opacity-50',
        // A finger needs 44×44 (FR-CRMS-UI-12); the desktop sizes below are unchanged.
        'max-md:min-h-touch max-md:min-w-touch',
        '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        focusRing,
    ],
    {
        variants: {
            variant: {
                primary: 'border border-primary bg-primary text-primary-foreground hover:opacity-90',
                accent: 'border border-accent bg-accent text-accent-foreground hover:opacity-90',
                secondary: 'border border-border bg-surface text-text shadow-sm hover:bg-surface-raised',
                ghost: 'border border-transparent text-text-muted hover:bg-surface-raised hover:text-text',
                danger: 'border border-danger bg-danger text-danger-soft hover:opacity-90',
                link: 'text-accent underline-offset-4 hover:underline',
            },
            size: {
                xs: 'h-6.5 px-2 text-xs',
                sm: 'h-7.5 px-2.5 text-[13px]',
                md: 'h-9 px-3.5 text-sm',
                lg: 'h-10 px-5 text-base',
                icon: 'size-8.5',
            },
            shape: {
                pill: 'rounded-full',
                square: 'rounded-md',
            },
        },
        defaultVariants: { variant: 'secondary', size: 'md', shape: 'square' },
    },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
    /** Render the child element instead of a `<button>` (a link styled as a button). */
    asChild?: boolean;
    /** Disables the button, shows a spinner, and announces busy. The label stays visible. */
    loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { className, variant, size, shape, asChild = false, loading = false, disabled, children, type, ...props },
    ref,
) {
    const Comp = asChild ? Slot : 'button';
    return (
        <Comp
            ref={ref}
            className={cn(buttonVariants({ variant, size, shape }), className)}
            disabled={disabled || loading}
            aria-busy={loading || undefined}
            type={asChild ? undefined : (type ?? 'button')}
            {...props}
        >
            {loading && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
            {/* Slottable marks which child asChild slots onto, so the spinner can sit beside it. */}
            <Slottable>{children}</Slottable>
        </Comp>
    );
});
