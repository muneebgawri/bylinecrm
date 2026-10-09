import { Slot, Slottable } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

export const buttonVariants = cva(
    [
        'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium',
        'transition-colors disabled:pointer-events-none disabled:opacity-50',
        '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        focusRing,
    ],
    {
        variants: {
            variant: {
                primary: 'bg-accent text-accent-foreground hover:bg-accent-hover',
                secondary: 'border border-border bg-surface-raised text-text hover:bg-surface',
                ghost: 'text-text hover:bg-surface',
                danger: 'bg-danger text-danger-soft hover:opacity-90',
                link: 'text-accent underline-offset-4 hover:underline',
            },
            size: {
                sm: 'h-8 px-3 text-sm',
                md: 'h-9 px-4 text-sm',
                lg: 'h-10 px-5 text-base',
                icon: 'size-9',
            },
        },
        defaultVariants: { variant: 'primary', size: 'md' },
    },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
    /** Render the child element instead of a `<button>` (a link styled as a button). */
    asChild?: boolean;
    /** Disables the button, shows a spinner, and announces busy. The label stays visible. */
    loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { className, variant, size, asChild = false, loading = false, disabled, children, type, ...props },
    ref,
) {
    const Comp = asChild ? Slot : 'button';
    return (
        <Comp
            ref={ref}
            className={cn(buttonVariants({ variant, size }), className)}
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
