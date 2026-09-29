// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useThrottledCallback } from "../react/useThrottledCallback.js";

describe("useThrottledCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "Date",
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it("coalesces calls to one per frame with the latest arguments", () => {
    const cb = vi.fn();
    const { result } = renderHook(() => useThrottledCallback(cb));
    result.current(1);
    result.current(2);
    result.current(3);
    expect(cb).not.toHaveBeenCalled();
    act(() => vi.advanceTimersToNextFrame());
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(3);
  });

  it("with ms, runs the first call at once and collapses the rest into one trailing call", () => {
    const cb = vi.fn();
    const { result } = renderHook(() => useThrottledCallback(cb, { ms: 100 }));
    result.current("a");
    result.current("b");
    result.current("c");
    expect(cb.mock.calls).toEqual([["a"]]);
    act(() => vi.advanceTimersByTime(100));
    expect(cb.mock.calls).toEqual([["a"], ["c"]]);
  });

  it("keeps a stable identity and calls the latest callback", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ cb }) => useThrottledCallback(cb), {
      initialProps: { cb: first },
    });
    const fn = result.current;
    rerender({ cb: second });
    expect(result.current).toBe(fn);
    result.current("x");
    act(() => vi.advanceTimersToNextFrame());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("x");
  });

  it("drops a pending call on unmount or cancel", () => {
    const cb = vi.fn();
    const { result, unmount } = renderHook(() => useThrottledCallback(cb));
    result.current(1);
    result.current.cancel();
    act(() => vi.advanceTimersToNextFrame());
    result.current(2);
    unmount();
    vi.advanceTimersToNextFrame();
    expect(cb).not.toHaveBeenCalled();
  });

  it("ignores calls through a retained reference after unmount", () => {
    const cb = vi.fn();
    const { result, unmount } = renderHook(() => useThrottledCallback(cb, { ms: 50 }));
    const fn = result.current;
    unmount();
    fn(1);
    vi.advanceTimersByTime(100);
    expect(cb).not.toHaveBeenCalled();
  });

  it("keeps identity and the pending call when ms changes", () => {
    const cb = vi.fn();
    const { result, rerender } = renderHook(({ ms }) => useThrottledCallback(cb, { ms }), {
      initialProps: { ms: 100 },
    });
    const fn = result.current;
    fn("a");
    fn("b");
    rerender({ ms: 200 });
    expect(result.current).toBe(fn);
    act(() => vi.advanceTimersByTime(100));
    expect(cb.mock.calls).toEqual([["a"], ["b"]]);
  });
});
