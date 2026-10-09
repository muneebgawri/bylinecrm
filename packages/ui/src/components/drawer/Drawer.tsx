import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerClose = DialogPrimitive.Close;

export interface DrawerContentProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
    /** The sticky header's heading — required, a panel with no name is a panel nobody can find. */
    title: string;
    /** Buttons in the header, right of the title. */
    actions?: ReactNode;
    side?: 'right' | 'left';
    /** 560px on the right for records; the sidebar drawer under 900px is narrower. */
    width?: 'md' | 'sm';
    /** Spoken description; visually hidden. */
    description?: string;
}

const WIDTH = { md: 'w-[min(560px,100vw)]', sm: 'w-[min(300px,100vw)]' } as const;

/**
 * A side panel on Radix Dialog: scrim, focus trap, Esc closes, focus returns to the trigger.
 * The header is sticky so the title and its actions stay while the body scrolls.
 */
export const DrawerContent = forwardRef<ComponentRef<typeof DialogPrimitive.Content>, DrawerContentProps>(
    function DrawerContent(
        { className, title, actions, side = 'right', width = 'md', description, children, ...props },
        ref,
    ) {
        return (
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim" />
                <DialogPrimitive.Content
                    ref={ref}
                    className={cn(
                        'fixed inset-y-0 z-50 flex flex-col overflow-y-auto border-border bg-surface text-text shadow-lg',
                        side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
                        WIDTH[width],
                        className,
                    )}
                    {...props}
                >
                    <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-border bg-surface px-5.5 py-4">
                        <DialogPrimitive.Close
                            className={cn(
                                'grid size-8.5 shrink-0 place-items-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text max-md:size-touch',
                                focusRing,
                            )}
                        >
                            <X aria-hidden className="size-4.5" />
                            <span className="sr-only">Close</span>
                        </DialogPrimitive.Close>
                        <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
                        <DialogPrimitive.Description className="sr-only">
                            {description ?? `${title} panel`}
                        </DialogPrimitive.Description>
                        {actions && <div className="ml-auto flex gap-2">{actions}</div>}
                    </div>
                    {children}
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        );
    },
);

/** A titled section inside a drawer: heading, optional count chip, an action on the right. */
export function DrawerSection({
    title,
    count,
    action,
    children,
    className,
}: {
    title: string;
    count?: number;
    action?: ReactNode;
    children?: ReactNode;
    className?: string;
}) {
    return (
        <section className={className}>
            <div className="flex items-center gap-2.5 px-5.5 pt-4.5 pb-1.5">
                <h4 className="text-[15px] font-semibold">{title}</h4>
                {count !== undefined && (
                    <span className="grid h-5.5 min-w-5.5 place-items-center rounded-full bg-warning-soft px-1.75 text-xs font-semibold text-warning tabular-nums">
                        {count}
                    </span>
                )}
                {action && <div className="ml-auto">{action}</div>}
            </div>
            {children}
        </section>
    );
}
