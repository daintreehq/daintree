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
  clientY: number,
  currentTarget?: Element
): React.PointerEvent<HTMLButtonElement> {
  return { clientX, clientY, currentTarget } as unknown as React.PointerEvent<HTMLButtonElement>;
}

function createFocusTarget(
  rect: { left: number; top: number },
  dataState?: string
): HTMLButtonElement {
  const el = document.createElement("button");
  if (dataState) el.setAttribute("data-state", dataState);
  el.getBoundingClientRect = () =>
    ({
      left: rect.left,
      top: rect.top,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

function createFocusEvent(currentTarget: HTMLButtonElement): React.FocusEvent<HTMLButtonElement> {
  return { currentTarget } as unknown as React.FocusEvent<HTMLButtonElement>;
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
    // Count 3 is not a milestone
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 3 });

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

  it("suppresses dwell hint when trigger data-state is delayed-open", () => {
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const trigger = document.createElement("button");
    trigger.setAttribute("data-state", "delayed-open");

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200, trigger));
    });

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("suppresses dwell hint when trigger data-state is instant-open", () => {
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const trigger = document.createElement("button");
    trigger.setAttribute("data-state", "instant-open");

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200, trigger));
    });

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("suppresses dwell hint when trigger transitions to delayed-open mid-dwell", () => {
    // Real-world race: Radix tooltip opens at ~500ms during the 1500ms dwell.
    // The hook must read data-state at fire time, not at pointer-enter time.
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const trigger = document.createElement("button");
    trigger.setAttribute("data-state", "closed");

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200, trigger));
    });

    act(() => {
      vi.advanceTimersByTime(800);
      trigger.setAttribute("data-state", "delayed-open");
    });

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("fires dwell hint when trigger data-state is closed", () => {
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const trigger = document.createElement("button");
    trigger.setAttribute("data-state", "closed");

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200, trigger));
    });

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    const hint = shortcutHintStore.getState().activeHint;
    expect(hint).not.toBeNull();
    expect(hint!.actionId).toBe("nav.toggleSidebar");
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

  // --- Focus parity tests (WCAG 1.4.13) ---

  it("shows hint immediately on focus, positioned from getBoundingClientRect", () => {
    getDisplayComboMock.mockReturnValue("⌘B");
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onFocus(createFocusEvent(createFocusTarget({ left: 42, top: 84 })));
    });

    // No timer advance — focus fires synchronously.
    const hint = shortcutHintStore.getState().activeHint;
    expect(hint).not.toBeNull();
    expect(hint!.actionId).toBe("nav.toggleSidebar");
    expect(hint!.displayCombo).toBe("⌘B");
    expect(hint!.x).toBe(42);
    expect(hint!.y).toBe(84);
  });

  it("skips focus hint when displayCombo is empty", () => {
    getDisplayComboMock.mockReturnValue("");
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onFocus(createFocusEvent(createFocusTarget({ left: 10, top: 20 })));
    });

    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("suppresses focus hint when trigger data-state is delayed-open", () => {
    getDisplayComboMock.mockReturnValue("⌘B");
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onFocus(
        createFocusEvent(createFocusTarget({ left: 1, top: 2 }, "delayed-open"))
      );
    });

    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("suppresses focus hint for non-milestone non-zero count", () => {
    getDisplayComboMock.mockReturnValue("⌘B");
    // Count 3 is not a milestone
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 3 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onFocus(createFocusEvent(createFocusTarget({ left: 5, top: 6 })));
    });

    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("hides the hint on blur", () => {
    getDisplayComboMock.mockReturnValue("⌘B");
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    act(() => {
      result.current.onFocus(createFocusEvent(createFocusTarget({ left: 1, top: 1 })));
    });
    expect(shortcutHintStore.getState().activeHint).not.toBeNull();

    act(() => {
      result.current.onBlur();
    });
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("blur does not hide a hint owned by a different element", () => {
    getDisplayComboMock.mockReturnValue("⌘B");
    shortcutHintStore.getState().hydrateCounts({
      "nav.toggleSidebar": 0,
      "panel.togglePortal": 0,
    });

    const { result: a } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));
    const { result: b } = renderHook(() => useShortcutHintHover("panel.togglePortal"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    // A is focused and showed its hint.
    act(() => {
      a.current.onFocus(createFocusEvent(createFocusTarget({ left: 1, top: 1 })));
    });
    // B's hint then takes over (simulating a pointer dwell on B).
    act(() => {
      shortcutHintStore.getState().show("panel.togglePortal", "⌘P", { x: 9, y: 9 });
    });
    expect(shortcutHintStore.getState().activeHint!.actionId).toBe("panel.togglePortal");

    // A blurs — must NOT clear B's hint.
    act(() => {
      a.current.onBlur();
    });
    expect(shortcutHintStore.getState().activeHint!.actionId).toBe("panel.togglePortal");

    // B blurring its own hint does clear it.
    act(() => {
      b.current.onBlur();
    });
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("focus cancels a pending pointer dwell timer (no double-show)", () => {
    getDisplayComboMock.mockReturnValue("⌘B");
    shortcutHintStore.getState().hydrateCounts({ "nav.toggleSidebar": 0 });

    const { result } = renderHook(() => useShortcutHintHover("nav.toggleSidebar"));

    act(() => {
      vi.advanceTimersByTime(10);
    });

    // Pointer enter starts the 1500ms dwell.
    act(() => {
      result.current.onPointerEnter(createPointerEvent(100, 200));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Focus fires immediately and must cancel the pending dwell.
    act(() => {
      result.current.onFocus(createFocusEvent(createFocusTarget({ left: 7, top: 8 })));
    });
    const focusHint = shortcutHintStore.getState().activeHint;
    expect(focusHint!.x).toBe(7);
    expect(focusHint!.y).toBe(8);

    // One-shot gating + cancelled timer: no second show, position stays the focus one.
    shortcutHintStore.getState().hide();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });
});
