// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useScrollIndicator } from "../useScrollIndicator";

// Controllable rAF queue so we can assert the scroll path coalesces a burst of
// Virtuoso onScroll callbacks into a single in-flight frame (issue #9580).
let rafQueue: Map<number, FrameRequestCallback>;
let nextRafId: number;
let rafSpy: ReturnType<typeof vi.spyOn>;
let cancelSpy: ReturnType<typeof vi.spyOn>;

class MockResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function flushFrames() {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  act(() => {
    for (const cb of pending) cb(0);
  });
}

function makeScroller(metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { value: metrics.scrollTop, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: metrics.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: metrics.clientHeight, configurable: true });
  return el;
}

beforeEach(() => {
  rafQueue = new Map();
  nextRafId = 0;
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const id = ++nextRafId;
    rafQueue.set(id, cb);
    return id;
  });
  cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    rafQueue.delete(id as number);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useScrollIndicator scroll rAF throttle (issue #9580)", () => {
  it("coalesces a burst of handleScroll calls into a single frame", () => {
    const { result } = renderHook(() => useScrollIndicator({ itemCount: 100 }));
    const scroller = makeScroller({ scrollTop: 50, scrollHeight: 1000, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });

    rafSpy.mockClear();
    act(() => {
      result.current.handleScroll();
      result.current.handleScroll();
      result.current.handleScroll();
    });

    expect(rafSpy).toHaveBeenCalledTimes(1);
    expect(rafQueue.size).toBe(1);
  });

  it("updates indicator counts when the coalesced frame flushes", () => {
    const { result } = renderHook(() => useScrollIndicator({ itemCount: 100 }));
    const scroller = makeScroller({ scrollTop: 50, scrollHeight: 1000, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });

    act(() => {
      result.current.handleScroll();
    });
    flushFrames();

    // totalHidden 90, scrollFraction ≈ 0.0556 → above 5, below 85.
    expect(result.current.hiddenAbove).toBe(5);
    expect(result.current.hiddenBelow).toBe(85);
  });

  it("cancels a pending scroll frame when the scroller detaches", () => {
    const { result } = renderHook(() => useScrollIndicator({ itemCount: 100 }));
    const scroller = makeScroller({ scrollTop: 50, scrollHeight: 1000, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });

    act(() => {
      result.current.handleScroll();
    });
    expect(rafQueue.size).toBe(1);

    cancelSpy.mockClear();
    act(() => {
      result.current.scrollerRef(null);
    });
    expect(cancelSpy).toHaveBeenCalled();
    expect(rafQueue.size).toBe(0);
  });

  it("cancels a pending scroll frame on unmount", () => {
    const { result, unmount } = renderHook(() => useScrollIndicator({ itemCount: 100 }));
    const scroller = makeScroller({ scrollTop: 50, scrollHeight: 1000, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });

    act(() => {
      result.current.handleScroll();
    });
    expect(rafQueue.size).toBe(1);

    cancelSpy.mockClear();
    act(() => {
      unmount();
    });
    expect(cancelSpy).toHaveBeenCalled();
    expect(rafQueue.size).toBe(0);
  });
});
