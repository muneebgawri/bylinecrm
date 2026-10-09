import { useCallback, useState } from 'react';

/**
 * State that belongs to a key and starts over when the key changes (a column draft belongs to the
 * view it was made on; a selection to the query it was made in). The value is stored with its key
 * and read back only while the key is the same — no effect resets it after the fact.
 */
export function useKeyedState<T>(key: string, initial: T): [T, (next: T | ((current: T) => T)) => void] {
    const [stored, setStored] = useState<{ key: string; value: T }>({ key, value: initial });
    const value = stored.key === key ? stored.value : initial;
    const set = useCallback(
        (next: T | ((current: T) => T)) =>
            setStored((current) => {
                const base = current.key === key ? current.value : initial;
                return { key, value: typeof next === 'function' ? (next as (c: T) => T)(base) : next };
            }),
        [key, initial],
    );
    return [value, set];
}
