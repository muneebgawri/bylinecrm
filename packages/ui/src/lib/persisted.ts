import { useCallback, useState } from 'react';

/**
 * Per-viewer preferences in localStorage (theme, density, sidebar collapsed, palette recents).
 * Storage can throw or be empty — private windows, blocked site data — so a preference that
 * cannot be read is the default and one that cannot be written still applies for the page.
 * One definition: the theme provider and the shell both read and write through these.
 */
export function readStored<T>(key: string, guard: (value: unknown) => value is T, fallback: T): T {
    try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return fallback;
        const parsed: unknown =
            raw.startsWith('{') || raw.startsWith('[') || raw.startsWith('"') ? JSON.parse(raw) : raw;
        return guard(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

export function writeStored(key: string, value: unknown): void {
    try {
        window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch {
        // Nothing to do: the choice still applies for this page; it just will not persist.
    }
}

/** `useState` whose value survives a reload under `key`. */
export function usePersistedState<T>(
    key: string,
    guard: (value: unknown) => value is T,
    fallback: T,
): [T, (next: T | ((current: T) => T)) => void] {
    const [value, setValue] = useState<T>(() => readStored(key, guard, fallback));
    const set = useCallback(
        (next: T | ((current: T) => T)) => {
            setValue((current) => {
                const resolved = typeof next === 'function' ? (next as (current: T) => T)(current) : next;
                writeStored(key, resolved);
                return resolved;
            });
        },
        [key],
    );
    return [value, set];
}

export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
export const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((v) => typeof v === 'string');
