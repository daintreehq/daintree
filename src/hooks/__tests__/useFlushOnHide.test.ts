// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useFlushOnHide } from "../useFlushOnHide";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";

function setHidden(value: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => value,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (value ? "hidden" : "visible"),
  });
}

function fireVisibilityChange(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

// Mirrors preload: `isViewCached` is the latch, the three edges are non-replaying.
function installViewLifecycle(latchedCached = false) {
  const handlers = { cached: [] as Array<() => void>, warm: [] as Array<() => void> };
  let latched = latchedCached;
  vi.stubGlobal("electron", {
    app: {
      isViewCached: () => latched,
      onViewCached: (cb: () => void) => {
        handlers.cached.push(cb);
        return () => {};
      },
      onViewWarmActivated: (cb: () => void) => {
        handlers.warm.push(cb);
        return () => {};
      },
      onViewRevealed: () => () => {},
    },
  });
  return {
    cache: () => {
      latched = true;
      for (const cb of handlers.cached) cb();
    },
    activate: () => {
      latched = false;
      for (const cb of handlers.warm) cb();
    },
  };
}

describe("useFlushOnHide", () => {
  beforeEach(() => {
    __resetProjectViewCacheStateForTests();
    setHidden(false);
  });

  afterEach(() => {
    setHidden(false);
    __resetProjectViewCacheStateForTests();
    vi.unstubAllGlobals();
  });

  it("fires the callback when visibility transitions to hidden", () => {
    const fn = vi.fn();
    renderHook(() => useFlushOnHide(fn, true));
    expect(fn).not.toHaveBeenCalled();

    act(() => {
      setHidden(true);
      fireVisibilityChange();
    });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not fire when visibility transitions to visible", () => {
    const fn = vi.fn();
    renderHook(() => useFlushOnHide(fn, true));

    act(() => {
      setHidden(false);
      fireVisibilityChange();
    });

    expect(fn).not.toHaveBeenCalled();
  });

  it("does not fire when enabled is false", () => {
    const fn = vi.fn();
    renderHook(() => useFlushOnHide(fn, false));

    act(() => {
      setHidden(true);
      fireVisibilityChange();
    });

    expect(fn).not.toHaveBeenCalled();
  });

  it("fires immediately if document is already hidden at registration", () => {
    setHidden(true);
    const fn = vi.fn();
    renderHook(() => useFlushOnHide(fn, true));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires immediately when enabled flips to true while already hidden", () => {
    setHidden(true);
    const fn = vi.fn();
    const { rerender } = renderHook(({ enabled }) => useFlushOnHide(fn, enabled), {
      initialProps: { enabled: false },
    });
    expect(fn).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not fire after unmount", () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => useFlushOnHide(fn, true));
    unmount();

    act(() => {
      setHidden(true);
      fireVisibilityChange();
    });

    expect(fn).not.toHaveBeenCalled();
  });

  it("invokes the latest callback when fn changes between renders", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => useFlushOnHide(fn, true), {
      initialProps: { fn: first },
    });

    rerender({ fn: second });

    act(() => {
      setHidden(true);
      fireVisibilityChange();
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not throw synchronously when the callback rejects", () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    renderHook(() => useFlushOnHide(fn, true));

    expect(() => {
      act(() => {
        setHidden(true);
        fireVisibilityChange();
      });
    }).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires when main caches the view while the document stays visible", () => {
    const lifecycle = installViewLifecycle();
    const fn = vi.fn();
    renderHook(() => useFlushOnHide(fn, true));
    expect(fn).not.toHaveBeenCalled();

    act(() => {
      lifecycle.cache();
    });

    expect(document.hidden).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires again on each new cached edge, not on reactivation", () => {
    const lifecycle = installViewLifecycle();
    const fn = vi.fn();
    renderHook(() => useFlushOnHide(fn, true));

    act(() => {
      lifecycle.cache();
      lifecycle.activate();
    });
    expect(fn).toHaveBeenCalledTimes(1);

    act(() => {
      lifecycle.cache();
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("fires immediately when mounted while the view is already cached", () => {
    installViewLifecycle(true);
    const fn = vi.fn();
    renderHook(() => useFlushOnHide(fn, true));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires immediately when enabled flips to true while the view is cached", () => {
    installViewLifecycle(true);
    const fn = vi.fn();
    const { rerender } = renderHook(({ enabled }) => useFlushOnHide(fn, enabled), {
      initialProps: { enabled: false },
    });
    expect(fn).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not fire on a cached edge when disabled or after unmount", () => {
    const lifecycle = installViewLifecycle();
    const disabled = vi.fn();
    const unmounted = vi.fn();
    renderHook(() => useFlushOnHide(disabled, false));
    const { unmount } = renderHook(() => useFlushOnHide(unmounted, true));
    unmount();

    act(() => {
      lifecycle.cache();
    });

    expect(disabled).not.toHaveBeenCalled();
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("still fires on a window hide while the view is not cached", () => {
    installViewLifecycle();
    const fn = vi.fn();
    renderHook(() => useFlushOnHide(fn, true));

    act(() => {
      setHidden(true);
      fireVisibilityChange();
    });

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
