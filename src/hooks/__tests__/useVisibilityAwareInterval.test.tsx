// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import { useVisibilityAwareInterval } from "../useVisibilityAwareInterval";

describe("useVisibilityAwareInterval", () => {
  let visibilityState: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    visibilityState = "visible";
    Object.defineProperty(document, "hidden", {
      get: () => visibilityState === "hidden",
      configurable: true,
    });
    Object.defineProperty(document, "visibilityState", {
      get: () => visibilityState,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setVisibility(state: DocumentVisibilityState) {
    visibilityState = state;
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("invokes the callback once per interval while visible", () => {
    const cb = vi.fn();
    renderHook(() => useVisibilityAwareInterval(cb, 1000));

    act(() => vi.advanceTimersByTime(3000));
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("pauses while hidden and snaps on restore", () => {
    const cb = vi.fn();
    renderHook(() => useVisibilityAwareInterval(cb, 1000));

    act(() => vi.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(1);

    act(() => setVisibility("hidden"));
    act(() => vi.advanceTimersByTime(10_000));
    expect(cb).toHaveBeenCalledTimes(1);

    act(() => setVisibility("visible"));
    // Immediate catch-up tick on restore.
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does not run when disabled", () => {
    const cb = vi.fn();
    renderHook(() => useVisibilityAwareInterval(cb, 1000, false));

    act(() => vi.advanceTimersByTime(5000));
    expect(cb).not.toHaveBeenCalled();
  });

  it("starts when enabled flips true", () => {
    const cb = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useVisibilityAwareInterval(cb, 1000, enabled),
      { initialProps: { enabled: false } }
    );

    act(() => vi.advanceTimersByTime(3000));
    expect(cb).not.toHaveBeenCalled();

    rerender({ enabled: true });
    act(() => vi.advanceTimersByTime(2000));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does not start the interval when mounted while hidden", () => {
    visibilityState = "hidden";
    const cb = vi.fn();
    renderHook(() => useVisibilityAwareInterval(cb, 1000));

    act(() => vi.advanceTimersByTime(5000));
    expect(cb).not.toHaveBeenCalled();

    act(() => setVisibility("visible"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("clears the interval and listener on unmount", () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useVisibilityAwareInterval(cb, 1000));

    unmount();
    act(() => vi.advanceTimersByTime(5000));
    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("always calls the latest callback without re-subscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useVisibilityAwareInterval(cb, 1000), {
      initialProps: { cb: first },
    });

    act(() => vi.advanceTimersByTime(1000));
    expect(first).toHaveBeenCalledTimes(1);

    rerender({ cb: second });
    act(() => vi.advanceTimersByTime(1000));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });
  describe("in a cached project view (#12514)", () => {
    // A cached view's document stays "visible", so only main's lifecycle IPC
    // can stop the interval. Drives the real `viewCacheState` singleton.
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
      act(() => {
        set.forEach((handler) => handler());
      });
    }

    it("pauses while cached and snaps once on activation, not again on reveal", () => {
      const cb = vi.fn();
      const { unmount } = renderHook(() => useVisibilityAwareInterval(cb, 1000));

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(cb).toHaveBeenCalledTimes(1);

      emit(handlers.cached);
      expect(vi.getTimerCount()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(cb).toHaveBeenCalledTimes(1);

      emit(handlers.warm);
      expect(cb).toHaveBeenCalledTimes(2);
      emit(handlers.revealed);
      expect(cb).toHaveBeenCalledTimes(2);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(cb).toHaveBeenCalledTimes(3);

      unmount();
    });

    it("does not start the interval when mounted inside a cached view", () => {
      latchedCached = true;
      const cb = vi.fn();
      const { unmount } = renderHook(() => useVisibilityAwareInterval(cb, 1000));

      expect(vi.getTimerCount()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(cb).not.toHaveBeenCalled();

      emit(handlers.warm);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores a window restore underneath a cached view", () => {
      const cb = vi.fn();
      const { unmount } = renderHook(() => useVisibilityAwareInterval(cb, 1000));

      emit(handlers.cached);
      act(() => {
        setVisibility("hidden");
      });
      act(() => {
        setVisibility("visible");
      });

      expect(cb).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      unmount();
    });

    it("stops listening to the view lifecycle on unmount", () => {
      const cb = vi.fn();
      const { unmount } = renderHook(() => useVisibilityAwareInterval(cb, 1000));
      emit(handlers.cached);
      unmount();

      emit(handlers.warm);

      expect(cb).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
