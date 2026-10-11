import { cn, Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger, useIsMobile } from '@bylinecrm/ui';
import { Popover, PopoverContent, PopoverTrigger } from '@bylinecrm/ui/popover';
import type { ReactElement, ReactNode } from 'react';

export interface ResponsivePanelProps {
    /** The button that opens the panel; rendered as-is (`asChild`). */
    trigger: ReactElement;
    /** The panel's name — the popover's label, the sheet's heading. */
    title: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
    /** The panel's actions (Apply, Clear): under the body on desktop, a sticky bottom row on a phone. */
    footer?: ReactNode;
    /** The popover's width class on desktop; a sheet is always full width. */
    widthClass?: string;
    /**
     * Called as the panel closes, where it would hand focus back to its trigger; `preventDefault()`
     * keeps it from doing so, for a panel whose result lands somewhere else (the variable picker's
     * chip goes into an editor, and the caret with it).
     */
    onCloseAutoFocus?: (event: Event) => void;
}

/**
 * One panel, two forms (FR-CRMS-UI-12): a popover anchored to its trigger on a desktop or tablet,
 * the design system's dialog — a bottom sheet — on a phone. The content is the same component either way, so the filter and sort
 * editors are written once and only their frame changes with the screen.
 */
export function ResponsivePanel({
    trigger,
    title,
    open,
    onOpenChange,
    children,
    footer,
    widthClass = 'w-[min(36rem,calc(100vw-2rem))]',
    onCloseAutoFocus,
}: ResponsivePanelProps) {
    const phone = useIsMobile();
    if (phone) {
        // The design system's Dialog is a bottom sheet below the phone breakpoint: the same
        // content, risen from the bottom edge, its actions in a row a thumb reaches.
        return (
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogTrigger asChild>{trigger}</DialogTrigger>
                <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription className="sr-only">{title}</DialogDescription>
                    <div className="flex flex-col gap-3">{children}</div>
                    {footer && <div className="flex gap-2 border-t border-border pt-3">{footer}</div>}
                </DialogContent>
            </Dialog>
        );
    }
    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent
                aria-label={title}
                className={cn('flex flex-col gap-3', widthClass)}
                onCloseAutoFocus={onCloseAutoFocus}
            >
                <h2 className="m-0 text-sm font-semibold">{title}</h2>
                {children}
                {footer && <div className="flex justify-end gap-2 border-t border-border pt-3">{footer}</div>}
            </PopoverContent>
        </Popover>
    );
}
