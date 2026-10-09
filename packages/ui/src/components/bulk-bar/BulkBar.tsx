import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

export interface BulkBarProps extends HTMLAttributes<HTMLDivElement> {
    count: number;
    /** `BulkBarAction`s. */
    children: ReactNode;
    onDiscard: () => void;
    discardLabel?: string;
}

/** The floating dark bar that appears over a selection: count · actions · Discard. */
export const BulkBar = forwardRef<HTMLDivElement, BulkBarProps>(function BulkBar(
    { className, count, children, onDiscard, discardLabel = 'Discard', ...props },
    ref,
) {
    return (
        <div
            ref={ref}
            role="toolbar"
            aria-label={`${count} selected`}
            className={cn(
                'sticky bottom-3 mx-auto mt-3 flex w-max max-w-full items-center gap-0.5 rounded-lg bg-primary px-2 py-1.5 text-[13px] text-primary-foreground shadow-lg',
                className,
            )}
            {...props}
        >
            <span className="px-2.5 font-medium">Selected: {count}</span>
            <Separator />
            {children}
            <Separator />
            <BulkBarAction onClick={onDiscard} className="bg-surface text-danger hover:bg-surface hover:opacity-90">
                {discardLabel}
            </BulkBarAction>
        </div>
    );
});

function Separator() {
    return <span aria-hidden className="mx-0.5 h-4.5 w-px bg-primary-foreground/40" />;
}

export const BulkBarAction = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
    function BulkBarAction({ className, type = 'button', ...props }, ref) {
        return (
            <button
                ref={ref}
                type={type}
                className={cn(
                    'inline-flex h-7.5 items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors hover:bg-primary-foreground/20',
                    '[&_svg]:size-3.5',
                    focusRing,
                    className,
                )}
                {...props}
            />
        );
    },
);
