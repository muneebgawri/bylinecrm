import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
    /** The sheet's heading — required, so the dialog has a name. */
    title: string;
    /** Spoken description; visually hidden. */
    description?: string;
    /** A sticky row under the body: the sheet's primary actions, reachable with a thumb. */
    footer?: ReactNode;
}

/**
 * A bottom sheet: the phone's form of a popover or dialog (FR-CRMS-UI-12). Rises from the bottom
 * edge, at most 85% of the viewport tall, its body scrolling between a fixed header and an
 * optional footer that stays above the home indicator. Built on Radix Dialog, so it traps focus,
 * closes on Esc and returns focus to what opened it.
 */
export const SheetContent = forwardRef<ComponentRef<typeof DialogPrimitive.Content>, SheetContentProps>(
    function SheetContent({ className, title, description, footer, children, ...props }, ref) {
        return (
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-text/35" />
                <DialogPrimitive.Content
                    ref={ref}
                    className={cn(
                        'fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-xl border-t border-border bg-surface text-text shadow-lg outline-none',
                        className,
                    )}
                    {...props}
                >
                    <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong" />
                    <div className="flex items-center gap-2 px-4 pt-2 pb-3">
                        <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
                        <DialogPrimitive.Description className="sr-only">
                            {description ?? `${title} sheet`}
                        </DialogPrimitive.Description>
                        <DialogPrimitive.Close
                            className={cn(
                                'ml-auto grid size-11 place-items-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text',
                                focusRing,
                            )}
                        >
                            <X aria-hidden className="size-5" />
                            <span className="sr-only">Close</span>
                        </DialogPrimitive.Close>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
                    {footer && (
                        <div className="flex gap-2 border-t border-border px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                            {footer}
                        </div>
                    )}
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        );
    },
);
