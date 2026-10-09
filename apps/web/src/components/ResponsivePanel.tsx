import { cn, usePhone } from '@bylinecrm/ui';
import { Popover, PopoverContent, PopoverTrigger } from '@bylinecrm/ui/popover';
import { Sheet, SheetContent, SheetTrigger } from '@bylinecrm/ui/sheet';
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
}

/**
 * One panel, two forms (FR-CRMS-UI-12): a popover anchored to its trigger on a desktop or tablet,
 * a bottom sheet on a phone. The content is the same component either way, so the filter and sort
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
}: ResponsivePanelProps) {
    const phone = usePhone();
    if (phone) {
        return (
            <Sheet open={open} onOpenChange={onOpenChange}>
                <SheetTrigger asChild>{trigger}</SheetTrigger>
                <SheetContent title={title} footer={footer}>
                    {children}
                </SheetContent>
            </Sheet>
        );
    }
    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent aria-label={title} className={cn('flex flex-col gap-3', widthClass)}>
                <h2 className="m-0 text-sm font-semibold">{title}</h2>
                {children}
                {footer && <div className="flex justify-end gap-2 border-t border-border pt-3">{footer}</div>}
            </PopoverContent>
        </Popover>
    );
}
