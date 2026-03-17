// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useGlobalSecondTicker } from "../useGlobalSecondTicker";

describe("useGlobalSecondTicker", () => {
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
  });

  function fireVisibilityChange(state: DocumentVisibilityState) {
    visibilityState = state;
    visibilityListeners.forEach((l) => l());
  }

  it("ticks once per second while visible", () => {
    const { result } = renderHook(() => useGlobalSecondTicker());
    const initial = result.current;

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(initial + 1);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(initial + 2);
  });

  it("stops ticking when hidden and resumes on visible", () => {
    const { result } = renderHook(() => useGlobalSecondTicker());
    const initial = result.current;

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(initial + 1);

    act(() => fireVisibilityChange("hidden"));
    const tickAfterHide = result.current;

    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(tickAfterHide);

    act(() => fireVisibilityChange("visible"));
    // Immediate catch-up tick on restore
    expect(result.current).toBe(tickAfterHide + 1);
  });

  it("does not start interval when mounted while hidden", () => {
    visibilityState = "hidden";
    const { result } = renderHook(() => useGlobalSecondTicker());
    const initial = result.current;

    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(initial);

    act(() => fireVisibilityChange("visible"));
    expect(result.current).toBe(initial + 1);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(initial + 2);
  });

  it("cleans up interval and listener on last unmount", () => {
    const { unmount } = renderHook(() => useGlobalSecondTicker());
    expect(visibilityListeners.length).toBeGreaterThan(0);

    unmount();
    expect(visibilityListeners.length).toBe(0);
  });
});
