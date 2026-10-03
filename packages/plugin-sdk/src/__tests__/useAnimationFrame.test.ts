// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAnimationFrame } from "../react/useAnimationFrame.js";

let cached = false;
const cachedListeners = new Set<() => void>();
const activeListeners = new Set<() => void>();
let hidden = false;

function setHidden(next: boolean): void {
  hidden = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function setCached(next: boolean): void {
  cached = next;
  for (const cb of [...(next ? cachedListeners : activeListeners)]) cb();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  cached = false;
  hidden = false;
  cachedListeners.clear();
  activeListeners.clear();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal("electron", {
    plugin: { invoke: vi.fn(), on: vi.fn(), onPanel: vi.fn() },
    app: {
      isViewCached: () => cached,
      onViewCached: (cb: () => void) => {
        cachedListeners.add(cb);
        return () => cachedListeners.delete(cb);
      },
      onViewWarmActivated: (cb: () => void) => {
        activeListeners.add(cb);
        return () => activeListeners.delete(cb);
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const frames = (n: number) => {
  for (let i = 0; i < n; i++) act(() => vi.advanceTimersToNextFrame());
};

describe("useAnimationFrame", () => {
  it("calls back every frame with dt, 0 on the first", () => {
    const cb = vi.fn();
    renderHook(() => useAnimationFrame(cb));
    frames(3);
    expect(cb).toHaveBeenCalledTimes(3);
    expect(cb.mock.calls[0]![0]).toBe(0);
    expect(cb.mock.calls[1]![0]).toBeGreaterThan(0);
  });

  it("pauses while the document is hidden and resumes with dt 0", () => {
    const cb = vi.fn();
    renderHook(() => useAnimationFrame(cb));
    frames(2);
    act(() => setHidden(true));
    frames(5);
    expect(cb).toHaveBeenCalledTimes(2);
    act(() => setHidden(false));
    frames(1);
    expect(cb).toHaveBeenCalledTimes(3);
    expect(cb.mock.calls[2]![0]).toBe(0);
  });

  it("pauses while the project view is cached, which the document cannot see", () => {
    const cb = vi.fn();
    renderHook(() => useAnimationFrame(cb));
    frames(1);
    act(() => setCached(true));
    frames(5);
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => setCached(false));
    frames(2);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("does not start in a view that mounts already cached", () => {
    cached = true;
    const cb = vi.fn();
    renderHook(() => useAnimationFrame(cb));
    frames(3);
    expect(cb).not.toHaveBeenCalled();
    act(() => setCached(false));
    frames(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("stops on enabled: false, on the signal, and on unmount, and unsubscribes", () => {
    const cb = vi.fn();
    const controller = new AbortController();
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useAnimationFrame(cb, { enabled, signal: controller.signal }),
      { initialProps: { enabled: true } }
    );
    frames(1);
    rerender({ enabled: false });
    frames(3);
    expect(cb).toHaveBeenCalledTimes(1);
    rerender({ enabled: true });
    frames(1);
    expect(cb).toHaveBeenCalledTimes(2);
    act(() => controller.abort());
    frames(3);
    expect(cb).toHaveBeenCalledTimes(2);
    unmount();
    expect(cachedListeners.size).toBe(0);
    expect(activeListeners.size).toBe(0);
  });

  it("calls the latest callback without restarting, and survives one that throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = vi.fn(() => {
        throw new Error("boom");
      });
      const second = vi.fn();
      const { rerender } = renderHook(({ cb }) => useAnimationFrame(cb), {
        initialProps: { cb: first as (dt: number) => void },
      });
      frames(1);
      expect(error).toHaveBeenCalledTimes(1);
      rerender({ cb: second });
      frames(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(second.mock.calls[0]![0]).toBeGreaterThan(0);
    } finally {
      error.mockRestore();
    }
  });
});
