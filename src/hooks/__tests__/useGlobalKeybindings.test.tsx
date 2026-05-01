// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { _resetForTests, registerEscape } from "@/lib/escapeStack";

const mocks = vi.hoisted(() => ({
  keybindingService: {
    resolveKeybinding: vi.fn(),
    getPendingChord: vi.fn<() => string | null>(() => null),
    clearPendingChord: vi.fn(),
    popPendingChord: vi.fn(),
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

describe("useGlobalKeybindings — Backspace pops pending chord", () => {
  function dispatchBackspace(
    eventInit: KeyboardEventInit = {},
    target: EventTarget = document.body
  ) {
    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
      ...eventInit,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it("pops the pending chord and consumes the event when Backspace is pressed during a chord", () => {
    mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");

    render(<Host />);
    const event = dispatchBackspace();

    expect(mocks.keybindingService.popPendingChord).toHaveBeenCalledTimes(1);
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not pop or consume Backspace when no chord is pending", () => {
    mocks.keybindingService.getPendingChord.mockReturnValue(null);
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    render(<Host />);
    const event = dispatchBackspace();

    expect(mocks.keybindingService.popPendingChord).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves Backspace alone in a terminal when no chord is pending", () => {
    mocks.keybindingService.getPendingChord.mockReturnValue(null);
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    document.body.appendChild(xterm);

    try {
      render(<Host />);
      const event = dispatchBackspace({}, xterm);

      expect(mocks.keybindingService.popPendingChord).not.toHaveBeenCalled();
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      xterm.remove();
    }
  });

  it("does not pop or clear the chord while an IME composition is in flight", () => {
    mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");

    render(<Host />);
    // jsdom doesn't honor isComposing in the constructor init dict, so dispatch
    // a custom event with the property forced on.
    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "isComposing", { value: true, configurable: true });
    act(() => {
      document.body.dispatchEvent(event);
    });

    expect(mocks.keybindingService.popPendingChord).not.toHaveBeenCalled();
    expect(mocks.keybindingService.clearPendingChord).not.toHaveBeenCalled();
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
