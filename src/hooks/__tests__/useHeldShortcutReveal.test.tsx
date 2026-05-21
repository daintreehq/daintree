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

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
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
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
  });

  it("does not reveal before 500ms threshold", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(isRevealed()).toBe(false);
  });

  it("reveals after 500ms hold of Meta on macOS", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(isRevealed()).toBe(true);
  });

  it("does not reveal at 499ms but reveals on the next tick", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(isRevealed()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(isRevealed()).toBe(true);
  });

  it("reveals after 500ms hold of Control on non-mac", () => {
    isMacMock.mockReturnValue(false);
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Control"));
    act(() => {
      vi.advanceTimersByTime(500);
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
      vi.advanceTimersByTime(500);
    });
    expect(isRevealed()).toBe(true);

    act(() => dispatchKey("keyup", "Meta"));
    expect(isRevealed()).toBe(false);
  });

  it("cancels pending reveal if keyup fires before threshold", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => dispatchKey("keyup", "Meta"));
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(isRevealed()).toBe(false);
  });

  it("cancels pending reveal if keyup fires at exactly 499ms (boundary)", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(499);
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
      vi.advanceTimersByTime(500);
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
      vi.advanceTimersByTime(400);
    });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(isRevealed()).toBe(false);
  });

  it("clears reveal when the document becomes hidden (Linux WM workspace switch)", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(isRevealed()).toBe(true);

    act(() => setVisibility("hidden"));

    expect(isRevealed()).toBe(false);
  });

  it("cancels a pending reveal timer when the document becomes hidden", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => setVisibility("hidden"));
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(isRevealed()).toBe(false);
  });

  it("does not clear reveal when visibilitychange fires while still visible", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(isRevealed()).toBe(true);

    act(() => setVisibility("visible"));

    expect(isRevealed()).toBe(true);
  });

  it("ignores OS auto-repeat keydown events", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // Auto-repeat: should NOT restart the timer
    act(() => dispatchKey("keydown", "Meta", true));
    act(() => {
      vi.advanceTimersByTime(150);
    });

    // Original timer at 400+150=550ms should have fired
    expect(isRevealed()).toBe(true);
  });

  it("supports a second hold after release", () => {
    renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => vi.advanceTimersByTime(500));
    expect(isRevealed()).toBe(true);

    act(() => dispatchKey("keyup", "Meta"));
    expect(isRevealed()).toBe(false);

    act(() => dispatchKey("keydown", "Meta"));
    act(() => vi.advanceTimersByTime(500));
    expect(isRevealed()).toBe(true);
  });

  it("removes attribute and cleans up listeners on unmount", () => {
    const { unmount } = renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => vi.advanceTimersByTime(500));
    expect(isRevealed()).toBe(true);

    unmount();
    expect(isRevealed()).toBe(false);

    // After unmount, further events should have no effect
    act(() => dispatchKey("keydown", "Meta"));
    act(() => vi.advanceTimersByTime(500));
    expect(isRevealed()).toBe(false);
  });

  it("cancels pending timer on unmount", () => {
    const { unmount } = renderHook(() => useHeldShortcutReveal());

    act(() => dispatchKey("keydown", "Meta"));
    act(() => vi.advanceTimersByTime(400));
    unmount();
    act(() => vi.advanceTimersByTime(2000));

    expect(isRevealed()).toBe(false);
  });
});
