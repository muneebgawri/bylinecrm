import * as ToastPrimitive from '@radix-ui/react-toast';
import { X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';
import { toneSolid, type Tone } from '../../lib/tones';

/**
 * Toasts: a short notice about something that just happened — a move the server refused, a
 * copy that worked. One store feeds one `Toaster`; any code (a hook, a mutation's error handler)
 * calls `toast()` without reaching for React context. The notice names what happened and, when
 * it was a refusal, the server's reason — never a vague "something went wrong".
 */
export interface ToastInput {
    title: string;
    description?: string | undefined;
    /** The meaning, not a colour: `danger` for a refusal, `success` for a confirmation. */
    tone?: Tone | undefined;
    /** How long it stays; a refusal stays longer so the reason can be read. */
    durationMs?: number | undefined;
}

export interface ToastRecord extends ToastInput {
    id: number;
}

/** A refusal is read, not glimpsed. */
export const TOAST_DURATION_MS = { default: 5_000, danger: 8_000 } as const;
/** More than this and the newest replaces the oldest; a toast is not a log. */
export const TOAST_LIMIT = 3;

type Listener = () => void;

export class ToastStore {
    private records: readonly ToastRecord[] = [];
    private readonly listeners = new Set<Listener>();
    private nextId = 1;

    push(input: ToastInput): number {
        const id = this.nextId++;
        this.records = [...this.records, { ...input, id }].slice(-TOAST_LIMIT);
        this.changed();
        return id;
    }

    dismiss(id: number): void {
        if (!this.records.some((r) => r.id === id)) return;
        this.records = this.records.filter((r) => r.id !== id);
        this.changed();
    }

    clear(): void {
        this.records = [];
        this.changed();
    }

    all(): readonly ToastRecord[] {
        return this.records;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private changed(): void {
        this.listeners.forEach((listener) => listener());
    }
}

/** The app's one store. */
export const toasts = new ToastStore();

/** Shows a toast; returns its id so a caller can dismiss it early. */
export function toast(input: ToastInput): number {
    return toasts.push(input);
}

export function useToasts(store: ToastStore = toasts): readonly ToastRecord[] {
    return useSyncExternalStore(
        (listener) => store.subscribe(listener),
        () => store.all(),
        () => store.all(),
    );
}

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
