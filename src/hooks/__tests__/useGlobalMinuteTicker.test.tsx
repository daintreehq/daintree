// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import { useGlobalMinuteTicker } from "../useGlobalMinuteTicker";

describe("useGlobalMinuteTicker", () => {
  let originalHidden: boolean;
  let visibilityState: DocumentVisibilityState;
  let visibilityListeners: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    visibilityListeners = [];
    originalHidden = document.hidden;
    visibilityState = "visible";

    Object.defineProperty(document, "hidden", {
      get: () => visibilityState === "hidden",
      configurable: true,
    });
    Object.defineProperty(document, "visibilityState", {
      get: () => visibilityState,
      configurable: true,
    });

    const origAdd = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, handler, options) => {
      if (type === "visibilitychange") {
        visibilityListeners.push(handler as () => void);
      }
      return origAdd(type, handler, options);
    });
    vi.spyOn(document, "removeEventListener").mockImplementation((type, handler, options) => {
      if (type === "visibilitychange") {
        visibilityListeners = visibilityListeners.filter((l) => l !== handler);
      }
      return origRemove(type, handler, options);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, "hidden", {
      value: originalHidden,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
      writable: true,
    });
  });

  function fireVisibilityChange(state: DocumentVisibilityState) {
    visibilityState = state;
    visibilityListeners.forEach((l) => l());
  }

  it("ticks every 30 seconds while visible", () => {
    const { result } = renderHook(() => useGlobalMinuteTicker());
    const initial = result.current;

    void act(() => vi.advanceTimersByTime(30_000));
    expect(result.current).toBe(initial + 1);

    void act(() => vi.advanceTimersByTime(30_000));
    expect(result.current).toBe(initial + 2);
  });

  it("does not tick before the 30-second boundary", () => {
    const { result } = renderHook(() => useGlobalMinuteTicker());
    const initial = result.current;

    void act(() => vi.advanceTimersByTime(29_999));
    expect(result.current).toBe(initial);

    void act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(initial + 1);
  });

  it("stops ticking when hidden and resumes on visible", () => {
    const { result } = renderHook(() => useGlobalMinuteTicker());
    const initial = result.current;

    void act(() => vi.advanceTimersByTime(30_000));
    expect(result.current).toBe(initial + 1);

    void act(() => fireVisibilityChange("hidden"));
    const tickAfterHide = result.current;

    void act(() => vi.advanceTimersByTime(150_000));
    expect(result.current).toBe(tickAfterHide);

    void act(() => fireVisibilityChange("visible"));
    // Immediate catch-up tick on restore
    expect(result.current).toBe(tickAfterHide + 1);
  });

  it("does not start interval when mounted while hidden", () => {
    visibilityState = "hidden";
    const { result } = renderHook(() => useGlobalMinuteTicker());
    const initial = result.current;

    void act(() => vi.advanceTimersByTime(150_000));
    expect(result.current).toBe(initial);

    void act(() => fireVisibilityChange("visible"));
    expect(result.current).toBe(initial + 1);

    void act(() => vi.advanceTimersByTime(30_000));
    expect(result.current).toBe(initial + 2);
  });

  it("shares a single interval across multiple subscribers", () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    const a = renderHook(() => useGlobalMinuteTicker());
    const b = renderHook(() => useGlobalMinuteTicker());

    const minuteTickerCalls = setIntervalSpy.mock.calls.filter(
      ([, delay]) => delay === 30_000
    ).length;
    expect(minuteTickerCalls).toBe(1);

    void act(() => vi.advanceTimersByTime(30_000));
    expect(a.result.current).toBe(b.result.current);
  });

  it("cleans up interval and listener on last unmount", () => {
    const { unmount } = renderHook(() => useGlobalMinuteTicker());
    expect(visibilityListeners.length).toBeGreaterThan(0);

    unmount();
    expect(visibilityListeners.length).toBe(0);
  });
  describe("in a cached project view (#12514)", () => {
    // A cached view's document stays "visible", so only main's lifecycle IPC
    // can stop the ticker. Drives the real `viewCacheState` singleton.
    let handlers: { cached: Set<() => void>; warm: Set<() => void>; revealed: Set<() => void> };
    let latchedCached: boolean;

    beforeEach(() => {
      handlers = { cached: new Set(), warm: new Set(), revealed: new Set() };
      latchedCached = false;
      vi.stubGlobal("electron", {
        app: {
          onViewCached: (cb: () => void) => {
            handlers.cached.add(cb);
            return () => handlers.cached.delete(cb);
          },
          onViewWarmActivated: (cb: () => void) => {
            handlers.warm.add(cb);
            return () => handlers.warm.delete(cb);
          },
          onViewRevealed: (cb: () => void) => {
            handlers.revealed.add(cb);
            return () => handlers.revealed.delete(cb);
          },
          isViewCached: () => latchedCached,
        },
      });
      __resetProjectViewCacheStateForTests();
    });

    afterEach(() => {
      __resetProjectViewCacheStateForTests();
      vi.unstubAllGlobals();
    });

    function emit(set: Set<() => void>) {
      void act(() => set.forEach((handler) => handler()));
    }

    it("stops ticking while cached and catches up once on activation, not again on reveal", () => {
      const { result, unmount } = renderHook(() => useGlobalMinuteTicker());
      const initial = result.current;

      emit(handlers.cached);
      void act(() => vi.advanceTimersByTime(150_000));
      expect(result.current).toBe(initial);

      emit(handlers.warm);
      expect(result.current).toBe(initial + 1);

      emit(handlers.revealed);
      expect(result.current).toBe(initial + 1);

      void act(() => vi.advanceTimersByTime(30_000));
      expect(result.current).toBe(initial + 2);

      unmount();
    });

    it("does not start the interval when first mounted inside a cached view", () => {
      latchedCached = true;
      const { result, unmount } = renderHook(() => useGlobalMinuteTicker());
      const initial = result.current;

      expect(vi.getTimerCount()).toBe(0);
      void act(() => vi.advanceTimersByTime(150_000));
      expect(result.current).toBe(initial);

      emit(handlers.warm);
      expect(result.current).toBe(initial + 1);
      expect(vi.getTimerCount()).toBe(1);

      unmount();
    });

    it("ignores a window restore underneath a cached view", () => {
      const { result, unmount } = renderHook(() => useGlobalMinuteTicker());
      const initial = result.current;

      emit(handlers.cached);
      void act(() => fireVisibilityChange("hidden"));
      void act(() => fireVisibilityChange("visible"));

      expect(result.current).toBe(initial);
      expect(vi.getTimerCount()).toBe(0);

      unmount();
    });

    it("drops the lifecycle subscription on last unmount", () => {
      const { unmount } = renderHook(() => useGlobalMinuteTicker());
      emit(handlers.cached);
      unmount();

      emit(handlers.warm);

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
