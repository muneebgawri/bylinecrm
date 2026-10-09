import { useSyncExternalStore } from 'react';
import type { Tone } from '../../lib/tones';

/**
 * The toast store — no UI, no Radix — so any module can call `toast()` without pulling the
 * renderer into its chunk; `Toaster.tsx` renders it and loads lazily (FR-CRMS-UI-10).
 *
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
