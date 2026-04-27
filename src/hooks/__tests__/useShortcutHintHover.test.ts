// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useShortcutHintHover } from "../useShortcutHintHover";
import { shortcutHintStore } from "@/store/shortcutHintStore";

const { getDisplayComboMock, subscribeMock } = vi.hoisted(() => ({
  getDisplayComboMock: vi.fn(() => "⌘B"),
  subscribeMock: vi.fn(() => () => {}),
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getDisplayCombo: getDisplayComboMock,
    subscribe: subscribeMock,
  },
}));

function createPointerEvent(
  clientX: number,
  clientY: number
): React.PointerEvent<HTMLButtonElement> {
  return { clientX, clientY } as React.PointerEvent<HTMLButtonElement>;
}

describe("useShortcutHintHover", () => {
  beforeEach(() => {
    shortcutHintStore.setState({
      counts: {},
      hydrated: true,
      pointer: null,
      activeHint: null,
      hintedHover: new Set(),
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts dwell timer on pointer enter", () => {
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10); // let the useEffect for displayCombo run
    });

    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200));
    });

    // Timer should be running
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(shortcutHintStore.getState().activeHint).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    // Now at 1500ms — hint should fire
    const hint = shortcutHintStore.getState().activeHint;
    expect(hint).not.toBeNull();
    expect(hint!.actionId).toBe("nav.toggleSidebar");
    expect(hint!.displayCombo).toBe("⌘B");
  });

  it("cancels dwell timer on pointer leave", () => {
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200));
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    act(() => {
      result.current.onPointerLeave();
    });

    // Advance past 1500ms total — hint should NOT fire
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("skips when displayCombo is empty", () => {
    getDisplayComboMock.mockReturnValue("");

    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200));
    });

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("cancels dwell timer on pointer down", () => {
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200));
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Pointer down should cancel the timer
    act(() => {
      result.current.onPointerDown();
    });

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("suppresses hint for non-milestone non-zero count", () => {
    getDisplayComboMock.mockReturnValue("⌘B");
    // Count 4 is not a milestone
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 4 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200));
    });

    // Advance well past dwell — timer should NOT have started at all
    // (isHoverEligible returns false before starting the timer)
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("respects one-shot gating at same count level", () => {
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 1 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    // First hover — should trigger (and auto-mark as shown via markHoverShown)
    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200));
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(shortcutHintStore.getState().activeHint).not.toBeNull();

    // Clear hint display for second hover cycle
    shortcutHintStore.getState().hide();

    // Second hover at same count — should NOT trigger (one-shot)
    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200));
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });
});
