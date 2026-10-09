import * as TabsPrimitive from '@radix-ui/react-tabs';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
    ComponentRef<typeof TabsPrimitive.List>,
    ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
    return (
        <TabsPrimitive.List
            ref={ref}
            className={cn('inline-flex items-center gap-1 border-b border-border', className)}
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
                '-mb-px inline-flex items-center justify-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-text-muted max-md:min-h-touch max-md:min-w-touch',
                'hover:text-text data-[state=active]:border-accent data-[state=active]:text-text',
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
