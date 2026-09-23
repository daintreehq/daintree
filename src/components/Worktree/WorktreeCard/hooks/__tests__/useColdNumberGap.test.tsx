/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useColdNumberGap } from "../useColdNumberGap";

describe("useColdNumberGap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the gap open across re-renders until the window elapses (#8079)", () => {
    const { result, rerender } = renderHook(
      ({ num, title }: { num: number; title?: string }) => useColdNumberGap(num, title),
      { initialProps: { num: 4821 } }
    );
    expect(result.current).toBe(true);

    // An unrelated re-render inside the window must not close it — the badge
    // always re-renders here when its credential and provider reads settle.
    rerender({ num: 4821 });
    act(() => {
      vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD - 1);
    });
    rerender({ num: 4821 });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it("opens a fresh window when the number changes", () => {
    const { result, rerender } = renderHook(
      ({ num }: { num: number }) => useColdNumberGap(num, undefined),
      {
        initialProps: { num: 1 },
      }
    );
    act(() => {
      vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD);
    });
    expect(result.current).toBe(false);

    rerender({ num: 2 });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD);
    });
    expect(result.current).toBe(false);
  });

  it("never hides when a title is present or the gap is disabled", () => {
    const titled = renderHook(() => useColdNumberGap(7, "Fix the thing"));
    expect(titled.result.current).toBe(false);
    const disabled = renderHook(() => useColdNumberGap(7, undefined, false));
    expect(disabled.result.current).toBe(false);
  });

  it("closes as soon as the title arrives", () => {
    const { result, rerender } = renderHook(
      ({ title }: { title?: string }) => useColdNumberGap(9, title),
      { initialProps: {} as { title?: string } }
    );
    expect(result.current).toBe(true);
    rerender({ title: "Arrived" });
    expect(result.current).toBe(false);
  });
});
