// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { _resetForTests, registerEscape } from "@/lib/escapeStack";

const mocks = vi.hoisted(() => ({
  keybindingService: {
    resolveKeybinding: vi.fn(),
    getPendingChord: vi.fn(() => null),
    clearPendingChord: vi.fn(),
    getEffectiveCombo: vi.fn(() => undefined),
    subscribe: vi.fn(() => () => {}),
  },
  actionService: {
    dispatch: vi.fn(async () => ({ ok: true, result: undefined })),
  },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: mocks.keybindingService,
  normalizeKeyForBinding: (event: KeyboardEvent) => event.key,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: mocks.actionService,
}));

vi.mock("../../store", () => ({
  usePanelStore: { getState: () => ({ focusedId: null }) },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

const { useGlobalKeybindings } = await import("../useGlobalKeybindings");

function Host() {
  useGlobalKeybindings(true);
  return null;
}

function pressCmdW() {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true, cancelable: true })
    );
  });
}

beforeEach(() => {
  _resetForTests();
  vi.clearAllMocks();
  mocks.keybindingService.getPendingChord.mockReturnValue(null);
  mocks.actionService.dispatch.mockResolvedValue({ ok: true, result: undefined });
});

describe("useGlobalKeybindings — Cmd+W escape stack guard", () => {
  it("routes Cmd+W to escape stack when a dialog is open instead of dispatching terminal.close", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "terminal.close" },
      chordPrefix: false,
      shouldConsume: true,
    });

    const escapeHandler = vi.fn();
    registerEscape(escapeHandler);

    render(<Host />);
    pressCmdW();

    expect(escapeHandler).toHaveBeenCalledTimes(1);
    expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches terminal.close when the escape stack is empty", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "terminal.close" },
      chordPrefix: false,
      shouldConsume: true,
    });

    render(<Host />);
    pressCmdW();

    expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
      "terminal.close",
      undefined,
      expect.objectContaining({ source: "keybinding" })
    );
  });

  it("does not divert other actions to the escape stack when handlers are registered", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "panel.cycleNext" },
      chordPrefix: false,
      shouldConsume: true,
    });

    const escapeHandler = vi.fn();
    registerEscape(escapeHandler);

    render(<Host />);
    pressCmdW();

    expect(escapeHandler).not.toHaveBeenCalled();
    expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
      "panel.cycleNext",
      undefined,
      expect.objectContaining({ source: "keybinding" })
    );
  });

  it("falls back to terminal.close after the dialog unregisters its escape handler", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "terminal.close" },
      chordPrefix: false,
      shouldConsume: true,
    });

    const escapeHandler = vi.fn();
    const { unregister } = registerEscape(escapeHandler);

    render(<Host />);
    pressCmdW();
    expect(escapeHandler).toHaveBeenCalledTimes(1);
    expect(mocks.actionService.dispatch).not.toHaveBeenCalled();

    unregister();
    pressCmdW();
    expect(escapeHandler).toHaveBeenCalledTimes(1);
    expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
      "terminal.close",
      undefined,
      expect.objectContaining({ source: "keybinding" })
    );
  });
});
