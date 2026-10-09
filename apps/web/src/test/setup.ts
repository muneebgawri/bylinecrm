import '@testing-library/jest-dom/vitest';

// jsdom lacks what Radix's menus call; the design system's own setup documents each stub. A spec
// that opts into the Node environment (`// @vitest-environment node`) has no DOM to stub.
if (typeof window !== 'undefined') {
    class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
    }
    globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
    Element.prototype.scrollIntoView ??= () => {};
    // The rich-text editor (ProseMirror) measures the caret to scroll it into view.
    const noRects = () =>
        ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
    Range.prototype.getClientRects ??= noRects;
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
    Element.prototype.getClientRects ??= noRects;
    Element.prototype.hasPointerCapture ??= () => false;
    // Media queries answer "no" unless a spec says otherwise (`setMedia` in a spec): desktop, fine pointer.
    window.matchMedia ??= (query: string) =>
        ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        }) as MediaQueryList;
    // A list's next page loads when its end scrolls into view; in jsdom nothing does.
    globalThis.IntersectionObserver ??= class {
        readonly root = null;
        readonly rootMargin = '';
        readonly thresholds = [];
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
            return [];
        }
    } as unknown as typeof IntersectionObserver;
}
