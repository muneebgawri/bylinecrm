import { useSyncExternalStore } from 'react';

/** The breakpoint under which the sidebar becomes a drawer and search collapses to an icon (mockup v3). */
export const NARROW_QUERY = '(max-width: 900px)';

export function useMediaQuery(query: string): boolean {
    return useSyncExternalStore(
        (notify) => {
            const list = window.matchMedia(query);
            list.addEventListener('change', notify);
            return () => list.removeEventListener('change', notify);
        },
        () => window.matchMedia(query).matches,
        () => false,
    );
}

export function useIsNarrow(): boolean {
    return useMediaQuery(NARROW_QUERY);
}
