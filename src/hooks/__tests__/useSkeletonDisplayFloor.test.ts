// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSkeletonDisplayFloor, useSkeletonFloor } from "../useDeferredLoading";

const FLOOR = 250;

describe("useSkeletonDisplayFloor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete document.body.dataset.performanceMode;
  });

  it("stays false when never shown", () => {
    const { result } = renderHook(() => useSkeletonDisplayFloor(false, FLOOR));
    expect(result.current).toBe(false);
  });

  it("shows immediately when isShowing is true", () => {
    const { result } = renderHook(() => useSkeletonDisplayFloor(true, FLOOR));
    expect(result.current).toBe(true);
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

  it("releases the moment the floor elapses when isShowing already false", () => {
    const { result, rerender } = renderHook(
      ({ isShowing }) => useSkeletonDisplayFloor(isShowing, FLOOR),
      { initialProps: { isShowing: true } }
    );

    rerender({ isShowing: false });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(FLOOR);
    });
    expect(result.current).toBe(false);
  });

  it("stays true indefinitely while isShowing remains true", () => {
    const { result } = renderHook(({ isShowing }) => useSkeletonDisplayFloor(isShowing, FLOOR), {
      initialProps: { isShowing: true },
    });

    act(() => {
      vi.advanceTimersByTime(FLOOR * 4);
    });
    expect(result.current).toBe(true);
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

  it("honors a custom floor duration", () => {
    const { result, rerender } = renderHook(
      ({ isShowing }) => useSkeletonDisplayFloor(isShowing, 100),
      { initialProps: { isShowing: true } }
    );

    rerender({ isShowing: false });
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
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

  it("mirrors isShowing immediately when floor is negative", () => {
    const { result, rerender } = renderHook(
      ({ isShowing }) => useSkeletonDisplayFloor(isShowing, -50),
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

  it("does not update state after unmount", () => {
    const { unmount, rerender } = renderHook(
      ({ isShowing }) => useSkeletonDisplayFloor(isShowing, FLOOR),
      { initialProps: { isShowing: true } }
    );
    rerender({ isShowing: false });
    unmount();
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(FLOOR * 2);
      });
    }).not.toThrow();
  });
});

describe("useSkeletonFloor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds true for the default 250ms floor after isShowing flips false", () => {
    const { result, rerender } = renderHook(({ isShowing }) => useSkeletonFloor(isShowing), {
      initialProps: { isShowing: true },
    });
    expect(result.current).toBe(true);

    rerender({ isShowing: false });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });
});
