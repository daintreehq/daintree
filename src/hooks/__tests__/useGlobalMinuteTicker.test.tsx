// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
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
});
