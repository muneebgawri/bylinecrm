import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

export interface BottomActionBarProps extends HTMLAttributes<HTMLDivElement> {
    /** What the actions act on, for screen readers ("Dana Reyes actions"). */
    label: string;
    /** `BottomActionBarItem`s. */
    children: ReactNode;
}

/**
 * A page's actions on a phone, held at the bottom of the screen where a thumb reaches them
 * (FR-CRMS-UI-12). It is `sticky` at the bottom of its scrolling container rather than `fixed`:
 * it stays on screen while the page scrolls, yet takes its own space at the end of the content,
 * so nothing is ever hidden behind it. Place it as the LAST child of a box that spans the whole
 * content. Above the phone breakpoint it does not render (`md:hidden`) — the page's header holds
 * the same actions there. `data-bottom-bar` is what the route gate checks for.
 */
export const BottomActionBar = forwardRef<HTMLDivElement, BottomActionBarProps>(function BottomActionBar(
    { className, label, children, ...props },
    ref,
) {
    return (
        <div
            ref={ref}
            role="group"
            aria-label={label}
            data-bottom-bar=""
            className={cn(
                'sticky bottom-0 z-20 flex gap-2 border-t border-border bg-surface px-4 pt-2 shadow-lg md:hidden',
                'pb-[max(0.5rem,env(safe-area-inset-bottom))]',
                className,
            )}
            {...props}
        >
            {children}
        </div>
    );
});

export interface BottomActionBarItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    icon?: ReactNode;
    /** The bar's one emphasised action. */
    primary?: boolean;
}

/** An action in the bar: icon over a short label, a full touch target, an equal share of the width. */
export const BottomActionBarItem = forwardRef<HTMLButtonElement, BottomActionBarItemProps>(function BottomActionBarItem(
    { className, icon, primary = false, type = 'button', children, ...props },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            className={cn(
                'flex min-h-touch min-w-touch flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-xs font-medium',
                '[&_svg]:size-4.5',
                primary ? 'bg-primary text-primary-foreground hover:opacity-92' : 'text-text hover:bg-surface-raised',
                'aria-disabled:opacity-55',
                focusRing,
                className,
            )}
            {...props}
        >
            {icon}
            <span>{children}</span>
        </button>
    );
});
