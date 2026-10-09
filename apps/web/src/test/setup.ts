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
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};

    // jsdom has no layout, so no media queries. This one answers `(max-width: Npx)` against
    // `window.innerWidth` (jsdom's default is 1024): a spec sets the width to see the phone layout.
    window.matchMedia ??= (query: string) => {
        const max = /\(max-width:\s*(\d+)px\)/.exec(query);
        return {
            matches: max ? window.innerWidth <= Number(max[1]) : false,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        } as MediaQueryList;
    };
    globalThis.IntersectionObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
            return [];
        }
    } as unknown as typeof IntersectionObserver;
}
