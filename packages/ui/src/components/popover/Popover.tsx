import * as PopoverPrimitive from '@radix-ui/react-popover';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '../../lib/cn';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

/**
 * A floating panel anchored to its trigger, for content a menu cannot hold — a search field with
 * results, a filter editor. Focus moves in on open and back to the trigger on close; Esc and an
 * outside click close it. On a phone, the same content belongs in a `Sheet` (FR-CRMS-UI-12).
 */
export const PopoverContent = forwardRef<
    ComponentRef<typeof PopoverPrimitive.Content>,
    ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, align = 'start', sideOffset = 6, ...props }, ref) {
    return (
        <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
                ref={ref}
                align={align}
                sideOffset={sideOffset}
                className={cn(
                    'z-50 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-lg border border-border bg-surface p-3 text-text shadow-lg outline-none',
                    className,
                )}
                {...props}
            />
        </PopoverPrimitive.Portal>
    );
});
