// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDeferredLoading } from "../useDeferredLoading";

describe("useDeferredLoading", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false initially when isPending is false", () => {
    const { result } = renderHook(() => useDeferredLoading(false, 200));
    expect(result.current).toBe(false);
  });

  it("returns false initially when isPending is true (suppressed during delay)", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDeferredLoading(true, 200));
    expect(result.current).toBe(false);
  });

  it("does not flip to true before delay elapses", () => {
    vi.useFakeTimers();
    const { result } = renderHook(({ isPending }) => useDeferredLoading(isPending, 200), {
      initialProps: { isPending: true },
    });

    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current).toBe(false);
  });

  it("flips to true after the delay elapses while still pending", () => {
    vi.useFakeTimers();
    const { result } = renderHook(({ isPending }) => useDeferredLoading(isPending, 200), {
      initialProps: { isPending: true },
    });

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe(true);
  });

  it("never exposes true when isPending resolves before the delay", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ isPending }) => useDeferredLoading(isPending, 200), {
      initialProps: { isPending: true },
    });

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe(false);

    rerender({ isPending: false });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);
  });

  it("resets immediately to false when isPending flips from true to false after the delay", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ isPending }) => useDeferredLoading(isPending, 200), {
      initialProps: { isPending: true },
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe(true);

    act(() => {
      rerender({ isPending: false });
    });
    expect(result.current).toBe(false);
  });

  it("uses a default delay of 200ms when not specified", () => {
    vi.useFakeTimers();
    const { result } = renderHook(({ isPending }) => useDeferredLoading(isPending), {
      initialProps: { isPending: true },
    });

    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("shows the loader immediately when delay is 0", () => {
    const { result } = renderHook(() => useDeferredLoading(true, 0));
    expect(result.current).toBe(true);
  });

  it("shows the loader immediately when delay is negative", () => {
    const { result } = renderHook(() => useDeferredLoading(true, -50));
    expect(result.current).toBe(true);
  });

  it("does not update state after unmount", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useDeferredLoading(true, 200));
    unmount();
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(500);
      });
    }).not.toThrow();
  });

  it("resets the timer when delay changes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isPending, delay }) => useDeferredLoading(isPending, delay),
      { initialProps: { isPending: true, delay: 200 } }
    );

    act(() => {
      vi.advanceTimersByTime(150);
    });
    rerender({ isPending: true, delay: 500 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe(true);
  });
});
