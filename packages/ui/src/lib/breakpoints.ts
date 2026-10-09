import { useSyncExternalStore } from 'react';

/**
 * The widths at which the layout changes — one definition. Components and the shell read these
 * (or the hooks below); none spells a pixel width of its own.
 *
 * - `phone` (FR-CRMS-UI-12): below it, tables become stacked cards, popovers become bottom sheets
 *   and selection actions move to a bottom bar. Tailwind's `md:` variant is the same width —
 *   `theme.css` declares `--breakpoint-md: 48rem` and a spec holds the two equal.
 * - `shell` (mockup v3): at or below it the sidebar is a drawer and search collapses to an icon.
 */
export const BREAKPOINTS = { phone: 768, shell: 900 } as const;

/** Matches a viewport narrower than `phone`. */
export const PHONE_QUERY = `(max-width: ${BREAKPOINTS.phone - 1}px)`;
/** Matches a viewport at or below `shell`. */
export const NARROW_QUERY = `(max-width: ${BREAKPOINTS.shell}px)`;

/** Whether a media query matches now, kept current as the viewport changes. */
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

/** True below the phone breakpoint. */
export function usePhone(): boolean {
    return useMediaQuery(PHONE_QUERY);
}

/** True at or below the shell breakpoint. */
export function useIsNarrow(): boolean {
    return useMediaQuery(NARROW_QUERY);
}
