import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '../../lib/cn';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
    ComponentRef<typeof TooltipPrimitive.Content>,
    ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 4, ...props }, ref) {
    return (
        <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
                ref={ref}
                sideOffset={sideOffset}
                className={cn(
                    'z-50 max-w-xs rounded-md bg-text px-3 py-1.5 text-xs text-background shadow-md',
                    'motion-reduce:animate-none',
                    className,
                )}
                {...props}
            />
        </TooltipPrimitive.Portal>
    );
});
