// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHoverIntentPrefetch, SETTINGS_TAB_HOVER_INTENT_MS } from "../SettingsDialog";

describe("useHoverIntentPrefetch (issue #8760)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onPrefetchImport synchronously on enter", () => {
    const onPrefetchImport = vi.fn();
    const onPrefetchMount = vi.fn();
    const { result } = renderHook(() =>
      useHoverIntentPrefetch({ onPrefetchImport, onPrefetchMount })
    );

    act(() => {
      result.current.onEnter();
    });

    expect(onPrefetchImport).toHaveBeenCalledTimes(1);
    expect(onPrefetchMount).not.toHaveBeenCalled();
  });

  it("does not fire onPrefetchMount before the hover-intent delay elapses", () => {
    const onPrefetchMount = vi.fn();
    const { result } = renderHook(() => useHoverIntentPrefetch({ onPrefetchMount }));

    act(() => {
      result.current.onEnter();
    });
    act(() => {
      vi.advanceTimersByTime(SETTINGS_TAB_HOVER_INTENT_MS - 1);
    });

    expect(onPrefetchMount).not.toHaveBeenCalled();
  });

  it("fires onPrefetchMount exactly once after the hover-intent delay", () => {
    const onPrefetchMount = vi.fn();
    const { result } = renderHook(() => useHoverIntentPrefetch({ onPrefetchMount }));

    act(() => {
      result.current.onEnter();
    });
    act(() => {
      vi.advanceTimersByTime(SETTINGS_TAB_HOVER_INTENT_MS);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onPrefetchMount).toHaveBeenCalledTimes(1);
  });

  it("cancels onPrefetchMount when onLeave fires before the delay", () => {
    const onPrefetchMount = vi.fn();
    const { result } = renderHook(() => useHoverIntentPrefetch({ onPrefetchMount }));

    act(() => {
      result.current.onEnter();
    });
    act(() => {
      vi.advanceTimersByTime(SETTINGS_TAB_HOVER_INTENT_MS - 1);
    });
    act(() => {
      result.current.onLeave();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onPrefetchMount).not.toHaveBeenCalled();
  });

  it("repeated enter replaces (does not stack) the pending timer", () => {
    const onPrefetchImport = vi.fn();
    const onPrefetchMount = vi.fn();
    const { result } = renderHook(() =>
      useHoverIntentPrefetch({ onPrefetchImport, onPrefetchMount })
    );

    act(() => {
      result.current.onEnter();
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      result.current.onEnter();
    });
    // First timer would have fired at 150ms. After re-enter at 100ms, the
    // timer resets, so 50ms more is still under the new 150ms window.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(onPrefetchMount).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onPrefetchMount).toHaveBeenCalledTimes(1);
    expect(onPrefetchImport).toHaveBeenCalledTimes(2);
  });

  it("uses the same code path for focus as for mouse enter (keyboard parity)", () => {
    // onEnter is wired to both onMouseEnter and onFocus at the NavItem call
    // site, so the same callback covers both pointer and keyboard arrow-key
    // navigation through the tablist.
    const onPrefetchImport = vi.fn();
    const onPrefetchMount = vi.fn();
    const { result } = renderHook(() =>
      useHoverIntentPrefetch({ onPrefetchImport, onPrefetchMount })
    );

    act(() => {
      result.current.onEnter();
    });
    act(() => {
      vi.advanceTimersByTime(SETTINGS_TAB_HOVER_INTENT_MS);
    });

    expect(onPrefetchImport).toHaveBeenCalledTimes(1);
    expect(onPrefetchMount).toHaveBeenCalledTimes(1);
  });

  it("clears the pending timer on unmount", () => {
    const onPrefetchMount = vi.fn();
    const { result, unmount } = renderHook(() => useHoverIntentPrefetch({ onPrefetchMount }));

    act(() => {
      result.current.onEnter();
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onPrefetchMount).not.toHaveBeenCalled();
  });

  it("no-ops cleanly when only one or neither callback is provided", () => {
    // Eager tabs (e.g. General) pass undefined for both callbacks — the
    // hook must not crash and must not schedule a timer.
    const { result } = renderHook(() => useHoverIntentPrefetch({}));

    expect(() => {
      act(() => {
        result.current.onEnter();
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      act(() => {
        result.current.onLeave();
      });
    }).not.toThrow();
  });

  it("import-only callback fires every enter; no mount timer is scheduled", () => {
    // If only onPrefetchImport is wired, the hook should fire it on every
    // enter without scheduling a delayed mount.
    const onPrefetchImport = vi.fn();
    const { result } = renderHook(() => useHoverIntentPrefetch({ onPrefetchImport }));

    act(() => {
      result.current.onEnter();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      result.current.onEnter();
    });

    expect(onPrefetchImport).toHaveBeenCalledTimes(2);
  });

  it("delay defaults to SETTINGS_TAB_HOVER_INTENT_MS (150ms)", () => {
    expect(SETTINGS_TAB_HOVER_INTENT_MS).toBe(150);
  });

  it("custom delayMs overrides the default", () => {
    const onPrefetchMount = vi.fn();
    const { result } = renderHook(() => useHoverIntentPrefetch({ onPrefetchMount, delayMs: 300 }));

    act(() => {
      result.current.onEnter();
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(onPrefetchMount).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(onPrefetchMount).toHaveBeenCalledTimes(1);
  });
});
