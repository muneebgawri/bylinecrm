import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * Content = overlay + centred panel + close button. A DialogTitle is required inside it (Radix
 * warns without one and axe fails the story): a dialog with no name is a dialog nobody can find.
 */
export const DialogContent = forwardRef<
    ComponentRef<typeof DialogPrimitive.Content>,
    ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function DialogContent({ className, children, ...props }, ref) {
    return (
        <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-text/40 motion-reduce:animate-none" />
            <DialogPrimitive.Content
                ref={ref}
                className={cn(
                    'fixed left-1/2 top-1/2 z-50 flex w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4',
                    'rounded-lg border border-border bg-surface-raised p-6 text-text shadow-md',
                    // On phones every dialog is a bottom sheet: full width, anchored to the bottom,
                    // clear of the home indicator, scrolling inside itself (FR-CRMS-UI-12).
                    'max-md:inset-x-0 max-md:top-auto max-md:bottom-0 max-md:left-0 max-md:max-w-none',
                    'max-md:max-h-[85dvh] max-md:translate-x-0 max-md:translate-y-0 max-md:overflow-y-auto',
                    'max-md:rounded-b-none max-md:p-5 max-md:pb-[max(1.25rem,env(safe-area-inset-bottom))]',
                    'motion-reduce:animate-none',
                    className,
                )}
                {...props}
            >
                {children}
                <DialogPrimitive.Close
                    className={cn(
                        'absolute right-4 top-4 rounded-sm text-text-muted hover:text-text',
                        'max-md:right-2 max-md:top-2 max-md:grid max-md:size-touch max-md:place-items-center',
                        focusRing,
                    )}
                >
                    <X aria-hidden className="size-4" />
                    <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
            </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
    );
});

export const DialogTitle = forwardRef<
    ComponentRef<typeof DialogPrimitive.Title>,
    ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
    return <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold', className)} {...props} />;
});

export const DialogDescription = forwardRef<
    ComponentRef<typeof DialogPrimitive.Description>,
    ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
    return <DialogPrimitive.Description ref={ref} className={cn('text-sm text-text-muted', className)} {...props} />;
});

export function DialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn('text-sm', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn('flex justify-end gap-2', className)} {...props} />;
}
