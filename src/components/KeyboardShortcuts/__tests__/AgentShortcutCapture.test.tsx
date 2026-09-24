// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AgentShortcutCapture } from "../AgentShortcutCapture";
import { keybindingService } from "@/services/KeybindingService";
import type { KeybindingConflict } from "@/services/keybindingUtils";

vi.mock("@/services/KeybindingService", () => ({
  CHORD_TIMEOUT_MS: 1000,
  combosFieldsEqual: vi.fn((a: string, b: string) => a.toLowerCase() === b.toLowerCase()),
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

// Off macOS the recorder maps ctrlKey to the internal "Cmd" prefix.
function press(key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        ctrlKey: !!mods.ctrl,
        altKey: !!mods.alt,
        shiftKey: !!mods.shift,
        bubbles: true,
      })
    );
  });
}

function field() {
  return screen.getByTestId("shortcut-capture-field");
}

function saveButton() {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

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

  it("opens armed and states the agent rule before the first attempt", () => {
    render(<AgentShortcutCapture agentId="claude" onCapture={onCapture} onCancel={onCancel} />);

    expect(field().getAttribute("data-recording")).toBe("true");
    expect(field().textContent).toMatch(/letter/);
    expect(screen.queryByTestId("shortcut-capture-validation-error")).toBeNull();
  });

  it("finishes on the first stroke without waiting out the chord window", () => {
    render(<AgentShortcutCapture agentId="claude" onCapture={onCapture} onCancel={onCancel} />);

    press("k", { ctrl: true, alt: true });

    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(onCapture).toHaveBeenCalledWith("Cmd+Alt+k");
  });

  it("keeps recording after a combo that breaks the rule, so the next press is the retry", () => {
    render(<AgentShortcutCapture agentId="claude" onCapture={onCapture} onCancel={onCancel} />);

    press("k", { ctrl: true, shift: true });

    expect(screen.getByTestId("shortcut-capture-validation-error")).toBeTruthy();
    expect(field().getAttribute("data-recording")).toBe("true");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    press("k", { ctrl: true, alt: true });

    expect(screen.queryByTestId("shortcut-capture-validation-error")).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("rejects an extra modifier the same way as a missing one", () => {
    render(<AgentShortcutCapture agentId="claude" onCapture={onCapture} onCancel={onCancel} />);

    press("k", { ctrl: true, alt: true, shift: true });

    expect(screen.getByTestId("shortcut-capture-validation-error")).toBeTruthy();
    expect(onCapture).not.toHaveBeenCalled();
  });

  it("shows held modifiers before the letter lands", () => {
    render(<AgentShortcutCapture agentId="claude" onCapture={onCapture} onCancel={onCancel} />);
    const before = field().textContent;

    press("Control", { ctrl: true });

    expect(field().textContent).not.toBe(before);
    expect(field().textContent).toContain("Ctrl");
  });

  it("does not offer Save for the binding already in force", () => {
    render(
      <AgentShortcutCapture
        agentId="claude"
        currentCombo="Cmd+Alt+C"
        onCapture={onCapture}
        onCancel={onCancel}
      />
    );

    press("c", { ctrl: true, alt: true });

    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(onCapture).not.toHaveBeenCalled();
  });

  it("holds Save until a combo taken by another action is unbound", () => {
    const codex: KeybindingConflict = {
      actionId: "agent.codex",
      description: "Launch Codex agent",
      combo: "Cmd+Alt+X",
      scope: "global",
      priority: 0,
      kind: "conflict",
    };
    vi.mocked(keybindingService.findConflicts).mockReturnValue([codex]);
    render(<AgentShortcutCapture agentId="claude" onCapture={onCapture} onCancel={onCancel} />);

    press("x", { ctrl: true, alt: true });

    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Unbind Launch Codex agent" })).toBeTruthy();
  });

  it("offers Remove only when there is a binding to remove", () => {
    const { rerender } = render(
      <AgentShortcutCapture
        agentId="claude"
        currentCombo=""
        onCapture={onCapture}
        onCancel={onCancel}
      />
    );
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();

    rerender(
      <AgentShortcutCapture
        agentId="claude"
        currentCombo="Cmd+Alt+C"
        onCapture={onCapture}
        onCancel={onCancel}
      />
    );
    expect(screen.getByRole("button", { name: /^Remove/ })).toBeTruthy();
  });
});
