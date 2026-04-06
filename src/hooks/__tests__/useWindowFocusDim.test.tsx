// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

// Mock dependencies before importing the hook
vi.mock("@/services/FaviconBadgeService", () => ({
  updateFaviconBadge: vi.fn(),
  clearFaviconBadge: vi.fn(),
}));

vi.mock("@/hooks/useTerminalSelectors", () => ({
  useTerminalNotificationCounts: () => ({ waitingCount: 0 }),
}));

// Stub window.electron.notification.updateBadge
Object.defineProperty(window, "electron", {
  value: { notification: { updateBadge: vi.fn() } },
  writable: true,
});

import { useWindowNotifications } from "../useWindowNotifications";

describe("useWindowNotifications — window focus dim", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete document.body.dataset.windowFocused;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets data-window-focused='false' on body after blur debounce", () => {
    renderHook(() => useWindowNotifications());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    // Not set yet — still within debounce
    expect(document.body.dataset.windowFocused).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(document.body.dataset.windowFocused).toBe("false");
  });

  it("does not set attribute if focus returns before debounce expires", () => {
    renderHook(() => useWindowNotifications());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    // Focus before 150ms debounce
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(document.body.dataset.windowFocused).toBeUndefined();
  });

  it("removes attribute immediately on focus after blur was applied", () => {
    renderHook(() => useWindowNotifications());

    // Blur and let debounce expire
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(document.body.dataset.windowFocused).toBe("false");

    // Focus restores immediately
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.body.dataset.windowFocused).toBeUndefined();
  });

  it("cleans up attribute on unmount while blurred", () => {
    const { unmount } = renderHook(() => useWindowNotifications());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(document.body.dataset.windowFocused).toBe("false");

    unmount();
    expect(document.body.dataset.windowFocused).toBeUndefined();
  });

  it("cleans up pending debounce timer on unmount", () => {
    const { unmount } = renderHook(() => useWindowNotifications());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    // Unmount before debounce expires
    act(() => {
      vi.advanceTimersByTime(50);
    });
    unmount();

    // Advance well past debounce — attribute should never be set
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(document.body.dataset.windowFocused).toBeUndefined();
  });

  it("handles rapid blur/focus/blur cycle correctly", () => {
    renderHook(() => useWindowNotifications());

    // First blur
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });

    // Quick focus
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    // Second blur
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    // Advance past debounce
    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(document.body.dataset.windowFocused).toBe("false");
  });
});
