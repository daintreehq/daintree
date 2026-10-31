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

// Mirrors preload: `isViewCached` is the latch, and a cached edge runs every
// registered flusher and settles once they all have.
function installViewLifecycle(latchedCached = false) {
  const flushers = new Set<() => unknown>();
  const warm: Array<() => void> = [];
  let latched = latchedCached;
  vi.stubGlobal("electron", {
    app: {
      isViewCached: () => latched,
      onViewCached: () => () => {},
      onViewCachedFlush: (cb: () => unknown) => {
        const flush = () => cb();
        flushers.add(flush);
        return () => flushers.delete(flush);
      },
      onViewWarmActivated: (cb: () => void) => {
        warm.push(cb);
        return () => {};
      },
      onViewRevealed: () => () => {},
    },
  });
  return {
    cache: () => {
      latched = true;
      return Promise.allSettled(Array.from(flushers, (flush) => flush()));
    },
    activate: () => {
      latched = false;
      for (const cb of warm) cb();
    },
    flusherCount: () => flushers.size,
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

  it("hands the cached edge the callback's promise, so main can wait for it", async () => {
    const lifecycle = installViewLifecycle();
    let finish!: () => void;
    const fn = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderHook(() => useFlushOnHide(fn, true));

    let settled = false;
    const edge = lifecycle.cache().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    finish();
    await edge;
    expect(settled).toBe(true);
  });

  it("drops its cached-edge subscription when disabled", () => {
    const lifecycle = installViewLifecycle();
    const { rerender } = renderHook(({ enabled }) => useFlushOnHide(vi.fn(), enabled), {
      initialProps: { enabled: true },
    });
    expect(lifecycle.flusherCount()).toBe(1);

    rerender({ enabled: false });
    expect(lifecycle.flusherCount()).toBe(0);
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
