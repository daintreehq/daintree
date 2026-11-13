// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SettingsShortcutCapture } from "../SettingsShortcutCapture";
import { keybindingService, type RegisteredKeybindingConfig } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";

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
      beginShortcutCapture: vi.fn(() => () => {}),
      formatComboForDisplay: vi.fn((combo: string) => combo),
      getOverride: vi.fn((): string[] | undefined => undefined),
      getTriggerCombos: vi.fn((): string[] => []),
      getAllBindingsWithEffectiveCombos: vi.fn(
        (): Array<
          RegisteredKeybindingConfig & { effectiveCombo: string; effectiveCombos: string[] }
        > => []
      ),
      hasOverride: vi.fn(() => false),
    },
    normalizeKeyForBinding: vi.fn((e: KeyboardEvent) => e.key),
  };
});

vi.mock("@/lib/platform", () => ({
  isMac: vi.fn(() => false),
  isWindows: vi.fn(() => false),
  isLinux: vi.fn(() => false),
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

describe("SettingsShortcutCapture", () => {
  const mockOnCapture = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // clearAllMocks keeps configured return values, and the Unbind tests each set their own.
    vi.mocked(keybindingService.findConflicts).mockReturnValue([]);
    vi.mocked(keybindingService.getOverride).mockReturnValue(undefined);
    vi.mocked(keybindingService.getTriggerCombos).mockReturnValue([]);
    vi.mocked(keybindingService.getAllBindingsWithEffectiveCombos).mockReturnValue([]);
    vi.mocked(keybindingService.hasOverride).mockReturnValue(false);
    vi.mocked(actionService.dispatch).mockResolvedValue({ ok: true, result: undefined });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
    expect(updatedStatus.textContent).toContain("Press a key combination");
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

    // The waiting state shows the first stroke as keys beside the instruction,
    // so the user can see what the second key will be appended to.
    const instruction = screen.getByText(/Press second key or wait to finish/);
    const firstStroke = instruction.previousElementSibling;
    expect(firstStroke?.querySelectorAll("kbd").length).toBeGreaterThan(0);

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
    expect(screen.queryByText(/Press second key or wait to finish/)).toBeNull();
  });

  it("calls onCapture with empty string when Remove shortcut is clicked", async () => {
    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
      />
    );

    fireEvent.click(screen.getByText("Remove shortcut"));

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
    expect(screen.getByText("Press a key combination")).toBeTruthy();
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
    expect(screen.getByText("Press a key combination")).toBeTruthy();
  });

  it("threads scope prop into findConflicts", async () => {
    const { keybindingService } = await import("@/services/KeybindingService");
    vi.mocked(keybindingService.findConflicts).mockReturnValue([]);

    render(
      <SettingsShortcutCapture
        onCapture={mockOnCapture}
        onCancel={mockOnCancel}
        excludeActionId="test.action"
        scope="portal"
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

    expect(keybindingService.findConflicts).toHaveBeenCalledWith(
      expect.any(String),
      "test.action",
      "portal"
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

      expect(screen.getByText("Press a key combination")).toBeTruthy();
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

      expect(screen.getByText("Press a key combination")).toBeTruthy();
      expect(keyEvent.defaultPrevented).toBe(false);
      expect(stopPropagationSpy).not.toHaveBeenCalled();
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
      expect(screen.getByText(/Press second key or wait to finish/)).toBeTruthy();

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
      expect(screen.queryByText(/Press second key or wait to finish/)).toBeNull();
      expect(screen.queryByText(/\(chord\)/)).toBeNull();
      expect(screen.getByText("Save")).toBeTruthy();
    });
  });

  describe("validateCombo prop", () => {
    it("shows the validation error and stays armed for a retry, with nothing to save", () => {
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

      // The refused combo stays on show in the armed recorder, not as a pending first key.
      const field = screen.getByTestId("shortcut-capture-field");
      expect(field.getAttribute("data-recording")).toBe("true");
      expect(field.textContent).toContain("Try again");
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

      // The next press is a fresh attempt, not the second key of a chord.
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "d", code: "KeyD", ctrlKey: true, bubbles: true })
        );
        vi.advanceTimersByTime(1100);
      });
      expect(validate).toHaveBeenLastCalledWith("Cmd+d");
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

      const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
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

      expect(screen.getByText(/Press second key or wait to finish/)).toBeTruthy();

      // Simulate the window losing focus (e.g., user Cmd+Tabs away mid-chord).
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });

      // Recording should be cancelled — the prompt and Save button both gone.
      expect(screen.queryByText("Save")).toBeNull();
      expect(screen.queryByText(/Press second key or wait to finish/)).toBeNull();
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
      expect(screen.queryByText("Conflicts with")).toBeNull();
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

      expect(screen.getByText("Conflicts with")).toBeTruthy();
      expect(screen.getByText("Conflicting Action 1")).toBeTruthy();
      expect(screen.getByText("Conflicting Action 2")).toBeTruthy();
      expect(screen.getAllByText("Unbind")).toHaveLength(2);
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
      vi.mocked(keybindingService.getTriggerCombos).mockReturnValue(["Cmd+K"]);

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
      vi.mocked(keybindingService.getTriggerCombos).mockReturnValue(["Cmd+K"]);

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
        "keybinding.setOverride",
        { actionId: "conflict.action1", combo: [] },
        { source: "user" }
      );

      await act(async () => {
        fireEvent.click(unbindButtons[1]!);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(actionService.dispatch).toHaveBeenCalledWith(
        "keybinding.setOverride",
        { actionId: "conflict.action2", combo: [] },
        { source: "user" }
      );

      expect(notifyMock).toHaveBeenCalledTimes(2);
    });

    function captureKey(init: KeyboardEventInit) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
        vi.advanceTimersByTime(1100);
      });
    }

    const lastToast = () =>
      notifyMock.mock.calls.at(-1)?.[0] as { action: { onClick: () => Promise<void> } };

    it("unbinds only the clashing default of a two-key action, and Undo drops the override", async () => {
      const { actionService } = await import("@/services/ActionService");
      let freed = false;
      vi.mocked(keybindingService.getTriggerCombos).mockReturnValue(["Cmd+=", "Cmd+Shift+="]);
      vi.mocked(keybindingService.findConflicts).mockImplementation(() =>
        freed
          ? []
          : [
              {
                actionId: "window.zoomIn",
                description: "Zoom in",
                combo: "Cmd+Shift+=",
                scope: "global",
                priority: 0,
                kind: "conflict",
              },
            ]
      );
      vi.mocked(actionService.dispatch).mockImplementation(async () => {
        freed = true;
        return { ok: true, result: undefined };
      });

      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          autoStart
        />
      );
      captureKey({ key: "=", code: "Equal", ctrlKey: true, shiftKey: true });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Unbind Zoom in" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(keybindingService.getTriggerCombos).toHaveBeenCalledWith("window.zoomIn");
      expect(actionService.dispatch).toHaveBeenCalledWith(
        "keybinding.setOverride",
        { actionId: "window.zoomIn", combo: ["Cmd+="] },
        { source: "user" }
      );
      expect(screen.queryByRole("button", { name: "Unbind Zoom in" })).toBeNull();

      await act(async () => {
        await lastToast().action.onClick();
      });
      expect(actionService.dispatch).toHaveBeenLastCalledWith(
        "keybinding.removeOverride",
        { actionId: "window.zoomIn" },
        { source: "user" }
      );
    });

    it("frees one key of an override, and Undo puts back the exact list it had", async () => {
      const { actionService } = await import("@/services/ActionService");
      vi.mocked(keybindingService.getOverride).mockReturnValue(["Cmd+=", "Cmd+K"]);
      vi.mocked(keybindingService.getTriggerCombos).mockReturnValue(["Cmd+=", "Cmd+K"]);
      vi.mocked(keybindingService.findConflicts).mockReturnValue([
        {
          actionId: "window.zoomIn",
          description: "Zoom in",
          combo: "Cmd+K",
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
          autoStart
        />
      );
      captureKey({ key: "k", code: "KeyK", ctrlKey: true });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Unbind Zoom in" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(actionService.dispatch).toHaveBeenCalledWith(
        "keybinding.setOverride",
        { actionId: "window.zoomIn", combo: ["Cmd+="] },
        { source: "user" }
      );

      await act(async () => {
        await lastToast().action.onClick();
      });
      expect(actionService.dispatch).toHaveBeenLastCalledWith(
        "keybinding.setOverride",
        { actionId: "window.zoomIn", combo: ["Cmd+=", "Cmd+K"] },
        { source: "user" }
      );
    });

    it("says before Unbind which of the other action's keys will apply more widely", () => {
      const fleet = (combo: string, scope: "global" | "worktreeGrid") => ({
        actionId: "fleet.armFocused",
        description: "Toggle arm focused terminal",
        combo,
        scope,
        priority: 0,
        effectiveCombo: combo,
        effectiveCombos: [combo],
      });
      vi.mocked(keybindingService.getAllBindingsWithEffectiveCombos).mockReturnValue([
        fleet("Cmd+J", "global"),
        fleet("X", "worktreeGrid"),
      ]);
      vi.mocked(keybindingService.findConflicts).mockReturnValue([
        { ...fleet("Cmd+J", "global"), kind: "conflict" },
      ]);

      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          autoStart
        />
      );
      captureKey({ key: "j", code: "KeyJ", ctrlKey: true });

      const unbind = screen.getByRole("button", { name: "Unbind Toggle arm focused terminal" });
      const note = document.getElementById(unbind.getAttribute("aria-describedby") ?? "");
      expect(note?.textContent).toMatch(/^After unbinding, .*X.* applies across the app$/);
    });

    it("says nothing extra when the other action's remaining keys keep their scope", () => {
      vi.mocked(keybindingService.getAllBindingsWithEffectiveCombos).mockReturnValue([
        {
          actionId: "window.zoomIn",
          description: "Zoom in",
          combo: "Cmd+=",
          scope: "global",
          priority: 0,
          effectiveCombo: "Cmd+=",
          effectiveCombos: ["Cmd+="],
        },
        {
          actionId: "window.zoomIn",
          description: "Zoom in",
          combo: "Cmd+K",
          scope: "global",
          priority: 0,
          effectiveCombo: "Cmd+K",
          effectiveCombos: ["Cmd+K"],
        },
      ]);
      vi.mocked(keybindingService.findConflicts).mockReturnValue([
        {
          actionId: "window.zoomIn",
          description: "Zoom in",
          combo: "Cmd+K",
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
          autoStart
        />
      );
      captureKey({ key: "k", code: "KeyK", ctrlKey: true });

      const unbind = screen.getByRole("button", { name: "Unbind Zoom in" });
      expect(unbind.getAttribute("aria-describedby")).toBeNull();
      expect(screen.queryByText(/After unbinding/)).toBeNull();
    });

    it("redraws the list and moves focus on when the key was already freed elsewhere", async () => {
      const { actionService } = await import("@/services/ActionService");
      let freed = false;
      vi.mocked(keybindingService.findConflicts).mockImplementation(() =>
        freed
          ? []
          : [
              {
                actionId: "window.zoomIn",
                description: "Zoom in",
                combo: "Cmd+K",
                scope: "global",
                priority: 0,
                kind: "conflict",
              },
            ]
      );

      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          autoStart
        />
      );
      captureKey({ key: "k", code: "KeyK", ctrlKey: true });

      // Another window took Cmd+K off Zoom in after the list was drawn.
      freed = true;
      vi.mocked(keybindingService.getTriggerCombos).mockReturnValue(["Cmd+="]);
      const unbind = screen.getByRole("button", { name: "Unbind Zoom in" });
      unbind.focus();
      await act(async () => {
        fireEvent.click(unbind);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(actionService.dispatch).not.toHaveBeenCalled();
      expect(notifyMock).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Unbind Zoom in" })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
    });
  });

  describe("keyboard ownership and exit", () => {
    beforeEach(async () => {
      const { normalizeKeyForBinding } = await import("@/services/KeybindingService");
      vi.mocked(normalizeKeyForBinding).mockImplementation((e: KeyboardEvent) => e.key);
    });

    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      act(() => {
        window.dispatchEvent(event);
      });
      return event;
    };

    const renderArmed = (
      props: Partial<React.ComponentProps<typeof SettingsShortcutCapture>> = {}
    ) =>
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          autoStart
          {...props}
        />
      );

    const recording = () =>
      screen.getByTestId("shortcut-capture-field").getAttribute("data-recording") === "true";

    it("owns the app's shortcut handling only while it is recording", async () => {
      const { keybindingService } = await import("@/services/KeybindingService");
      const release = vi.fn();
      vi.mocked(keybindingService.beginShortcutCapture).mockReturnValue(release);

      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          autoStart
        />
      );
      expect(keybindingService.beginShortcutCapture).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();

      press({ key: "k", code: "KeyK", ctrlKey: true });
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      expect(release).toHaveBeenCalledTimes(1);
    });

    it("leaves on bare Escape instead of recording it", () => {
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          autoStart
        />
      );

      press({ key: "Escape", code: "Escape" });

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
      expect(mockOnCapture).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    });

    it("puts the earlier combo back when Escape abandons a re-record", () => {
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          autoStart
        />
      );
      press({ key: "k", code: "KeyK", ctrlKey: true });
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      fireEvent.click(screen.getByRole("button", { name: "Record again" }));
      press({ key: "Escape", code: "Escape" });

      expect(mockOnCancel).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(mockOnCapture).toHaveBeenCalledWith("Cmd+k");
    });

    it("still records Escape when it carries a modifier", () => {
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          autoStart
        />
      );

      press({ key: "Escape", code: "Escape", shiftKey: true });
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      expect(mockOnCancel).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(mockOnCapture).toHaveBeenCalledWith("Shift+Escape");
    });

    it.each([
      ["Tab", false],
      ["Shift+Tab", true],
    ])("hands the keyboard back on %s instead of recording it", (_name, shiftKey) => {
      renderArmed();

      const tab = press({ key: "Tab", code: "Tab", shiftKey });

      // At once, not when some timeout lets go.
      const field = screen.getByTestId("shortcut-capture-field");
      expect(tab.defaultPrevented).toBe(true);
      expect(field.getAttribute("data-recording")).toBeNull();
      expect(document.activeElement).toBe(field);
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
      expect(mockOnCancel).not.toHaveBeenCalled();
      expect(mockOnCapture).not.toHaveBeenCalled();
    });

    it("puts the earlier combo back when Tab leaves a re-record", () => {
      renderArmed();
      press({ key: "k", code: "KeyK", ctrlKey: true });
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      fireEvent.click(screen.getByRole("button", { name: "Record again" }));
      press({ key: "Tab", code: "Tab" });

      const save = screen.getByRole("button", { name: "Save" });
      expect(document.activeElement).toBe(save);
      expect(mockOnCancel).not.toHaveBeenCalled();
      fireEvent.click(save);
      expect(mockOnCapture).toHaveBeenCalledWith("Cmd+k");
    });

    it.each([
      ["Ctrl+Tab", { key: "Tab", ctrlKey: true }, "Cmd+Tab"],
      ["Alt+Tab", { key: "Tab", altKey: true }, "Alt+Tab"],
      ["bare Enter", { key: "Enter" }, "Enter"],
    ])("still records %s as a first key", (_name, init, combo) => {
      renderArmed();

      press({ code: init.key, ...init });
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(mockOnCapture).toHaveBeenCalledWith(combo);
    });

    it.each([
      ["Enter", "Enter", false],
      ["Tab", "Tab", false],
      ["Shift+Tab", "Tab", true],
    ])(
      "ends the second-key window on %s, keeping the first key and landing on Save",
      (_name, key, shiftKey) => {
        renderArmed();

        press({ key: "k", code: "KeyK", ctrlKey: true });
        const ending = press({ key, code: key, shiftKey });

        const save = screen.getByRole("button", { name: "Save" });
        expect(ending.defaultPrevented).toBe(true);
        expect(recording()).toBe(false);
        expect(document.activeElement).toBe(save);

        // The cancelled window must not fire later and replace the draft.
        act(() => {
          vi.advanceTimersByTime(1100);
        });
        fireEvent.click(save);
        expect(mockOnCapture).toHaveBeenCalledWith("Cmd+k");
      }
    );

    it.each([
      ["Ctrl+Enter", { key: "Enter", ctrlKey: true }, "Cmd+k Cmd+Enter"],
      ["Shift+Enter", { key: "Enter", shiftKey: true }, "Cmd+k Shift+Enter"],
      ["Alt+Enter", { key: "Enter", altKey: true }, "Cmd+k Alt+Enter"],
      ["Ctrl+Tab", { key: "Tab", ctrlKey: true }, "Cmd+k Cmd+Tab"],
      ["Alt+Tab", { key: "Tab", altKey: true }, "Cmd+k Alt+Tab"],
    ])("still records %s as the second key of a chord", (_name, init, combo) => {
      renderArmed();

      press({ key: "k", code: "KeyK", ctrlKey: true });
      press({ code: init.key, ...init });

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(mockOnCapture).toHaveBeenCalledWith(combo);
    });

    it.each(["Enter", "Tab"])(
      "stays armed when %s ends the window on a refused first key, and the retry is fresh",
      (key) => {
        renderArmed({
          validateCombo: (combo) => (combo === "Cmd+k" ? "Not this one" : null),
        });

        press({ key: "k", code: "KeyK", ctrlKey: true });
        press({ key, code: key });

        expect(recording()).toBe(true);
        expect(screen.getByTestId("shortcut-capture-field").textContent).toContain("Try again");
        expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

        // A retry that straddles the refused key's old deadline is not cut short by it.
        act(() => {
          vi.advanceTimersByTime(500);
        });
        press({ key: "j", code: "KeyJ", ctrlKey: true });
        act(() => {
          vi.advanceTimersByTime(600);
        });
        expect(recording()).toBe(true);
        expect(screen.getByText(/Press second key or wait to finish/)).toBeTruthy();

        act(() => {
          vi.advanceTimersByTime(500);
        });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(mockOnCapture).toHaveBeenCalledWith("Cmd+j");
      }
    );

    it("drops a waiting first key on Escape, and its window never fires afterwards", () => {
      renderArmed();

      press({ key: "k", code: "KeyK", ctrlKey: true });
      press({ key: "Escape", code: "Escape" });
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
      expect(mockOnCapture).not.toHaveBeenCalled();
    });

    it("keeps the earlier combo when Escape abandons a re-record mid-window", () => {
      renderArmed();
      press({ key: "k", code: "KeyK", ctrlKey: true });
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      fireEvent.click(screen.getByRole("button", { name: "Record again" }));
      press({ key: "j", code: "KeyJ", ctrlKey: true });
      press({ key: "Escape", code: "Escape" });
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      expect(mockOnCancel).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(mockOnCapture).toHaveBeenCalledWith("Cmd+k");
    });

    it("starts clean after a mid-window blur, without the old window cutting it short", () => {
      renderArmed();

      press({ key: "k", code: "KeyK", ctrlKey: true });
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      expect(mockOnCancel).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Click to record shortcut" }));
      act(() => {
        vi.advanceTimersByTime(500);
      });
      press({ key: "j", code: "KeyJ", ctrlKey: true });
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(recording()).toBe(true);

      act(() => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(mockOnCapture).toHaveBeenCalledWith("Cmd+j");
    });

    it("finishes the second-key window even when its host hands it new callbacks mid-window", () => {
      const { rerender } = renderArmed({ validateCombo: () => null });

      press({ key: "k", code: "KeyK", ctrlKey: true });
      // The settings list rebuilds its validator when an Unbind lands in the window.
      rerender(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={() => mockOnCancel()}
          excludeActionId="test.action"
          autoStart
          validateCombo={() => null}
        />
      );
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      expect(recording()).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(mockOnCapture).toHaveBeenCalledWith("Cmd+k");
    });

    it("keeps Control as its own modifier on macOS instead of dropping it", async () => {
      const { isMac } = await import("@/lib/platform");
      vi.mocked(isMac).mockReturnValue(true);
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          autoStart
        />
      );

      press({ key: "r", code: "KeyR", ctrlKey: true, metaKey: true });
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(mockOnCapture).toHaveBeenCalledWith("Cmd+Ctrl+r");
      vi.mocked(isMac).mockReturnValue(false);
    });

    it("unbinds a plugin binding the defaults don't know, and Undo puts it back to inherited", async () => {
      const { keybindingService } = await import("@/services/KeybindingService");
      const { actionService } = await import("@/services/ActionService");
      vi.mocked(keybindingService.getOverride).mockReturnValue(undefined);
      vi.mocked(keybindingService.getTriggerCombos).mockReturnValue(["Cmd+K"]);
      vi.mocked(keybindingService.findConflicts).mockReturnValue([
        {
          actionId: "plugin.thing",
          description: "Plugin thing",
          combo: "Cmd+K",
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
          autoStart
        />
      );
      press({ key: "k", code: "KeyK", ctrlKey: true });
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Unbind Plugin thing" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(actionService.dispatch).toHaveBeenCalledWith(
        "keybinding.setOverride",
        { actionId: "plugin.thing", combo: [] },
        { source: "user" }
      );

      const toast = notifyMock.mock.calls.at(-1)?.[0] as {
        action: { onClick: () => Promise<void> };
      };
      await act(async () => {
        await toast.action.onClick();
      });
      expect(actionService.dispatch).toHaveBeenLastCalledWith(
        "keybinding.removeOverride",
        { actionId: "plugin.thing" },
        { source: "user" }
      );
    });

    it("closes the edit on Escape once a combo is captured, instead of letting it close settings", () => {
      const outer = vi.fn();
      render(
        <div onKeyDown={outer}>
          <SettingsShortcutCapture
            onCapture={mockOnCapture}
            onCancel={mockOnCancel}
            excludeActionId="test.action"
            autoStart
          />
        </div>
      );
      press({ key: "k", code: "KeyK", ctrlKey: true });
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      fireEvent.keyDown(screen.getByRole("button", { name: "Save" }), { key: "Escape" });

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
      expect(outer).not.toHaveBeenCalled();
    });

    it("won't save a combo that is already the current shortcut", () => {
      render(
        <SettingsShortcutCapture
          onCapture={mockOnCapture}
          onCancel={mockOnCancel}
          excludeActionId="test.action"
          currentCombo="Cmd+K"
          autoStart
        />
      );
      press({ key: "k", code: "KeyK", ctrlKey: true });
      act(() => {
        vi.advanceTimersByTime(1100);
      });

      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        true
      );
      expect(screen.getByText("Already the current shortcut")).toBeTruthy();
    });
  });
});
