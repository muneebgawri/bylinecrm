import * as TabsPrimitive from '@radix-ui/react-tabs';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

export const Tabs = TabsPrimitive.Root;

export interface TabsListProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
    /** `line` underlines the open tab; `pill` is a muted track with the open tab raised on it. */
    variant?: 'line' | 'pill';
}

export const TabsList = forwardRef<ComponentRef<typeof TabsPrimitive.List>, TabsListProps>(function TabsList(
    { className, variant = 'line', ...props },
    ref,
) {
    return (
        <TabsPrimitive.List
            ref={ref}
            data-variant={variant}
            className={cn(
                'group/tabs inline-flex items-center',
                variant === 'line'
                    ? 'gap-1 border-b border-border'
                    : 'h-9 gap-0.5 rounded-lg bg-surface-raised p-[3px] text-text-muted max-md:h-touch',
                className,
            )}
            {...props}
        />
    );
});

export const TabsTrigger = forwardRef<
    ComponentRef<typeof TabsPrimitive.Trigger>,
    ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
    return (
        <TabsPrimitive.Trigger
            ref={ref}
            className={cn(
                'inline-flex items-center justify-center gap-2 text-sm font-medium text-text-muted max-md:min-h-touch max-md:min-w-touch',
                'group-data-[variant=line]/tabs:-mb-px group-data-[variant=line]/tabs:border-b-2 group-data-[variant=line]/tabs:border-transparent group-data-[variant=line]/tabs:px-3 group-data-[variant=line]/tabs:py-2',
                'group-data-[variant=line]/tabs:hover:text-text group-data-[variant=line]/tabs:data-[state=active]:border-accent group-data-[variant=line]/tabs:data-[state=active]:text-text',
                'group-data-[variant=pill]/tabs:h-full group-data-[variant=pill]/tabs:rounded-md group-data-[variant=pill]/tabs:px-3 group-data-[variant=pill]/tabs:transition-colors',
                'group-data-[variant=pill]/tabs:hover:text-text group-data-[variant=pill]/tabs:data-[state=active]:bg-surface group-data-[variant=pill]/tabs:data-[state=active]:text-text group-data-[variant=pill]/tabs:data-[state=active]:shadow-sm',
                'disabled:pointer-events-none disabled:opacity-50',
                focusRing,
                className,
            )}
            {...props}
        />
    );
});

export const TabsContent = forwardRef<
    ComponentRef<typeof TabsPrimitive.Content>,
    ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
    return <TabsPrimitive.Content ref={ref} className={cn('pt-4', focusRing, className)} {...props} />;
});
