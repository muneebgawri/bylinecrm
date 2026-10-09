import { useSyncExternalStore } from 'react';

/**
 * The widths the product changes layout at — one definition for CSS and script (FR-CRMS-UI-12).
 *
 * `mobile` is Tailwind's `md` (`--breakpoint-md: 48rem` in `theme.css`; a spec keeps the two
 * equal): below it a screen is a phone — one column, bottom sheets, 44px touch targets, 16px
 * inputs. CSS uses `max-md:`; script uses `useIsMobile()`. `narrow` is where the shell's sidebar
 * becomes a drawer (mockup v3); it is a layout width of the shell, not a second "mobile".
 */
export const BREAKPOINT_PX = { mobile: 768, narrow: 900 } as const;

/** Below `mobile`: the phone layout. The .98 avoids a gap at exactly 767.5px on fractional zoom. */
export const MOBILE_QUERY = `(max-width: ${BREAKPOINT_PX.mobile - 0.02}px)`;
export const NARROW_QUERY = `(max-width: ${BREAKPOINT_PX.narrow}px)`;
/** A touch screen as the main pointer: no drag-and-drop, explicit buttons instead. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** Whether a media query matches, re-rendering when it changes. `false` where there is no window. */
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

export const useIsMobile = (): boolean => useMediaQuery(MOBILE_QUERY);
export const useIsNarrow = (): boolean => useMediaQuery(NARROW_QUERY);
export const useCoarsePointer = (): boolean => useMediaQuery(COARSE_POINTER_QUERY);
