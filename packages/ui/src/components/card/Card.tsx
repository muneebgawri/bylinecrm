import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/**
 * The one card: a 14px-radius bordered panel on the surface colour, with its header, content and
 * footer each carrying the 24px side padding so a card's parts line up whatever it holds.
 */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Card(
    { className, ...props },
    ref,
) {
    return (
        <div
            ref={ref}
            data-slot="card"
            className={cn(
                'flex flex-col gap-6 rounded-xl border border-border bg-surface py-6 text-text shadow-sm',
                className,
            )}
            {...props}
        />
    );
});

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardHeader(
    { className, ...props },
    ref,
) {
    return <div ref={ref} data-slot="card-header" className={cn('grid gap-1.5 px-6', className)} {...props} />;
});

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(function CardTitle(
    { className, ...props },
    ref,
) {
    return (
        <h2
            ref={ref}
            data-slot="card-title"
            className={cn('m-0 text-sm leading-none font-semibold', className)}
            {...props}
        />
    );
});

export const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
    function CardDescription({ className, ...props }, ref) {
        return (
            <p
                ref={ref}
                data-slot="card-description"
                className={cn('m-0 text-sm text-text-muted', className)}
                {...props}
            />
        );
    },
);

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardContent(
    { className, ...props },
    ref,
) {
    return <div ref={ref} data-slot="card-content" className={cn('px-6', className)} {...props} />;
});

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardFooter(
    { className, ...props },
    ref,
) {
    return <div ref={ref} data-slot="card-footer" className={cn('flex items-center px-6', className)} {...props} />;
});
