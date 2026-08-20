// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGlobalBannerHeightVar, GLOBAL_BANNER_HEIGHT_VAR } from "../useGlobalBannerHeightVar";

/** One observed element plus the callback the hook registered for it. */
interface Registered {
  callback: (entries: ResizeObserverEntry[]) => void;
  observed: Element[];
}

function readVar(): string {
  return document.documentElement.style.getPropertyValue(GLOBAL_BANNER_HEIGHT_VAR);
}

/** A div whose measured top edge is `top`, standing in for the toolbar wrapper. */
function elementWithTop(top: number): HTMLDivElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top }) as DOMRect;
  return el;
}

describe("useGlobalBannerHeightVar", () => {
  let registered: Registered[] = [];
  let rafCallbacks: (() => void)[] = [];

  beforeEach(() => {
    registered = [];
    rafCallbacks = [];

    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function ResizeObserverMock(
        this: ResizeObserver | void,
        cb: (entries: ResizeObserverEntry[]) => void
      ) {
        const entry: Registered = { callback: cb, observed: [] };
        registered.push(entry);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return {
          observe: vi.fn((el: Element) => entry.observed.push(el)),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
        } as unknown as ResizeObserver;
      })
    );

    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: () => void) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      })
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn(() => {
        rafCallbacks = [];
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty(GLOBAL_BANNER_HEIGHT_VAR);
  });

  function flushRaf() {
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    for (const cb of cbs) cb();
  }

  /** Drive the observer that was subscribed to `el`. */
  function fireResizeFor(el: Element) {
    const match = registered.find((r) => r.observed.includes(el));
    if (!match) throw new Error("no observer subscribed to that element");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    match.callback([{ target: el } as unknown as ResizeObserverEntry]);
    flushRaf();
  }

  it("publishes the toolbar wrapper's top edge as the banner height", () => {
    const toolbarWrap = elementWithTop(72);
    const contentRow = document.createElement("div");

    renderHook(() => useGlobalBannerHeightVar(toolbarWrap, contentRow));
    fireResizeFor(contentRow);

    // A 72px top edge means a 72px banner is sitting above the toolbar.
    expect(readVar()).toBe("72px");
  });

  it("publishes 0px when no banner is pushing the toolbar down", () => {
    const toolbarWrap = elementWithTop(0);
    const contentRow = document.createElement("div");

    renderHook(() => useGlobalBannerHeightVar(toolbarWrap, contentRow));
    fireResizeFor(contentRow);

    expect(readVar()).toBe("0px");
  });

  it("clamps a negative top edge to 0px", () => {
    // Guards the Math.max: a negative offset would pull the overlays UP, back
    // under the toolbar — the exact clipping this fix exists to prevent.
    const toolbarWrap = elementWithTop(-30);
    const contentRow = document.createElement("div");

    renderHook(() => useGlobalBannerHeightVar(toolbarWrap, contentRow));
    fireResizeFor(contentRow);

    expect(readVar()).toBe("0px");
  });

  it("republishes when the banner height changes", () => {
    let top = 40;
    const toolbarWrap = document.createElement("div");
    toolbarWrap.getBoundingClientRect = () =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top }) as DOMRect;
    const contentRow = document.createElement("div");

    renderHook(() => useGlobalBannerHeightVar(toolbarWrap, contentRow));
    fireResizeFor(contentRow);
    expect(readVar()).toBe("40px");

    // Banner text reflows to a second line: the content row shrinks, so the
    // observer fires again and the published value must follow.
    top = 64;
    fireResizeFor(contentRow);
    expect(readVar()).toBe("64px");
  });

  it("also republishes when only the toolbar wrapper resizes", () => {
    // FleetArmingRibbon toggling changes the wrapper's own height without
    // necessarily changing the content row's — e.g. a banner that grows by
    // exactly as much as the ribbon shrinks. Without this second subscription
    // that cancellation would leave the published value stale.
    let top = 40;
    const toolbarWrap = document.createElement("div");
    toolbarWrap.getBoundingClientRect = () =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top }) as DOMRect;
    const contentRow = document.createElement("div");

    renderHook(() => useGlobalBannerHeightVar(toolbarWrap, contentRow));

    top = 96;
    fireResizeFor(toolbarWrap);
    expect(readVar()).toBe("96px");
  });

  it("observes both the content row and the toolbar wrapper", () => {
    const toolbarWrap = elementWithTop(0);
    const contentRow = document.createElement("div");

    renderHook(() => useGlobalBannerHeightVar(toolbarWrap, contentRow));

    const allObserved = registered.flatMap((r) => r.observed);
    expect(allObserved).toContain(contentRow);
    expect(allObserved).toContain(toolbarWrap);
  });

  it("removes the custom property on unmount", () => {
    // The var lives on documentElement, so a stale value would outlive the
    // AppLayout instance that published it.
    const toolbarWrap = elementWithTop(72);
    const contentRow = document.createElement("div");

    const { unmount } = renderHook(() => useGlobalBannerHeightVar(toolbarWrap, contentRow));
    fireResizeFor(contentRow);
    expect(readVar()).toBe("72px");

    unmount();
    expect(readVar()).toBe("");
  });

  it("subscribes nothing until the elements exist", () => {
    renderHook(() => useGlobalBannerHeightVar(null, null));

    expect(ResizeObserver).not.toHaveBeenCalled();
    expect(readVar()).toBe("");
  });
});
