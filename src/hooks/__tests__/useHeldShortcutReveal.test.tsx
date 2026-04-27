// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const isMacMock = vi.fn(() => true);

vi.mock("@/lib/platform", () => ({
  isMac: () => isMacMock(),
}));

import { useHeldShortcutReveal } from "../useHeldShortcutReveal";

const REVEAL_DATASET_KEY = "shortcutReveal";

function dispatchKey(type: "keydown" | "keyup", key: string, repeat = false) {
  window.dispatchEvent(new KeyboardEvent(type, { key, repeat }));
}

function isRevealed(): boolean {
  return document.documentElement.dataset[REVEAL_DATASET_KEY] === "true";
}

describe("useHeldShortcutReveal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isMacMock.mockReturnValue(true);
    delete document.documentElement.dataset[REVEAL_DATASET_KEY];
  });

  afterEach(() => {
    vi.useRealTimers();
    delete document.documentElement.dataset[REVEAL_DATASET_KEY];
  });

  it("does not reveal before 1s threshold", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(isRevealed()).toBe(false);
  });

  it("reveals after 1s hold of Meta on macOS", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(isRevealed()).toBe(true);
  });

  it("does not reveal at 999ms but reveals on the next tick", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(isRevealed()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(isRevealed()).toBe(true);
  });

  it("reveals after 1s hold of Control on non-mac", () => {
    isMacMock.mockReturnValue(false);
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Control"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(isRevealed()).toBe(true);
  });

  it("ignores non-primary modifier keys", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Shift"));
    act(() => dispatchKey("keydown", "Alt"));
    act(() => dispatchKey("keydown", "Control"));
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(isRevealed()).toBe(false);
  });

  it("clears reveal on keyup", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(isRevealed()).toBe(true);

    act(() => dispatchKey("keyup", "Meta"));
    expect(isRevealed()).toBe(false);
  });

  it("cancels pending reveal if keyup fires before threshold", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => dispatchKey("keyup", "Meta"));
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(isRevealed()).toBe(false);
  });

  it("clears reveal on window blur", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(isRevealed()).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(isRevealed()).toBe(false);
  });

  it("cancels pending timer on window blur (Cmd+Tab before threshold)", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(isRevealed()).toBe(false);
  });

  it("ignores OS auto-repeat keydown events", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(900);
    });
    // Auto-repeat: should NOT restart the timer
    act(() => dispatchKey("keydown", "Meta", true));
    act(() => {
      vi.advanceTimersByTime(150);
    });

    // Original timer at 900+150=1050ms should have fired
    expect(isRevealed()).toBe(true);
  });

  it("supports a second hold after release", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => vi.advanceTimersByTime(1000));
    expect(isRevealed()).toBe(true);

    act(() => dispatchKey("keyup", "Meta"));
    expect(isRevealed()).toBe(false);

    act(() => dispatchKey("keydown", "Meta"));
    act(() => vi.advanceTimersByTime(1000));
    expect(isRevealed()).toBe(true);
  });

  it("removes attribute and cleans up listeners on unmount", () => {
    const { unmount } = renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => vi.advanceTimersByTime(1000));
    expect(isRevealed()).toBe(true);

    unmount();
    expect(isRevealed()).toBe(false);

    // After unmount, further events should have no effect
    act(() => dispatchKey("keydown", "Meta"));
    act(() => vi.advanceTimersByTime(1000));
    expect(isRevealed()).toBe(false);
  });

  it("cancels pending timer on unmount", () => {
    const { unmount } = renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => vi.advanceTimersByTime(500));
    unmount();
    act(() => vi.advanceTimersByTime(2000));

    expect(isRevealed()).toBe(false);
  });
});
