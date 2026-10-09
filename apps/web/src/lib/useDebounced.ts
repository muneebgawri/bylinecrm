import { useEffect, useState } from 'react';

/** How long typing must pause before a search is sent: one value for every search field. */
export const SEARCH_DEBOUNCE_MS = 250;

/** `value`, once it has stopped changing for `delay` milliseconds. */
export function useDebounced<T>(value: T, delay: number = SEARCH_DEBOUNCE_MS): T {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setSettled(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return settled;
}
