import * as ToastPrimitive from '@radix-ui/react-toast';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';
import { toneSolid } from '../../lib/tones';
import { TOAST_DURATION_MS, toasts, useToasts, type ToastStore } from './toast-store';

export interface ToasterProps {
    store?: ToastStore;
    /** The viewport's accessible name. */
    label?: string;
}

/** Mount once, near the root. Renders the store's toasts bottom-right; Escape and the X dismiss. */
export function Toaster({ store = toasts, label = 'Notifications' }: ToasterProps) {
    const records = useToasts(store);
    return (
        <ToastPrimitive.Provider swipeDirection="right" label={label}>
            {records.map((record) => (
                <ToastPrimitive.Root
                    key={record.id}
                    duration={record.durationMs ?? TOAST_DURATION_MS[record.tone === 'danger' ? 'danger' : 'default']}
                    onOpenChange={(open) => {
                        if (!open) store.dismiss(record.id);
                    }}
                    className={cn(
                        'relative flex w-full items-start gap-3 overflow-hidden rounded-lg border border-border bg-surface p-4 pr-10 text-sm text-text shadow-lg',
                        'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]',
                        'motion-reduce:transition-none',
                    )}
                >
                    <span
                        aria-hidden
                        className={cn('mt-1.5 size-2 shrink-0 rounded-full', toneSolid[record.tone ?? 'neutral'])}
                    />
                    <div className="min-w-0">
                        <ToastPrimitive.Title className="font-medium">{record.title}</ToastPrimitive.Title>
                        {record.description && (
                            <ToastPrimitive.Description className="mt-0.5 text-text-muted">
                                {record.description}
                            </ToastPrimitive.Description>
                        )}
                    </div>
                    <ToastPrimitive.Close
                        aria-label="Dismiss"
                        className={cn('absolute right-3 top-3 rounded-sm text-text-muted hover:text-text', focusRing)}
                    >
                        <X aria-hidden className="size-4" />
                    </ToastPrimitive.Close>
                </ToastPrimitive.Root>
            ))}
            <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2 outline-none" />
        </ToastPrimitive.Provider>
    );
}
