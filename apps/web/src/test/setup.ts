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
}
