// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSkeletonDisplayFloor } from "../useDeferredLoading";

const FLOOR = 250;

describe("useSkeletonDisplayFloor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete document.body.dataset.performanceMode;
  });

  it("holds true through the floor after isShowing flips false", () => {
    const { result, rerender } = renderHook(
      ({ isShowing }) => useSkeletonDisplayFloor(isShowing, FLOOR),
      { initialProps: { isShowing: true } }
    );
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ isShowing: false });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it("never drops to false on a true→false→true flap within the floor", () => {
    const { result, rerender } = renderHook(
      ({ isShowing }) => useSkeletonDisplayFloor(isShowing, FLOOR),
      { initialProps: { isShowing: true } }
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ isShowing: false });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(50);
    });
    rerender({ isShowing: true });
    expect(result.current).toBe(true);

    // The original hide timer must have been cancelled; output holds.
    act(() => {
      vi.advanceTimersByTime(FLOOR * 2);
    });
    expect(result.current).toBe(true);
  });

  it("mirrors isShowing immediately when floor is zero", () => {
    const { result, rerender } = renderHook(
      ({ isShowing }) => useSkeletonDisplayFloor(isShowing, 0),
      { initialProps: { isShowing: true } }
    );
    expect(result.current).toBe(true);

    rerender({ isShowing: false });
    expect(result.current).toBe(false);
  });

  it("bypasses the floor in performance mode", () => {
    document.body.dataset.performanceMode = "true";
    const { result, rerender } = renderHook(
      ({ isShowing }) => useSkeletonDisplayFloor(isShowing, FLOOR),
      { initialProps: { isShowing: true } }
    );
    expect(result.current).toBe(true);

    rerender({ isShowing: false });
    expect(result.current).toBe(false);
  });

  it("clears the pending floor timer on unmount", () => {
    const { unmount, rerender } = renderHook(
      ({ isShowing }) => useSkeletonDisplayFloor(isShowing, FLOOR),
      { initialProps: { isShowing: true } }
    );
    rerender({ isShowing: false });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(FLOOR * 2);
      });
    }).not.toThrow();
  });

  it("reveals after a false→true transition", () => {
    const { result, rerender } = renderHook(
      ({ isShowing }) => useSkeletonDisplayFloor(isShowing, FLOOR),
      { initialProps: { isShowing: false } }
    );
    expect(result.current).toBe(false);

    rerender({ isShowing: true });
    expect(result.current).toBe(true);
  });

  it("releases immediately on a hide that arrives after the floor already elapsed", () => {
    const { result, rerender } = renderHook(
      ({ isShowing }) => useSkeletonDisplayFloor(isShowing, FLOOR),
      { initialProps: { isShowing: true } }
    );

    act(() => {
      vi.advanceTimersByTime(FLOOR + 10);
    });
    rerender({ isShowing: false });
    expect(result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops to zero floor mid-hold without leaving a stale timer", () => {
    const { result, rerender } = renderHook(
      ({ isShowing, floorMs }) => useSkeletonDisplayFloor(isShowing, floorMs),
      { initialProps: { isShowing: true, floorMs: FLOOR } }
    );

    rerender({ isShowing: false, floorMs: FLOOR });
    expect(result.current).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    rerender({ isShowing: false, floorMs: 0 });
    expect(result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
