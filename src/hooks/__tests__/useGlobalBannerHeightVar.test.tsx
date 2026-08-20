// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGlobalBannerHeightVar, GLOBAL_BANNER_HEIGHT_VAR } from "../useGlobalBannerHeightVar";

function readVar(): string {
  return document.documentElement.style.getPropertyValue(GLOBAL_BANNER_HEIGHT_VAR);
}

describe("useGlobalBannerHeightVar", () => {
  let observerCallback: ((entries: ResizeObserverEntry[]) => void) | null = null;
  let observed: Element[] = [];
  let rafCallbacks: (() => void)[] = [];

  /** A stand-in banner wrapper whose measured height is controlled by `height`. */
  function bannerWrapper(height: number) {
    const el = document.createElement("div");
    let current = height;
    el.getBoundingClientRect = () =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      ({
        height: current,
        top: 0,
        bottom: current,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 0,
      }) as DOMRect;
    return {
      el,
      setHeight(next: number) {
        current = next;
      },
    };
  }

  beforeEach(() => {
    observerCallback = null;
    observed = [];
    rafCallbacks = [];

    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function ResizeObserverMock(
        this: ResizeObserver | void,
        cb: (entries: ResizeObserverEntry[]) => void
      ) {
        observerCallback = cb;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return {
          observe: vi.fn((el: Element) => observed.push(el)),
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

  /** Deliver a resize notification and run the rAF the hook coalesces onto. */
  function fireResize(el: Element) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    observerCallback?.([{ target: el } as unknown as ResizeObserverEntry]);
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    for (const cb of cbs) cb();
  }

  it("publishes the measured banner height", () => {
    const banner = bannerWrapper(72);

    renderHook(() => useGlobalBannerHeightVar(banner.el));
    fireResize(banner.el);

    expect(readVar()).toBe("72px");
  });

  it("publishes 0px when the coordinator renders no banner", () => {
    // GlobalBannerCoordinator returns null with no active slot, collapsing the
    // wrapper — which must resolve to the same offset as the pre-#11893 top-12.
    const banner = bannerWrapper(0);

    renderHook(() => useGlobalBannerHeightVar(banner.el));
    fireResize(banner.el);

    expect(readVar()).toBe("0px");
  });

  it("clamps a negative measurement to 0px", () => {
    // Guards the Math.max: a negative offset would pull the overlays UP, back
    // under the toolbar — the exact clipping this fix exists to prevent.
    const banner = bannerWrapper(-30);

    renderHook(() => useGlobalBannerHeightVar(banner.el));
    fireResize(banner.el);

    expect(readVar()).toBe("0px");
  });

  it("republishes when the banner reflows to a taller height", () => {
    const banner = bannerWrapper(40);

    renderHook(() => useGlobalBannerHeightVar(banner.el));
    fireResize(banner.el);
    expect(readVar()).toBe("40px");

    // Banner description wraps to a second line.
    banner.setHeight(64);
    fireResize(banner.el);
    expect(readVar()).toBe("64px");
  });

  it("does not publish synchronously — the write is rAF-coalesced", () => {
    // The house convention (rendererGlobalErrorHandlers.ts) is that our own
    // observers rAF-defer rather than writing layout-affecting values inside the
    // ResizeObserver callback.
    const banner = bannerWrapper(72);

    renderHook(() => useGlobalBannerHeightVar(banner.el));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    observerCallback?.([{ target: banner.el } as unknown as ResizeObserverEntry]);

    expect(readVar()).toBe("");
  });

  it("observes the element it was given", () => {
    const banner = bannerWrapper(0);

    renderHook(() => useGlobalBannerHeightVar(banner.el));

    expect(observed).toContain(banner.el);
  });

  it("removes the custom property on unmount", () => {
    // The var lives on documentElement, so a stale value would outlive the
    // AppLayout instance that published it.
    const banner = bannerWrapper(72);

    const { unmount } = renderHook(() => useGlobalBannerHeightVar(banner.el));
    fireResize(banner.el);
    expect(readVar()).toBe("72px");

    unmount();
    expect(readVar()).toBe("");
  });

  it("subscribes nothing before the wrapper exists", () => {
    renderHook(() => useGlobalBannerHeightVar(null));

    expect(ResizeObserver).not.toHaveBeenCalled();
    expect(readVar()).toBe("");
  });
});
