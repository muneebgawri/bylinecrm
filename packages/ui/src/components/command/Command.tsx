import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '../../lib/cn';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../dialog/Dialog';

/** The palette's list and input. Wrap in CommandDialog for ⌘K, or render inline inside a panel. */
export const Command = forwardRef<
    ComponentRef<typeof CommandPrimitive>,
    ComponentPropsWithoutRef<typeof CommandPrimitive>
>(function Command({ className, ...props }, ref) {
    return (
        <CommandPrimitive
            ref={ref}
            className={cn(
                'flex h-full w-full flex-col overflow-hidden rounded-md bg-surface-raised text-text',
                className,
            )}
            {...props}
        />
    );
});

export interface CommandDialogProps extends ComponentPropsWithoutRef<typeof Dialog> {
    /** Spoken name of the palette; visually hidden. */
    title?: string;
    description?: string;
}

export function CommandDialog({
    children,
    title = 'Command palette',
    description = 'Search for a record, a page or an action.',
    ...props
}: CommandDialogProps) {
    return (
        <Dialog {...props}>
            <DialogContent className="overflow-hidden p-0 [&>button]:hidden">
                <DialogTitle className="sr-only">{title}</DialogTitle>
                <DialogDescription className="sr-only">{description}</DialogDescription>
                <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-text-muted">
                    {children}
                </Command>
            </DialogContent>
        </Dialog>
    );
}

export const CommandInput = forwardRef<
    ComponentRef<typeof CommandPrimitive.Input>,
    ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(function CommandInput({ className, ...props }, ref) {
    return (
        <div className="flex items-center gap-2 border-b border-border px-3" cmdk-input-wrapper="">
            <Search aria-hidden className="size-4 shrink-0 text-text-muted" />
            <CommandPrimitive.Input
                ref={ref}
                className={cn(
                    'flex h-11 w-full bg-transparent py-3 text-sm outline-none placeholder:text-text-faint disabled:cursor-not-allowed disabled:opacity-50',
                    className,
                )}
                {...props}
            />
        </div>
    );
});

export const CommandList = forwardRef<
    ComponentRef<typeof CommandPrimitive.List>,
    ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(function CommandList({ className, ...props }, ref) {
    return (
        <CommandPrimitive.List
            ref={ref}
            className={cn('max-h-80 overflow-y-auto overflow-x-hidden p-1', className)}
            {...props}
        />
    );
});

export const CommandEmpty = forwardRef<
    ComponentRef<typeof CommandPrimitive.Empty>,
    ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(function CommandEmpty(props, ref) {
    return <CommandPrimitive.Empty ref={ref} className="py-6 text-center text-sm text-text-muted" {...props} />;
});

export const CommandGroup = forwardRef<
    ComponentRef<typeof CommandPrimitive.Group>,
    ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(function CommandGroup({ className, ...props }, ref) {
    return <CommandPrimitive.Group ref={ref} className={cn('overflow-hidden text-text', className)} {...props} />;
});

export const CommandSeparator = forwardRef<
    ComponentRef<typeof CommandPrimitive.Separator>,
    ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(function CommandSeparator({ className, ...props }, ref) {
    return <CommandPrimitive.Separator ref={ref} className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
});

export const CommandItem = forwardRef<
    ComponentRef<typeof CommandPrimitive.Item>,
    ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(function CommandItem({ className, ...props }, ref) {
    return (
        <CommandPrimitive.Item
            ref={ref}
            className={cn(
                'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
                'data-[selected=true]:bg-surface data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
                '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-muted',
                className,
            )}
            {...props}
        />
    );
});

export function CommandShortcut({ className, ...props }: ComponentPropsWithoutRef<'span'>) {
    return <span className={cn('ml-auto text-xs tracking-widest text-text-faint', className)} {...props} />;
}
