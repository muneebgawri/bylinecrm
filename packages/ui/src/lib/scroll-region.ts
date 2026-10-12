import { useEffect, useState, type RefObject } from 'react';

/**
 * Whether an element scrolls sideways (WCAG 2.1.1, axe `scrollable-region-focusable`). A region that
 * overflows must be reachable by keyboard so its hidden part can be scrolled into view; one that fits
 * must not add a tab stop. Re-measured whenever the element or its content changes size.
 */
export function useScrollsHorizontally(ref: RefObject<HTMLElement | null>): boolean {
    const [scrolls, setScrolls] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => setScrolls(el.scrollWidth > el.clientWidth);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        if (el.firstElementChild) observer.observe(el.firstElementChild);
        return () => observer.disconnect();
    }, [ref]);
    return scrolls;
}
