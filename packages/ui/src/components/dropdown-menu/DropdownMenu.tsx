import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '../../lib/cn';
import { popoverSurface } from '../../lib/surfaces';

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuSub = MenuPrimitive.Sub;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

const itemClasses = [
    'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-text outline-none',
    'data-[highlighted]:bg-surface data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
    '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-muted',
];

export const DropdownMenuContent = forwardRef<
    ComponentRef<typeof MenuPrimitive.Content>,
    ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 4, ...props }, ref) {
    return (
        <MenuPrimitive.Portal>
            <MenuPrimitive.Content
                ref={ref}
                sideOffset={sideOffset}
                className={cn(popoverSurface, 'min-w-40 p-1', className)}
                {...props}
            />
        </MenuPrimitive.Portal>
    );
});

export const DropdownMenuSubTrigger = forwardRef<
    ComponentRef<typeof MenuPrimitive.SubTrigger>,
    ComponentPropsWithoutRef<typeof MenuPrimitive.SubTrigger>
>(function DropdownMenuSubTrigger({ className, children, ...props }, ref) {
    return (
        <MenuPrimitive.SubTrigger
            ref={ref}
            className={cn(itemClasses, 'data-[state=open]:bg-surface', className)}
            {...props}
        >
            {children}
            <ChevronRight aria-hidden className="ml-auto" />
        </MenuPrimitive.SubTrigger>
    );
});

export const DropdownMenuSubContent = forwardRef<
    ComponentRef<typeof MenuPrimitive.SubContent>,
    ComponentPropsWithoutRef<typeof MenuPrimitive.SubContent>
>(function DropdownMenuSubContent({ className, ...props }, ref) {
    return (
        <MenuPrimitive.Portal>
            <MenuPrimitive.SubContent ref={ref} className={cn(popoverSurface, 'min-w-40 p-1', className)} {...props} />
        </MenuPrimitive.Portal>
    );
});

export const DropdownMenuItem = forwardRef<
    ComponentRef<typeof MenuPrimitive.Item>,
    ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & { destructive?: boolean }
>(function DropdownMenuItem({ className, destructive = false, ...props }, ref) {
    return (
        <MenuPrimitive.Item
            ref={ref}
            className={cn(itemClasses, destructive && 'text-danger [&_svg]:text-danger', className)}
            {...props}
        />
    );
});

export const DropdownMenuCheckboxItem = forwardRef<
    ComponentRef<typeof MenuPrimitive.CheckboxItem>,
    ComponentPropsWithoutRef<typeof MenuPrimitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, children, ...props }, ref) {
    return (
        <MenuPrimitive.CheckboxItem ref={ref} className={cn(itemClasses, 'pl-8', className)} {...props}>
            <span className="absolute left-2 flex size-4 items-center justify-center">
                <MenuPrimitive.ItemIndicator>
                    <Check aria-hidden />
                </MenuPrimitive.ItemIndicator>
            </span>
            {children}
        </MenuPrimitive.CheckboxItem>
    );
});

export const DropdownMenuRadioItem = forwardRef<
    ComponentRef<typeof MenuPrimitive.RadioItem>,
    ComponentPropsWithoutRef<typeof MenuPrimitive.RadioItem>
>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
    return (
        <MenuPrimitive.RadioItem ref={ref} className={cn(itemClasses, 'pl-8', className)} {...props}>
            <span className="absolute left-2 flex size-4 items-center justify-center">
                <MenuPrimitive.ItemIndicator>
                    <Check aria-hidden />
                </MenuPrimitive.ItemIndicator>
            </span>
            {children}
        </MenuPrimitive.RadioItem>
    );
});

export const DropdownMenuLabel = forwardRef<
    ComponentRef<typeof MenuPrimitive.Label>,
    ComponentPropsWithoutRef<typeof MenuPrimitive.Label>
>(function DropdownMenuLabel({ className, ...props }, ref) {
    return (
        <MenuPrimitive.Label
            ref={ref}
            className={cn('px-2 py-1.5 text-xs font-medium text-text-muted', className)}
            {...props}
        />
    );
});

export const DropdownMenuSeparator = forwardRef<
    ComponentRef<typeof MenuPrimitive.Separator>,
    ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>
>(function DropdownMenuSeparator({ className, ...props }, ref) {
    return <MenuPrimitive.Separator ref={ref} className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
});

export function DropdownMenuShortcut({ className, ...props }: ComponentPropsWithoutRef<'span'>) {
    return <span className={cn('ml-auto text-xs tracking-widest text-text-faint', className)} {...props} />;
}
