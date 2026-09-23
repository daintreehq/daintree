// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AgentShortcutCapture } from "../AgentShortcutCapture";

vi.mock("@/services/KeybindingService", () => ({
  CHORD_TIMEOUT_MS: 1000,
  keybindingService: {
    findConflicts: vi.fn(() => []),
    beginShortcutCapture: vi.fn(() => () => {}),
    formatComboForDisplay: vi.fn((combo: string) => combo),
    getOverride: vi.fn(() => undefined),
    getDefaultCombo: vi.fn(() => undefined),
  },
  normalizeKeyForBinding: vi.fn((e: KeyboardEvent) => e.key),
}));

vi.mock("@/lib/platform", () => ({
  isMac: vi.fn(() => false),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: { getState: vi.fn(() => ({ addNotification: vi.fn() })) },
}));

describe("AgentShortcutCapture", () => {
  const onCapture = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a Cmd+Alt+letter combo and forwards to onCapture", () => {
    render(<AgentShortcutCapture agentId="claude" onCapture={onCapture} onCancel={onCancel} />);

    fireEvent.click(screen.getByText("Click to record shortcut"));

    // On non-Mac, ctrlKey + altKey + KeyK produces the internal "Cmd+Alt+k" combo
    // via SettingsShortcutCapture's normalization (ctrlKey -> "Cmd" prefix).
    const ev = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(ev);
      vi.advanceTimersByTime(1100);
    });

    expect(screen.queryByTestId("shortcut-capture-validation-error")).toBeNull();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onCapture).toHaveBeenCalledWith("Cmd+Alt+k");
  });

  it("rejects a Cmd+letter combo (missing Alt) and disables Save", () => {
    render(<AgentShortcutCapture agentId="claude" onCapture={onCapture} onCancel={onCancel} />);

    fireEvent.click(screen.getByText("Click to record shortcut"));

    const ev = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(ev);
      vi.advanceTimersByTime(1100);
    });

    expect(screen.getByTestId("shortcut-capture-validation-error")).toBeTruthy();
    expect(screen.getByText(/Ctrl\+Alt\+letter/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onCapture).not.toHaveBeenCalled();
  });

  it("rejects Cmd+Shift+Alt+letter (extra modifier) and disables Save", () => {
    render(<AgentShortcutCapture agentId="claude" onCapture={onCapture} onCancel={onCancel} />);

    fireEvent.click(screen.getByText("Click to record shortcut"));

    const ev = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(ev);
      vi.advanceTimersByTime(1100);
    });

    expect(screen.getByTestId("shortcut-capture-validation-error")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});
