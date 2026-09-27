import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// With vitest globals disabled, RTL cannot register cleanup itself.
afterEach(cleanup);

// jsdom does not implement scrollTo (TanStack Router calls it on navigation),
// pointer capture (Radix toast swipe) nor scrollIntoView (cmdk) — stub all.
if (typeof window !== "undefined" && !window.scrollTo) {
  window.scrollTo = () => {};
}
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView ??= () => {};
}
if (typeof Element !== "undefined") {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
}

// jsdom does not implement matchMedia nor ResizeObserver (cmdk measures its list).
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
if (typeof window !== "undefined" && !("DOMMatrixReadOnly" in window)) {
  // @xyflow/system reads `.m22` (viewport zoom) when measuring handles.
  class DOMMatrixReadOnlyStub {
    m22 = 1;
    constructor() {}
  }
  (window as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
}

if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  const entry = (target: Element): ResizeObserverEntry =>
    ({
      target,
      contentRect: { x: 0, y: 0, width: 240, height: 88, top: 0, left: 0, right: 240, bottom: 88 },
      // react-resizable-panels v4 reads the boxed sizes (arrays in the spec).
      contentBoxSize: [{ inlineSize: 240, blockSize: 88 }],
      borderBoxSize: [{ inlineSize: 240, blockSize: 88 }],
      devicePixelContentBoxSize: [{ inlineSize: 240, blockSize: 88 }],
    }) as unknown as ResizeObserverEntry;
  class ResizeObserverStub {
    observe(target: Element) {
      // React Flow needs a measured size before it renders edges; jsdom has no
      // layout, so report a card-sized rect immediately.
      queueMicrotask(() => this.callback([entry(target)], this as unknown as ResizeObserver));
    }
    unobserve() {}
    disconnect() {}
    constructor(private callback: ResizeObserverCallback) {}
  }
  (window as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}
