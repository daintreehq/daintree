// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { _resetForTests, registerEscape } from "@/lib/escapeStack";
import type { PaletteId } from "@/store/paletteStore";

function parseComboLite(combo: string) {
  const parts = combo.split("+").map((p) => p.trim());
  const key = parts.pop() || "";
  return {
    cmd: parts.some((p) => p.toLowerCase() === "cmd" || p.toLowerCase() === "meta"),
    ctrl: parts.some((p) => p.toLowerCase() === "ctrl"),
    shift: parts.some((p) => p.toLowerCase() === "shift"),
    alt: parts.some((p) => p.toLowerCase() === "alt" || p.toLowerCase() === "option"),
    key,
  };
}

const mocks = vi.hoisted(() => ({
  keybindingService: {
    resolveKeybinding: vi.fn(),
    getPendingChord: vi.fn<() => string | null>(() => null),
    clearPendingChord: vi.fn(),
    popPendingChord: vi.fn(),
    getEffectiveCombo: vi.fn<(actionId: string) => string | undefined>(() => undefined),
    subscribe: vi.fn(() => () => {}),
    // matchesEvent is invoked by the focus-region bypass. Lite mock that maps
    // Cmd→metaKey (mac-style) — sufficient for the tests in this file.
    matchesEvent: vi.fn((event: KeyboardEvent, combo: string) => {
      const p = parseComboLite(combo);
      if (p.cmd !== !!event.metaKey) return false;
      if (p.ctrl !== !!event.ctrlKey) return false;
      if (p.shift !== !!event.shiftKey) return false;
      if (p.alt !== !!event.altKey) return false;
      return p.key.toLowerCase() === (event.key || "").toLowerCase();
    }),
  },
  actionService: {
    // Typed signature so mock.calls is a labeled tuple (not the empty tuple),
    // letting tests destructure the dispatched actionId without TS2493.
    dispatch: vi.fn<
      (
        actionId: string,
        args?: unknown,
        options?: unknown
      ) => Promise<{ ok: boolean; result?: unknown; error?: unknown }>
    >(async () => ({ ok: true, result: undefined })),
  },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: mocks.keybindingService,
  normalizeKeyForBinding: (event: KeyboardEvent) => event.key,
  parseCombo: parseComboLite,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: mocks.actionService,
}));

vi.mock("../../store", () => ({
  usePanelStore: { getState: () => ({ focusedId: null }) },
  usePaletteStore: {
    getState: vi.fn(() => ({ activePaletteId: null })),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

const { useGlobalKeybindings } = await import("../useGlobalKeybindings");
const { usePaletteStore } = await import("../../store");

function makePaletteState(activePaletteId: PaletteId | null) {
  return {
    activePaletteId,
    openPalette: vi.fn(),
    closePalette: vi.fn(),
  };
}

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
  vi.mocked(usePaletteStore.getState).mockReturnValue(makePaletteState(null));
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

  it("dispatches terminal.close when focus is inside a grid panel even with handlers registered", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "terminal.close" },
      chordPrefix: false,
      shouldConsume: true,
    });

    const gridPanel = document.createElement("div");
    gridPanel.setAttribute("data-panel-location", "grid");
    const focusable = document.createElement("div");
    focusable.tabIndex = -1;
    gridPanel.appendChild(focusable);
    document.body.appendChild(gridPanel);

    try {
      const escapeHandler = vi.fn();
      registerEscape(escapeHandler);

      render(<Host />);
      focusable.focus();
      expect(document.activeElement).toBe(focusable);

      pressCmdW();

      expect(escapeHandler).not.toHaveBeenCalled();
      expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
        "terminal.close",
        undefined,
        expect.objectContaining({ source: "keybinding" })
      );
    } finally {
      gridPanel.remove();
    }
  });

  it("dispatches terminal.close when focus is inside a dock panel", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "terminal.close" },
      chordPrefix: false,
      shouldConsume: true,
    });

    const dockPanel = document.createElement("div");
    dockPanel.setAttribute("data-panel-location", "dock");
    const focusable = document.createElement("div");
    focusable.tabIndex = -1;
    dockPanel.appendChild(focusable);
    document.body.appendChild(dockPanel);

    try {
      const escapeHandler = vi.fn();
      registerEscape(escapeHandler);

      render(<Host />);
      focusable.focus();
      expect(document.activeElement).toBe(focusable);

      pressCmdW();

      expect(escapeHandler).not.toHaveBeenCalled();
      expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
        "terminal.close",
        undefined,
        expect.objectContaining({ source: "keybinding" })
      );
    } finally {
      dockPanel.remove();
    }
  });

  it("closes the Daintree Assistant via help.togglePanel when its panel is focused (issue #10509)", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "terminal.close" },
      chordPrefix: false,
      shouldConsume: true,
    });

    // The assistant runs an embedded xterm whose focused escape handler bails
    // to let Escape reach the PTY, so routing Cmd+W through the escape stack
    // would swallow it. Focus inside the aside must close the assistant instead.
    const assistant = document.createElement("aside");
    assistant.id = "daintree-assistant-panel";
    const focusable = document.createElement("div");
    focusable.tabIndex = -1;
    assistant.appendChild(focusable);
    document.body.appendChild(assistant);

    try {
      const escapeHandler = vi.fn();
      registerEscape(escapeHandler);

      render(<Host />);
      focusable.focus();
      expect(document.activeElement).toBe(focusable);

      pressCmdW();

      expect(escapeHandler).not.toHaveBeenCalled();
      expect(mocks.actionService.dispatch).toHaveBeenCalledTimes(1);
      expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
        "help.togglePanel",
        undefined,
        expect.objectContaining({ source: "keybinding" })
      );
      // terminal.close must NOT also fire — the assistant branch returns early.
      // expect.anything() would not match the production `undefined` second arg,
      // so assert against the dispatched action ids directly.
      expect(mocks.actionService.dispatch.mock.calls.map(([id]) => id)).not.toContain(
        "terminal.close"
      );
    } finally {
      assistant.remove();
    }
  });

  it("routes Cmd+W to escape stack when focus has no panel ancestor (dialog/body)", () => {
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

describe("useGlobalKeybindings — palette Escape capture", () => {
  function dispatchEscape(target: EventTarget = document.body) {
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it("routes bare Escape to the escape stack before the xterm guard when a palette is active", () => {
    vi.mocked(usePaletteStore.getState).mockReturnValue(makePaletteState("quick-switcher"));
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    document.body.appendChild(xterm);

    try {
      const escapeHandler = vi.fn();
      registerEscape(escapeHandler);

      render(<Host />);
      const event = dispatchEscape(xterm);

      expect(escapeHandler).toHaveBeenCalledTimes(1);
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    } finally {
      xterm.remove();
    }
  });

  it("routes bare Escape to the escape stack for non-terminal overlays even without palette state", () => {
    vi.mocked(usePaletteStore.getState).mockReturnValue(makePaletteState(null));
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    const overlay = document.createElement("div");
    overlay.tabIndex = -1;
    document.body.appendChild(overlay);

    try {
      const escapeHandler = vi.fn();
      registerEscape(escapeHandler);

      render(<Host />);
      const event = dispatchEscape(overlay);

      expect(escapeHandler).toHaveBeenCalledTimes(1);
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    } finally {
      overlay.remove();
    }
  });

  it("leaves bare Escape in editable controls to the control when no palette is active", () => {
    vi.mocked(usePaletteStore.getState).mockReturnValue(makePaletteState(null));
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    const input = document.createElement("input");
    document.body.appendChild(input);

    try {
      const escapeHandler = vi.fn();
      registerEscape(escapeHandler);

      render(<Host />);
      const event = dispatchEscape(input);

      expect(escapeHandler).not.toHaveBeenCalled();
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      input.remove();
    }
  });

  it("routes bare Escape before the xterm guard when a modal dialog is visible", () => {
    vi.mocked(usePaletteStore.getState).mockReturnValue(makePaletteState(null));
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    dialog.appendChild(xterm);
    document.body.appendChild(dialog);

    try {
      const escapeHandler = vi.fn();
      registerEscape(escapeHandler);

      render(<Host />);
      const event = dispatchEscape(xterm);

      expect(escapeHandler).toHaveBeenCalledTimes(1);
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    } finally {
      dialog.remove();
    }
  });

  it("leaves bare Escape inside xterm alone when no palette is active", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    document.body.appendChild(xterm);

    try {
      const escapeHandler = vi.fn();
      registerEscape(escapeHandler);

      render(<Host />);
      const event = dispatchEscape(xterm);

      expect(escapeHandler).not.toHaveBeenCalled();
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      xterm.remove();
    }
  });
});

describe("useGlobalKeybindings — Dead key guard (issue #7303)", () => {
  function dispatchDead(target: EventTarget = document.body, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", {
      key: "Dead",
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it("ignores Dead keydowns entirely — does not resolve and does not clear a pending chord", () => {
    mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");

    render(<Host />);
    const event = dispatchDead(document.body, { altKey: true });

    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    expect(mocks.keybindingService.clearPendingChord).not.toHaveBeenCalled();
    expect(mocks.keybindingService.popPendingChord).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores Dead even with no pending chord", () => {
    mocks.keybindingService.getPendingChord.mockReturnValue(null);

    render(<Host />);
    const event = dispatchDead();

    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("survives a Dead keydown sandwiched between chord steps", () => {
    // Pending chord is "Cmd+K". A Dead keydown arrives mid-chord; it must not
    // clear the chord. The next real key still resolves through the service.
    mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");

    render(<Host />);
    dispatchDead(document.body, { altKey: true });

    expect(mocks.keybindingService.clearPendingChord).not.toHaveBeenCalled();
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();

    // Now dispatch the second chord step — it should reach resolveKeybinding.
    mocks.keybindingService.resolveKeybinding.mockReturnValueOnce({
      match: { actionId: "test.chord" },
      chordPrefix: false,
      shouldConsume: true,
    });
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", metaKey: true, bubbles: true, cancelable: true })
      );
    });
    expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
  });
});

describe("useGlobalKeybindings — region focus key bypass (issue #7303)", () => {
  function dispatchKey(key: string, target: EventTarget) {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it("lets the rebound focusRegion.next key bypass the editable guard", () => {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) => {
      if (id === "nav.focusRegion.next") return "F7";
      if (id === "nav.focusRegion.prev") return "Shift+F7";
      return undefined;
    });
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "nav.focusRegion.next" },
      chordPrefix: false,
      shouldConsume: true,
    });

    const input = document.createElement("input");
    document.body.appendChild(input);

    try {
      render(<Host />);
      input.focus();
      dispatchKey("F7", input);

      expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
    } finally {
      input.remove();
    }
  });

  it("blocks F6 when the user has rebound focusRegion.next to F7", () => {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) => {
      if (id === "nav.focusRegion.next") return "F7";
      if (id === "nav.focusRegion.prev") return "Shift+F7";
      return undefined;
    });
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    const input = document.createElement("input");
    document.body.appendChild(input);

    try {
      render(<Host />);
      input.focus();
      dispatchKey("F6", input);

      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it("blocks F6 in an editable when both focus-region bindings are disabled", () => {
    // When the user disables the region-focus bindings entirely, F6 must not
    // get a hidden bypass — respect the disable.
    mocks.keybindingService.getEffectiveCombo.mockReturnValue(undefined);
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    const input = document.createElement("input");
    document.body.appendChild(input);

    try {
      render(<Host />);
      input.focus();
      dispatchKey("F6", input);

      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it("does not bypass the editable guard for bare F6 when focusRegion.next is rebound to Cmd+F6", () => {
    // Bypass should require a full combo match — bare F6 must not slip
    // through just because the rebind happens to use F6 with a modifier.
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) => {
      if (id === "nav.focusRegion.next") return "Cmd+F6";
      if (id === "nav.focusRegion.prev") return "Cmd+Shift+F6";
      return undefined;
    });
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    const input = document.createElement("input");
    document.body.appendChild(input);

    try {
      render(<Host />);
      input.focus();
      const event = new KeyboardEvent("keydown", {
        key: "F6",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        input.dispatchEvent(event);
      });

      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it("lets the rebound key bypass the xterm guard", () => {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) => {
      if (id === "nav.focusRegion.next") return "F7";
      if (id === "nav.focusRegion.prev") return "Shift+F7";
      return undefined;
    });
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "nav.focusRegion.next" },
      chordPrefix: false,
      shouldConsume: true,
    });

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    document.body.appendChild(xterm);

    try {
      render(<Host />);
      dispatchKey("F7", xterm);

      expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
    } finally {
      xterm.remove();
    }
  });

  it("does not let focus-region Tab rebinds steal xterm input", () => {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) => {
      if (id === "nav.focusRegion.next") return "Tab";
      if (id === "nav.focusRegion.prev") return "Shift+Tab";
      return undefined;
    });
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "nav.focusRegion.next" },
      chordPrefix: false,
      shouldConsume: true,
    });

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    document.body.appendChild(xterm);

    try {
      render(<Host />);

      const tabEvent = dispatchKey("Tab", xterm);
      expect(tabEvent.defaultPrevented).toBe(false);

      const shiftTabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        xterm.dispatchEvent(shiftTabEvent);
      });
      expect(shiftTabEvent.defaultPrevented).toBe(false);

      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
    } finally {
      xterm.remove();
    }
  });

  // Issue #9105 — bare-key focus-region rebinds (letters, punctuation) must not
  // steal terminal input. Only non-text keys (F-keys, arrows, etc.) may bypass
  // the xterm/editable bailouts as a focus-region escape.
  it("does not let a bare letter focus-region rebind steal xterm input", () => {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) => {
      if (id === "nav.focusRegion.next") return "q";
      if (id === "nav.focusRegion.prev") return "Shift+q";
      return undefined;
    });
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "nav.focusRegion.next" },
      chordPrefix: false,
      shouldConsume: true,
    });

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    document.body.appendChild(xterm);

    try {
      render(<Host />);
      const event = dispatchKey("q", xterm);

      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      xterm.remove();
    }
  });

  it("does not let a bare punctuation focus-region rebind steal xterm input", () => {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) => {
      if (id === "nav.focusRegion.next") return "[";
      if (id === "nav.focusRegion.prev") return "Shift+[";
      return undefined;
    });
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "nav.focusRegion.next" },
      chordPrefix: false,
      shouldConsume: true,
    });

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    document.body.appendChild(xterm);

    try {
      render(<Host />);
      const event = dispatchKey("[", xterm);

      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      xterm.remove();
    }
  });

  it("does not let a bare letter focus-region rebind bypass the editable guard", () => {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) => {
      if (id === "nav.focusRegion.next") return "q";
      if (id === "nav.focusRegion.prev") return "Shift+q";
      return undefined;
    });
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "nav.focusRegion.next" },
      chordPrefix: false,
      shouldConsume: true,
    });

    const input = document.createElement("input");
    document.body.appendChild(input);

    try {
      render(<Host />);
      input.focus();
      const event = dispatchKey("q", input);

      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      input.remove();
    }
  });
});

describe("useGlobalKeybindings — IME composition guard", () => {
  function dispatchComposing(
    init: KeyboardEventInit = {},
    overrides: { isComposing?: boolean; keyCode?: number } = {}
  ) {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...init,
    });
    if (overrides.isComposing !== undefined) {
      Object.defineProperty(event, "isComposing", {
        value: overrides.isComposing,
        configurable: true,
      });
    }
    if (overrides.keyCode !== undefined) {
      Object.defineProperty(event, "keyCode", {
        value: overrides.keyCode,
        configurable: true,
      });
    }
    act(() => {
      document.body.dispatchEvent(event);
    });
    return event;
  }

  it("does not resolve or dispatch when isComposing is true", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "panel.cycleNext" },
      chordPrefix: false,
      shouldConsume: true,
    });

    render(<Host />);
    const event = dispatchComposing({ key: "Enter" }, { isComposing: true });

    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    // Positive control — confirm the handler is actually installed by dispatching
    // a normal Cmd+W next, which must reach resolveKeybinding.
    pressCmdW();
    expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
  });

  it("does not resolve or dispatch when keyCode is 229 (Chromium Process key)", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    render(<Host />);
    const event = dispatchComposing({ key: "Process" }, { keyCode: 229 });

    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not mutate a pending chord when an IME commit Enter arrives", () => {
    mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");

    render(<Host />);
    const event = dispatchComposing({ key: "Enter" }, { isComposing: true });

    expect(mocks.keybindingService.popPendingChord).not.toHaveBeenCalled();
    expect(mocks.keybindingService.clearPendingChord).not.toHaveBeenCalled();
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
