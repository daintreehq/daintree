// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SettingsShortcutCapture } from "../SettingsShortcutCapture";

// Mock dependencies
vi.mock("@/services/KeybindingService", async () => {
  const actual = await vi.importActual<typeof import("@/services/KeybindingService")>(
    "@/services/KeybindingService"
  );
  return {
    ...actual,
    CHORD_TIMEOUT_MS: 1000,
    keybindingService: {
      findConflicts: vi.fn(() => []),
      formatComboForDisplay: vi.fn((combo: string) => combo),
      getOverride: vi.fn(() => undefined),
      getDefaultCombo: vi.fn(() => undefined),
    },
    normalizeKeyForBinding: vi.fn((e: KeyboardEvent) => e.key),
  };
});

vi.mock("@/lib/platform", () => ({
  isMac: vi.fn(() => false),
  isWindows: vi.fn(() => false),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const notifyMock = vi.fn();

vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: {
    getState: vi.fn(() => ({
      addNotification: vi.fn(),
    })),
  },
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

  it("status region announces recording state changes via aria-live", () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.textContent).toContain("Click to record shortcut");

    fireEvent.click(screen.getByText("Click to record shortcut"));

    const updatedStatus = screen.getByRole("status");
    expect(updatedStatus.textContent).toContain("Press key combination...");
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
        kind: "conflict",
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

    expect(screen.getByText("Conflicts with:")).toBeTruthy();
    expect(screen.getByText("Conflicting Action")).toBeTruthy();
  });

  it("threads scope prop into findConflicts", async () => {
    const { keybindingService } = await import("@/services/KeybindingService");
    vi.mocked(keybindingService.findConflicts).mockReturnValue([]);

    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
        scope="terminal"
      />
    );

    fireEvent.click(screen.getByText("Click to record shortcut"));

    const keyEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(keyEvent);
      vi.advanceTimersByTime(1100);
    });

    expect(keybindingService.findConflicts).toHaveBeenCalledWith(
      expect.any(String),
      "test.action",
      "terminal"
    );
  });

  it("hides Unbind for shadowed (chord-overlap) conflicts", async () => {
    const { keybindingService } = await import("@/services/KeybindingService");
    vi.mocked(keybindingService.findConflicts).mockReturnValue([
      {
        actionId: "shadowed.chord",
        description: "Existing chord",
        combo: "Cmd+K Cmd+S",
        scope: "global",
        priority: 0,
        kind: "shadowed",
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

    expect(screen.getByText("Existing chord")).toBeTruthy();
    expect(screen.getByText("is shadowed by this chord")).toBeTruthy();
    expect(screen.queryByText("Unbind")).toBeNull();
  });

  it("renders 'shadows this chord' when existing single shadows captured chord", async () => {
    const { keybindingService } = await import("@/services/KeybindingService");
    vi.mocked(keybindingService.findConflicts).mockReturnValue([
      {
        actionId: "shadowing.single",
        description: "Existing single",
        combo: "Cmd+K",
        scope: "global",
        priority: 0,
        kind: "shadowed",
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

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true })
      );
    });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true })
      );
      vi.advanceTimersByTime(1100);
    });

    expect(screen.getByText("Existing single")).toBeTruthy();
    expect(screen.getByText("shadows this chord")).toBeTruthy();
    expect(screen.queryByText("Unbind")).toBeNull();
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

  describe("IME composition guard", () => {
    it("ignores keydown when isComposing is true", () => {
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
        />
      );

      fireEvent.click(screen.getByText("Click to record shortcut"));

      const keyEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      });
      // jsdom ignores isComposing in the constructor init dict.
      Object.defineProperty(keyEvent, "isComposing", { value: true, configurable: true });
      const stopPropagationSpy = vi.spyOn(keyEvent, "stopPropagation");

      act(() => {
        window.dispatchEvent(keyEvent);
      });

      expect(screen.getByText("Press key combination...")).toBeTruthy();
      expect(keyEvent.defaultPrevented).toBe(false);
      // Guard must run before stopPropagation — otherwise the IME candidate window
      // can break in the surrounding application.
      expect(stopPropagationSpy).not.toHaveBeenCalled();
    });

    it("ignores keydown when keyCode is 229 (Chromium Process key)", () => {
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
        />
      );

      fireEvent.click(screen.getByText("Click to record shortcut"));

      const keyEvent = new KeyboardEvent("keydown", {
        key: "Process",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(keyEvent, "keyCode", { value: 229, configurable: true });
      const stopPropagationSpy = vi.spyOn(keyEvent, "stopPropagation");

      act(() => {
        window.dispatchEvent(keyEvent);
      });

      expect(screen.getByText("Press key combination...")).toBeTruthy();
      expect(keyEvent.defaultPrevented).toBe(false);
      expect(stopPropagationSpy).not.toHaveBeenCalled();
    });

    it("does not record an IME-composing Enter as the first chord token", () => {
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
        />
      );

      fireEvent.click(screen.getByText("Click to record shortcut"));

      const composingEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(composingEnter, "isComposing", { value: true, configurable: true });

      act(() => {
        window.dispatchEvent(composingEnter);
        vi.advanceTimersByTime(1100);
      });

      // No combo captured — Save button should not appear and the prompt is unchanged.
      expect(screen.queryByText("Save")).toBeNull();
      expect(screen.getByText("Press key combination...")).toBeTruthy();
    });

    it("does not record an IME-composing Enter as the second token of a pending chord", () => {
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
        />
      );

      fireEvent.click(screen.getByText("Click to record shortcut"));

      // First chord token — Ctrl+K — opens the "waiting for second key" window.
      const firstToken = new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        window.dispatchEvent(firstToken);
      });
      expect(screen.getByText(/press second key or wait to finish/)).toBeTruthy();

      // IME commit Enter while we're waiting must NOT become the second chord token.
      const composingEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(composingEnter, "isComposing", { value: true, configurable: true });
      act(() => {
        window.dispatchEvent(composingEnter);
        vi.advanceTimersByTime(1100);
      });

      // The single-token Ctrl+K should finalize cleanly with no chord suffix.
      expect(screen.queryByText(/press second key or wait to finish/)).toBeNull();
      expect(screen.queryByText(/\(chord\)/)).toBeNull();
      expect(screen.getByText("Save")).toBeTruthy();
    });
  });

  describe("validateCombo prop", () => {
    it("shows inline validation error and disables Save when validator returns a message", () => {
      const validate = vi.fn((_combo: string) => "Agent shortcuts use Ctrl+Alt+letter");

      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          validateCombo={validate}
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

      expect(screen.getByTestId("shortcut-capture-validation-error")).toBeTruthy();
      expect(screen.getByText("Agent shortcuts use Ctrl+Alt+letter")).toBeTruthy();

      const saveButton = screen.getByText("Save") as HTMLButtonElement;
      expect(saveButton.disabled).toBe(true);

      fireEvent.click(saveButton);
      expect(mockOnCapture).not.toHaveBeenCalled();
    });

    it("allows Save when validateCombo returns null", () => {
      const validate = vi.fn((_combo: string) => null);

      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          validateCombo={validate}
        />
      );

      fireEvent.click(screen.getByText("Click to record shortcut"));

      const keyEvent = new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
      });

      act(() => {
        window.dispatchEvent(keyEvent);
        vi.advanceTimersByTime(1100);
      });

      expect(screen.queryByTestId("shortcut-capture-validation-error")).toBeNull();

      const saveButton = screen.getByText("Save") as HTMLButtonElement;
      expect(saveButton.disabled).toBe(false);

      fireEvent.click(saveButton);
      expect(mockOnCapture).toHaveBeenCalled();
    });
  });

  describe("window blur during recording", () => {
    it("clears the in-progress combo and exits recording state on window blur", () => {
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
        />
      );

      fireEvent.click(screen.getByText("Click to record shortcut"));

      // Start a chord — held modifier state would otherwise be stuck on blur.
      const firstKey = new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        bubbles: true,
      });

      act(() => {
        window.dispatchEvent(firstKey);
      });

      expect(screen.getByText(/press second key or wait to finish/)).toBeTruthy();

      // Simulate the window losing focus (e.g., user Cmd+Tabs away mid-chord).
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });

      // Recording should be cancelled — the prompt and Save button both gone.
      expect(screen.queryByText("Save")).toBeNull();
      expect(screen.queryByText(/press second key or wait to finish/)).toBeNull();
      expect(screen.getByText("Click to record shortcut")).toBeTruthy();
    });

    it("invokes onCancel on window blur so parent capture coordination clears", () => {
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
        />
      );

      fireEvent.click(screen.getByText("Click to record shortcut"));

      act(() => {
        window.dispatchEvent(new Event("blur"));
      });

      expect(mockOnCancel).toHaveBeenCalled();
    });
  });

  describe("conflict suppression while validation error is active", () => {
    it("hides the conflicts section when validateCombo returns an error", async () => {
      const { keybindingService } = await import("@/services/KeybindingService");
      vi.mocked(keybindingService.findConflicts).mockReturnValue([
        {
          actionId: "conflict.action",
          description: "Conflicting Action",
          combo: "Cmd+A",
          scope: "global",
          priority: 0,
          kind: "conflict",
        },
      ]);

      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          validateCombo={() => "Use a different shape"}
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

      // Validation error is shown.
      expect(screen.getByTestId("shortcut-capture-validation-error")).toBeTruthy();
      // Conflict section suppressed — no Unbind button to accidentally fire.
      expect(screen.queryByText("Conflicts with:")).toBeNull();
      expect(screen.queryByText("Unbind")).toBeNull();
    });
  });

  describe("conflict remediation", () => {
    it("renders unbind buttons for each conflict", async () => {
      const { keybindingService } = await import("@/services/KeybindingService");
      vi.mocked(keybindingService.findConflicts).mockReturnValue([
        {
          actionId: "conflict.action1",
          description: "Conflicting Action 1",
          combo: "Cmd+A",
          scope: "global",
          priority: 0,
          kind: "conflict",
        },
        {
          actionId: "conflict.action2",
          description: "Conflicting Action 2",
          combo: "Cmd+B",
          scope: "global",
          priority: 0,
          kind: "conflict",
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

      expect(screen.getByText("Conflicts with:")).toBeTruthy();
      expect(screen.getByText("Conflicting Action 1")).toBeTruthy();
      expect(screen.getByText("Conflicting Action 2")).toBeTruthy();
      expect(screen.getAllByText("Unbind")).toHaveLength(2);
    });

    it("dispatches setOverride action when unbind button is clicked for override conflict", async () => {
      const { keybindingService } = await import("@/services/KeybindingService");
      const { actionService } = await import("@/services/ActionService");
      const { useNotificationStore } = await import("@/store/notificationStore");

      vi.mocked(keybindingService.findConflicts).mockReturnValue([
        {
          actionId: "conflict.action",
          description: "Conflicting Action",
          combo: "Cmd+A",
          scope: "global",
          priority: 0,
          kind: "conflict",
        },
      ]);

      vi.mocked(keybindingService.getOverride).mockReturnValue(["Cmd+K"]);
      vi.mocked(keybindingService.getDefaultCombo).mockReturnValue("Cmd+A");

      const addNotificationSpy = vi.fn();
      vi.mocked(useNotificationStore.getState).mockReturnValue({
        addNotification: addNotificationSpy,
        notifications: [],
        updateNotification: vi.fn(),
        dismissNotification: vi.fn(),
        removeNotification: vi.fn(),
        clearNotifications: vi.fn(),
        reset: vi.fn(),
      });

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

      await act(async () => {
        const unbindButton = screen.getByText("Unbind");
        fireEvent.click(unbindButton);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(actionService.dispatch).toHaveBeenCalledWith(
        "keybinding.removeOverride",
        { actionId: "conflict.action" },
        { source: "user" }
      );
    });

    it("shows toast with undo action after successful unbind", async () => {
      const { keybindingService } = await import("@/services/KeybindingService");

      vi.mocked(keybindingService.findConflicts).mockReturnValue([
        {
          actionId: "conflict.action",
          description: "Conflicting Action",
          combo: "Cmd+A",
          scope: "global",
          priority: 0,
          kind: "conflict",
        },
      ]);

      vi.mocked(keybindingService.getOverride).mockReturnValue(["Cmd+K"]);
      vi.mocked(keybindingService.getDefaultCombo).mockReturnValue("Cmd+A");

      notifyMock.mockClear();

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

      await act(async () => {
        fireEvent.click(screen.getByText("Unbind"));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(notifyMock).toHaveBeenCalledWith({
        type: "success",
        message: "Unbound Conflicting Action",
        duration: 5000,
        priority: "high",
        urgent: true,
        transient: true,
        action: expect.objectContaining({
          label: "Undo",
          onClick: expect.any(Function),
        }),
      });
    });

    it("handles multiple conflicts separately", async () => {
      const { keybindingService } = await import("@/services/KeybindingService");
      const { actionService } = await import("@/services/ActionService");

      vi.mocked(keybindingService.findConflicts).mockReturnValue([
        {
          actionId: "conflict.action1",
          description: "First Action",
          combo: "Cmd+A",
          scope: "global",
          priority: 0,
          kind: "conflict",
        },
        {
          actionId: "conflict.action2",
          description: "Second Action",
          combo: "Cmd+B",
          scope: "global",
          priority: 0,
          kind: "conflict",
        },
      ]);

      vi.mocked(keybindingService.getOverride).mockReturnValue(["Cmd+K"]);
      vi.mocked(keybindingService.getDefaultCombo).mockReturnValue("Cmd+A");

      notifyMock.mockClear();

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

      const unbindButtons = screen.getAllByText("Unbind");
      expect(unbindButtons).toHaveLength(2);

      await act(async () => {
        fireEvent.click(unbindButtons[0]!);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(actionService.dispatch).toHaveBeenCalledWith(
        "keybinding.removeOverride",
        { actionId: "conflict.action1" },
        { source: "user" }
      );

      await act(async () => {
        fireEvent.click(unbindButtons[1]!);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(actionService.dispatch).toHaveBeenCalledWith(
        "keybinding.removeOverride",
        { actionId: "conflict.action2" },
        { source: "user" }
      );

      expect(notifyMock).toHaveBeenCalledTimes(2);
    });
  });
});
