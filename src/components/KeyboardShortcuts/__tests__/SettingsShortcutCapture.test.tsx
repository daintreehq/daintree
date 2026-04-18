// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SettingsShortcutCapture } from "../SettingsShortcutCapture";

// Mock dependencies
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    findConflicts: vi.fn(() => []),
    formatComboForDisplay: vi.fn((combo: string) => combo),
  },
  normalizeKeyForBinding: vi.fn((e: KeyboardEvent) => e.key),
}));

vi.mock("@/lib/platform", () => ({
  isMac: vi.fn(() => false),
}));

describe("SettingsShortcutCapture", () => {
  const mockOnCapture = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders idle state with 'Click to record shortcut' button", () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    expect(screen.getByText("Click to record shortcut")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
    expect(screen.getByText("Clear")).toBeTruthy();
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("enters recording state when clicking record button", async () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Click to record shortcut"));

    expect(screen.getByText("Press key combination...")).toBeTruthy();
  });

  it("captures single key combination and displays it", async () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Click to record shortcut"));

    const keyEvent = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(keyEvent);
    });

    // Should transition to recording complete after timeout
    act(() => {
      vi.advanceTimersByTime(1100);
    });

    expect(screen.getByText("Save")).toBeTruthy();
  });

  it("captures two-step chord combination", async () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Click to record shortcut"));

    // First key of chord
    const firstEvent = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(firstEvent);
    });

    // Should show waiting state
    expect(screen.getByText(/press second key or wait to finish/)).toBeTruthy();

    // Second key of chord
    const secondEvent = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(secondEvent);
    });

    expect(screen.getByText("Save")).toBeTruthy();
  });

  it("finalizes single key after 1-second timeout", async () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Click to record shortcut"));

    const keyEvent = new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      ctrlKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(keyEvent);
    });

    // Save button appears immediately after capturing a combo
    expect(screen.getByText("Save")).toBeTruthy();

    // After timeout, recording state should be finalized (no longer in waiting state)
    act(() => {
      vi.advanceTimersByTime(1100);
    });

    // Recording should be stopped (recording state is false)
    // The "press second key or wait" message should be gone
    expect(screen.queryByText(/press second key or wait to finish/)).toBeNull();
  });

  it("calls onCapture with empty string when Clear is clicked", async () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Clear"));

    expect(mockOnCapture).toHaveBeenCalledWith("");
  });

  it("calls onCancel when Cancel is clicked", async () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Cancel"));

    expect(mockOnCancel).toHaveBeenCalled();
  });

  it("ignores modifier-only key presses (Meta)", async () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Click to record shortcut"));

    const metaEvent = new KeyboardEvent("keydown", {
      key: "Meta",
      code: "MetaLeft",
      metaKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(metaEvent);
    });

    // Should still be in first step, not captured
    expect(screen.getByText("Press key combination...")).toBeTruthy();
  });

  it("ignores repeated events (e.repeat)", async () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Click to record shortcut"));

    const keyEvent = new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      ctrlKey: true,
      bubbles: true,
    });

    // Manually set repeat to simulate a held key
    Object.defineProperty(keyEvent, "repeat", {
      get: () => true,
      configurable: true,
    });

    act(() => {
      window.dispatchEvent(keyEvent);
    });

    // Should still be in first step, repeated key was ignored
    expect(screen.getByText("Press key combination...")).toBeTruthy();
  });

  it("displays conflict warnings when conflicts exist", async () => {
    const { keybindingService } = await import("@/services/KeybindingService");
    vi.mocked(keybindingService.findConflicts).mockReturnValue([
      {
        actionId: "conflict.action",
        description: "Conflicting Action",
        combo: "Cmd+A",
        scope: "global",
        priority: 0,
      },
    ]);

    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Click to record shortcut"));

    const keyEvent = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(keyEvent);
      vi.advanceTimersByTime(1100);
    });

    expect(screen.getByText("Conflicts with: Conflicting Action")).toBeTruthy();
  });

  it("uses normalizeKeyForBinding for key normalization", async () => {
    const { normalizeKeyForBinding } = await import("@/services/KeybindingService");
    vi.mocked(normalizeKeyForBinding).mockReturnValue("k");

    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Click to record shortcut"));

    const keyEvent = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(keyEvent);
    });

    expect(normalizeKeyForBinding).toHaveBeenCalledWith(keyEvent);
  });

  it("calls onCapture with combo when Save is clicked", async () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Click to record shortcut"));

    const keyEvent = new KeyboardEvent("keydown", {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(keyEvent);
      vi.advanceTimersByTime(1100);
    });

    fireEvent.click(screen.getByText("Save"));

    expect(mockOnCapture).toHaveBeenCalled();
  });

  it("cleans up event listeners on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    // Start recording to add the event listener
    act(() => {
      screen.getByText("Click to record shortcut").click();
    });

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function), { capture: true });
  });

  it("clears timeout on unmount", () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const { unmount } = render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    // Start recording
    act(() => {
      screen.getByText("Click to record shortcut").click();
    });

    // Dispatch a key event to set a timeout
    const keyEvent = new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      ctrlKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(keyEvent);
    });

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
