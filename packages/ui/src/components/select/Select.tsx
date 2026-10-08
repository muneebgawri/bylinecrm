import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';
import { popoverSurface } from '../../lib/surfaces';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
    ComponentRef<typeof SelectPrimitive.Trigger>,
    ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(function SelectTrigger({ className, children, ...props }, ref) {
    return (
        <SelectPrimitive.Trigger
            ref={ref}
            className={cn(
                'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-raised px-3 text-sm text-text',
                'hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-text-faint',
                focusRing,
                className,
            )}
            {...props}
        >
            {children}
            <SelectPrimitive.Icon asChild>
                <ChevronDown aria-hidden className="size-4 text-text-muted" />
            </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
    );
});

export const SelectContent = forwardRef<
    ComponentRef<typeof SelectPrimitive.Content>,
    ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = 'popper', ...props }, ref) {
    return (
        <SelectPrimitive.Portal>
            <SelectPrimitive.Content
                ref={ref}
                position={position}
                className={cn(
                    popoverSurface,
                    'max-h-80 min-w-32',
                    position === 'popper' && 'w-[var(--radix-select-trigger-width)]',
                    className,
                )}
                {...props}
            >
                <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
            </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
    );
});

export const SelectLabel = forwardRef<
    ComponentRef<typeof SelectPrimitive.Label>,
    ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(function SelectLabel({ className, ...props }, ref) {
    return (
        <SelectPrimitive.Label
            ref={ref}
            className={cn('px-2 py-1.5 text-xs font-medium text-text-muted', className)}
            {...props}
        />
    );
});

export const SelectItem = forwardRef<
    ComponentRef<typeof SelectPrimitive.Item>,
    ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
    return (
        <SelectPrimitive.Item
            ref={ref}
            className={cn(
                'relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm text-text outline-none',
                'data-[highlighted]:bg-surface data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                className,
            )}
            {...props}
        >
            <span className="absolute left-2 flex size-4 items-center justify-center">
                <SelectPrimitive.ItemIndicator>
                    <Check aria-hidden className="size-4" />
                </SelectPrimitive.ItemIndicator>
            </span>
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        </SelectPrimitive.Item>
    );
});
