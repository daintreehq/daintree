// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests, registerEscape } from "@/lib/escapeStack";
import { ESCAPE_BACKSTOP_DIALOG_ATTR } from "@/lib/dialogEscapeBackstop";
import { APP_MODAL_SELECTOR } from "@/lib/appModal";
import { PANE_DIALOG_ATTR } from "@/lib/paneDialog";
import { claimVoiceWaitKeys } from "@/lib/voiceWaitKeys";
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
  panelState: { focusedId: null as string | null },
  keybindingService: {
    resolveKeybinding: vi.fn(),
    getPendingChord: vi.fn<() => string | null>(() => null),
    clearPendingChord: vi.fn(),
    popPendingChord: vi.fn(),
    getEffectiveCombo: vi.fn<(actionId: string) => string | undefined>(() => undefined),
    // By default every action fires on just its effective combo; tests that
    // need a second binding (Windows' Ctrl+F4) set their own.
    getTriggerCombos: vi.fn<(actionId: string) => string[]>(() => []),
    getChordCompletions: vi.fn<
      () => Array<{ actionId: string; secondKey: string; description: string }>
    >(() => []),
    subscribe: vi.fn(() => () => {}),
    setWhenContextProvider: vi.fn(),
    isCapturingShortcut: vi.fn<() => boolean>(() => false),
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
    get: vi.fn<(actionId: string) => { enabled: boolean; disabledReason?: string } | null>(
      () => null
    ),
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
  // Lite, mac-style field comparison — sufficient for the single-combo prefix
  // check (`Cmd+K`) the command-HUD routing performs.
  combosFieldsEqual: (a: string, b: string) => {
    const sa = a.trim().split(/\s+/).filter(Boolean);
    const sb = b.trim().split(/\s+/).filter(Boolean);
    if (sa.length === 0 || sa.length !== sb.length) return false;
    return sa.every((seg, i) => {
      const pa = parseComboLite(seg);
      const pb = parseComboLite(sb[i]!);
      return (
        pa.cmd === pb.cmd &&
        pa.ctrl === pb.ctrl &&
        pa.shift === pb.shift &&
        pa.alt === pb.alt &&
        pa.key.toLowerCase() === pb.key.toLowerCase()
      );
    });
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: mocks.actionService,
}));

vi.mock("../../store", () => ({
  usePanelStore: { getState: () => ({ focusedId: mocks.panelState.focusedId }) },
  usePaletteStore: {
    getState: vi.fn(() => ({ activePaletteId: null })),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

// The when-context builder reads real Zustand stores; the hook only needs the
// provider registration to be observable here.
vi.mock("@/services/keybindingWhenContext", () => ({
  buildKeybindingWhenContext: vi.fn(() => ({})),
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

// Pins what each action is bound to right now, the way an override or an
// imported profile would: every combo listed, none for an action left out.
function bindTriggers(bindings: Record<string, string[]>) {
  mocks.keybindingService.getTriggerCombos.mockImplementation(
    (actionId: string) => bindings[actionId] ?? []
  );
  mocks.keybindingService.getEffectiveCombo.mockImplementation(
    (actionId: string) => bindings[actionId]?.[0]
  );
}

beforeEach(() => {
  _resetForTests();
  vi.clearAllMocks();
  mocks.panelState.focusedId = null;
  mocks.keybindingService.getPendingChord.mockReturnValue(null);
  mocks.keybindingService.isCapturingShortcut.mockReturnValue(false);
  mocks.keybindingService.getTriggerCombos.mockImplementation((actionId: string) => {
    const combo = mocks.keybindingService.getEffectiveCombo(actionId);
    return combo ? [combo] : [];
  });
  mocks.actionService.dispatch.mockResolvedValue({ ok: true, result: undefined });
  vi.mocked(usePaletteStore.getState).mockReturnValue(makePaletteState(null));
});

describe("useGlobalKeybindings — shortcut recorder owns the keyboard", () => {
  it("does not run the action a keystroke is bound to while a recorder is capturing it", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "terminal.close" },
      chordPrefix: false,
      shouldConsume: true,
    });
    mocks.keybindingService.isCapturingShortcut.mockReturnValue(true);

    render(<Host />);
    pressCmdW();

    expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
  });
});

describe("useGlobalKeybindings — isolated surfaces", () => {
  function pressIn(target: HTMLElement, init: KeyboardEventInit) {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    );
  }

  it("keeps pane and fleet shortcuts away from a terminal typed to outside the grid", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "fleet.armFocused" },
      chordPrefix: false,
      shouldConsume: true,
    });
    render(<Host />);
    const surface = document.createElement("div");
    surface.setAttribute("data-keybindings-isolated", "");
    surface.innerHTML = '<div class="xterm"><textarea></textarea></div>';
    document.body.appendChild(surface);
    try {
      pressIn(surface.querySelector("textarea")!, { key: "j", metaKey: true });
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
    } finally {
      surface.remove();
    }
  });

  it("still lets the surface's own toggle through", () => {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) =>
      id === "canopy.toggle" ? "Cmd+Shift+O" : undefined
    );
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "canopy.toggle" },
      chordPrefix: false,
      shouldConsume: true,
    });
    render(<Host />);
    const surface = document.createElement("div");
    surface.setAttribute("data-keybindings-isolated", "");
    const field = document.createElement("textarea");
    surface.appendChild(field);
    document.body.appendChild(surface);
    try {
      pressIn(field, { key: "o", code: "KeyO", metaKey: true, shiftKey: true });
      expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalled();
    } finally {
      surface.remove();
    }
  });

  function pressDictationIn(
    ownsDictation: boolean,
    html: string,
    key: { actionId: string; combo: string; event: KeyboardEventInit } = {
      actionId: "voiceInput.toggle",
      combo: "Cmd+D",
      event: { key: "d", code: "KeyD", metaKey: true },
    }
  ) {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) =>
      id === key.actionId ? key.combo : undefined
    );
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: key.actionId },
      chordPrefix: false,
      shouldConsume: true,
    });
    render(<Host />);
    const owner = document.createElement("section");
    if (ownsDictation) owner.setAttribute("data-dictation-owner", "");
    const surface = document.createElement("div");
    surface.setAttribute("data-keybindings-isolated", "");
    surface.innerHTML = html;
    owner.appendChild(surface);
    document.body.appendChild(owner);
    try {
      pressIn(surface.querySelector("textarea")!, key.event);
    } finally {
      owner.remove();
    }
  }

  it.each([
    ["its live terminal", '<div class="xterm"><textarea></textarea></div>'],
    ["its reply", '<div class="cm-editor"><textarea></textarea></div>'],
  ])("lets the dictation key through from %s, for Canopy to route", (_where, html) => {
    pressDictationIn(true, html);
    expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
      "voiceInput.toggle",
      undefined,
      expect.anything()
    );
  });

  // #14920: stopping with a send is a dictation key too.
  it("lets stop-and-send through from a reply that owns its dictation", () => {
    pressDictationIn(true, '<div class="cm-editor"><textarea></textarea></div>', {
      actionId: "voiceInput.stopAndSend",
      combo: "Cmd+Alt+D",
      event: { key: "d", code: "KeyD", metaKey: true, altKey: true },
    });
    expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
      "voiceInput.stopAndSend",
      undefined,
      expect.anything()
    );
  });

  it("keeps the dictation key out of an isolated surface that doesn't route it", () => {
    pressDictationIn(false, '<div class="cm-editor"><textarea></textarea></div>');
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
  });
});

describe("useGlobalKeybindings — Cmd+W in a surface that owns its close", () => {
  function closeOwner(isolated: boolean) {
    const owner = document.createElement("section");
    owner.setAttribute("data-close-owner", "");
    const field = document.createElement("textarea");
    if (isolated) {
      const pane = document.createElement("div");
      pane.setAttribute("data-keybindings-isolated", "");
      pane.appendChild(field);
      owner.appendChild(pane);
    } else {
      owner.appendChild(field);
    }
    document.body.appendChild(owner);
    const requests = vi.fn((event: Event) => event.preventDefault());
    owner.addEventListener("daintree:close-request", requests);
    return { owner, field, requests };
  }

  beforeEach(() => {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) =>
      id === "terminal.close" ? "Cmd+W" : undefined
    );
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "terminal.close" },
      chordPrefix: false,
      shouldConsume: true,
    });
  });

  it.each([
    ["its isolated terminal or reply", true],
    ["its own controls", false],
  ])(
    "hands Cmd+W from %s to the surface, and leaves the dialog around it open",
    (_where, isolated) => {
      const escapeHandler = vi.fn();
      registerEscape(escapeHandler);
      render(<Host />);
      const { owner, field, requests } = closeOwner(isolated);
      try {
        field.focus();
        act(() => {
          field.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "w",
              metaKey: true,
              bubbles: true,
              cancelable: true,
            })
          );
        });
        expect(requests).toHaveBeenCalledTimes(1);
        expect(escapeHandler).not.toHaveBeenCalled();
        expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
      } finally {
        owner.remove();
      }
    }
  );

  it("lets a second close binding in too, such as Windows' Ctrl+F4", () => {
    mocks.keybindingService.getTriggerCombos.mockImplementation((id: string) =>
      id === "terminal.close" ? ["Cmd+W", "Ctrl+F4"] : []
    );
    render(<Host />);
    const { owner, field, requests } = closeOwner(true);
    try {
      field.focus();
      act(() => {
        field.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "F4",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
      });
      expect(requests).toHaveBeenCalledTimes(1);
    } finally {
      owner.remove();
    }
  });

  it("lets in only the allowed actions, even when another action shares their keys", () => {
    // A plugin's binding on the same keys as the toggle resolves instead.
    mocks.keybindingService.getTriggerCombos.mockImplementation((id: string) =>
      id === "canopy.toggle" ? ["Cmd+Shift+O"] : []
    );
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "plugin.something" },
      chordPrefix: false,
      shouldConsume: true,
    });
    render(<Host />);
    const { owner, field } = closeOwner(true);
    try {
      field.focus();
      const event = new KeyboardEvent("keydown", {
        key: "o",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        field.dispatchEvent(event);
      });
      expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
      // Left for the terminal or composer, not swallowed.
      expect(event.defaultPrevented).toBe(false);
    } finally {
      owner.remove();
    }
  });

  it("abandons a chord begun outside, so the surface's own close still works", () => {
    mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");
    render(<Host />);
    const { owner, field, requests } = closeOwner(true);
    try {
      field.focus();
      act(() => {
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true, cancelable: true })
        );
      });
      expect(mocks.keybindingService.clearPendingChord).toHaveBeenCalled();
      // Cleared before the key is resolved, so it resolves standalone.
      expect(mocks.keybindingService.clearPendingChord.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.keybindingService.resolveKeybinding.mock.invocationCallOrder[0]!
      );
      expect(requests).toHaveBeenCalledTimes(1);
    } finally {
      owner.remove();
    }
  });

  it("never opens the grid pane's menu from inside the isolated surface", () => {
    // Close rebound to Shift+F10 while the panel menu still holds it too,
    // pressed on a control in the pane (a text field keeps unmodified keys for
    // itself, by the editable rule). A panel is focused, so the menu route
    // would dispatch if the isolated surface didn't keep it out.
    mocks.panelState.focusedId = "panel-1";
    bindTriggers({
      "terminal.close": ["Shift+F10"],
      "terminal.contextMenu": ["Shift+F10"],
    });
    render(<Host />);
    const owner = document.createElement("section");
    owner.setAttribute("data-close-owner", "");
    const pane = document.createElement("div");
    pane.setAttribute("data-keybindings-isolated", "");
    const control = document.createElement("div");
    control.tabIndex = 0;
    pane.appendChild(control);
    owner.appendChild(pane);
    document.body.appendChild(owner);
    const requests = vi.fn((event: Event) => event.preventDefault());
    owner.addEventListener("daintree:close-request", requests);
    try {
      control.focus();
      act(() => {
        control.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "F10",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
      });
      expect(requests).toHaveBeenCalledTimes(1);
      expect(mocks.actionService.dispatch).not.toHaveBeenCalledWith(
        "terminal.contextMenu",
        expect.anything(),
        expect.anything()
      );
    } finally {
      owner.remove();
    }
  });

  it("lets no chord-bound close into the isolated surface, whose other keys stay its own", () => {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((id: string) =>
      id === "terminal.close" ? "Cmd+K W" : undefined
    );
    render(<Host />);
    const { owner, field, requests } = closeOwner(true);
    try {
      act(() => {
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true })
        );
      });
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(requests).not.toHaveBeenCalled();
    } finally {
      owner.remove();
    }
  });

  it("keeps every other shortcut away from the isolated surface", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "fleet.armFocused" },
      chordPrefix: false,
      shouldConsume: true,
    });
    render(<Host />);
    const { owner, field, requests } = closeOwner(true);
    try {
      act(() => {
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true, cancelable: true })
        );
      });
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(requests).not.toHaveBeenCalled();
    } finally {
      owner.remove();
    }
  });
});

describe("useGlobalKeybindings — Cmd+W escape stack guard", () => {
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

  it("lets an open palette own Escape while retiring its stale pending chord", () => {
    vi.mocked(usePaletteStore.getState).mockReturnValue(makePaletteState("theme"));
    mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");

    const escapeHandler = vi.fn();
    registerEscape(escapeHandler);

    render(<Host />);
    const event = dispatchEscape();

    expect(mocks.keybindingService.clearPendingChord).toHaveBeenCalledTimes(1);
    expect(escapeHandler).toHaveBeenCalledTimes(1);
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("only cancels a pending chord when no modal surface has taken ownership", () => {
    mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");

    const escapeHandler = vi.fn();
    registerEscape(escapeHandler);

    render(<Host />);
    const event = dispatchEscape();

    expect(mocks.keybindingService.clearPendingChord).toHaveBeenCalledTimes(1);
    expect(escapeHandler).not.toHaveBeenCalled();
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
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

  it("routes bare Escape before the xterm guard when a destructive alertdialog is visible", () => {
    vi.mocked(usePaletteStore.getState).mockReturnValue(makePaletteState(null));
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
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

  it("leaves Escape for a modal's registered dialog backstop", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute(ESCAPE_BACKSTOP_DIALOG_ATTR, "");
    document.body.appendChild(dialog);

    try {
      const escapeHandler = vi.fn();
      registerEscape(escapeHandler);

      render(<Host />);
      const event = dispatchEscape(dialog);

      expect(escapeHandler).not.toHaveBeenCalled();
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
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

  // A page's dialog blocks only its own pane (#15037). Escape inside it answers
  // the page; Escape anywhere else does what it would without the dialog.
  describe("with a page dialog open over one pane", () => {
    let dialog: HTMLElement;

    beforeEach(() => {
      mocks.keybindingService.resolveKeybinding.mockReturnValue({
        match: undefined,
        chordPrefix: false,
        shouldConsume: false,
      });
      dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute(PANE_DIALOG_ATTR, "");
      dialog.innerHTML = "<button>Cancel</button>";
      document.body.appendChild(dialog);
    });

    afterEach(() => {
      dialog.remove();
    });

    it("leaves Escape inside it to the dialog, not the escape stack", () => {
      const escapeHandler = vi.fn();
      registerEscape(escapeHandler);

      render(<Host />);
      const event = dispatchEscape(dialog.querySelector("button")!);

      expect(escapeHandler).not.toHaveBeenCalled();
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it("clears a pending chord on Escape inside it, but leaves the key to the dialog", () => {
      mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");

      render(<Host />);
      const event = dispatchEscape(dialog.querySelector("button")!);

      expect(mocks.keybindingService.clearPendingChord).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(false);
    });

    it("still runs the escape stack for Escape on a control outside it", () => {
      const outside = document.createElement("button");
      document.body.appendChild(outside);

      try {
        const escapeHandler = vi.fn();
        registerEscape(escapeHandler);

        render(<Host />);
        const event = dispatchEscape(outside);

        expect(escapeHandler).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
      } finally {
        outside.remove();
      }
    });

    it("leaves bare Escape in a terminal beside it to the terminal", () => {
      const xterm = document.createElement("div");
      xterm.className = "xterm";
      document.body.appendChild(xterm);

      try {
        const escapeHandler = vi.fn();
        registerEscape(escapeHandler);

        render(<Host />);
        const event = dispatchEscape(xterm);

        expect(escapeHandler).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
      } finally {
        xterm.remove();
      }
    });
  });
});

describe("useGlobalKeybindings — a dictated send waiting on its cleanup (#14780)", () => {
  it("leaves Escape at the page to the waiting send, not the escape stack", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });
    const escapeHandler = vi.fn();
    registerEscape(escapeHandler);
    // Mounted before the claim, as at app start, so its listener hears the key first.
    render(<Host />);
    const cancel = vi.fn();
    const release = claimVoiceWaitKeys({
      holds: () => false,
      editor: () => null,
      isSelected: () => false,
      sendNow: vi.fn(),
      cancel,
    });

    try {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      });

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(escapeHandler).not.toHaveBeenCalled();
    } finally {
      release();
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

  describe("with Cmd held on macOS", () => {
    function setNavigatorPlatform(platform: string) {
      Object.defineProperty(globalThis, "navigator", {
        value: { platform },
        configurable: true,
        writable: true,
      });
    }

    const originalNavigator = globalThis.navigator;
    afterEach(() => {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    });

    // Chromium ignores Command when it detects a dead key, so Cmd+Alt+U (¨ on
    // a US layout) reaches the page as "Dead" although nothing composes.
    it("resolves Cmd+Alt+(dead U) as a shortcut", () => {
      setNavigatorPlatform("MacIntel");
      mocks.keybindingService.getPendingChord.mockReturnValue(null);
      mocks.keybindingService.resolveKeybinding.mockReturnValueOnce({
        match: { actionId: "host.switch" },
        chordPrefix: false,
        shouldConsume: true,
      });

      render(<Host />);
      const event = dispatchDead(document.body, { code: "KeyU", metaKey: true, altKey: true });

      expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it("still ignores a Meta-held dead key off macOS", () => {
      setNavigatorPlatform("Linux x86_64");
      mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");

      render(<Host />);
      dispatchDead(document.body, { code: "KeyU", metaKey: true, altKey: true });

      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(mocks.keybindingService.clearPendingChord).not.toHaveBeenCalled();
    });
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

  // An override can hold several combos (an imported profile, or an agent
  // calling keybinding.setOverride), and every one of them is live.
  describe.each<[string, () => HTMLElement]>([
    ["a text input", () => document.createElement("input")],
    [
      "a contenteditable",
      () => {
        const el = document.createElement("div");
        // jsdom doesn't implement isContentEditable.
        Object.defineProperty(el, "isContentEditable", { value: true });
        return el;
      },
    ],
    [
      "a terminal",
      () => {
        const el = document.createElement("div");
        el.className = "xterm";
        return el;
      },
    ],
  ])("with several combos bound, from %s", (_label, makeSurface) => {
    let surface: HTMLElement;

    function press(init: KeyboardEventInit): KeyboardEvent {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      act(() => {
        surface.dispatchEvent(event);
      });
      return event;
    }

    beforeEach(() => {
      surface = makeSurface();
      document.body.appendChild(surface);
    });

    afterEach(() => {
      surface.remove();
      mocks.keybindingService.resolveKeybinding.mockReset();
    });

    it("lets a later combo of focusRegion.next escape, not only the first", () => {
      bindTriggers({
        "nav.focusRegion.next": ["F6", "F7"],
        "nav.focusRegion.prev": ["Shift+F6"],
      });
      mocks.keybindingService.resolveKeybinding.mockReturnValue({
        match: { actionId: "nav.focusRegion.next" },
        chordPrefix: false,
        shouldConsume: true,
      });
      render(<Host />);

      const event = press({ key: "F7" });

      expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
      expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
        "nav.focusRegion.next",
        undefined,
        expect.anything()
      );
      expect(event.defaultPrevented).toBe(true);
    });

    it("lets a later combo of focusRegion.prev escape, not only the first", () => {
      bindTriggers({
        "nav.focusRegion.next": ["F6"],
        "nav.focusRegion.prev": ["Shift+F6", "Shift+F7"],
      });
      mocks.keybindingService.resolveKeybinding.mockReturnValue({
        match: { actionId: "nav.focusRegion.prev" },
        chordPrefix: false,
        shouldConsume: true,
      });
      render(<Host />);

      const event = press({ key: "F7", shiftKey: true });

      expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
      expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
        "nav.focusRegion.prev",
        undefined,
        expect.anything()
      );
      expect(event.defaultPrevented).toBe(true);
    });

    it("keeps a printable combo as ordinary typing while the others still escape", () => {
      bindTriggers({ "nav.focusRegion.next": ["F6", "q"], "nav.focusRegion.prev": [] });
      mocks.keybindingService.resolveKeybinding.mockReturnValue({
        match: { actionId: "nav.focusRegion.next" },
        chordPrefix: false,
        shouldConsume: true,
      });
      render(<Host />);

      const typed = press({ key: "q" });

      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
      expect(typed.defaultPrevented).toBe(false);

      press({ key: "F6" });

      expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
    });

    it("does not let the bare key through when a later combo needs a modifier", () => {
      bindTriggers({ "nav.focusRegion.next": ["F6", "Cmd+F7"], "nav.focusRegion.prev": [] });
      mocks.keybindingService.resolveKeybinding.mockReturnValue({
        match: undefined,
        chordPrefix: false,
        shouldConsume: false,
      });
      render(<Host />);

      press({ key: "F7" });

      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    });
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

describe("useGlobalKeybindings — terminal-reserved keys", () => {
  function setNavigatorPlatform(platform: string) {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform },
      configurable: true,
      writable: true,
    });
  }

  function pressInTerminal(init: KeyboardEventInit) {
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const inner = document.createElement("div");
    xterm.appendChild(inner);
    document.body.appendChild(xterm);
    act(() => {
      inner.dispatchEvent(
        new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true })
      );
    });
    xterm.remove();
  }

  afterEach(() => {
    setNavigatorPlatform("MacIntel");
  });

  it("never resolves readline Ctrl keys as shortcuts while a terminal is focused", () => {
    // On Windows/Linux, Ctrl+W would otherwise resolve as Cmd+W → terminal.close
    // before xterm's allowlist ever ran — closing the panel instead of
    // deleting a word.
    render(<Host />);
    pressInTerminal({ key: "w", ctrlKey: true });
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
  });

  it("reserves the Windows/Linux terminal clipboard keys before global resolution", () => {
    setNavigatorPlatform("Win32");
    render(<Host />);
    pressInTerminal({ key: "C", ctrlKey: true, shiftKey: true });
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
  });

  it("still resolves non-reserved modifier shortcuts inside terminals", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });
    render(<Host />);
    pressInTerminal({ key: "P", ctrlKey: true, shiftKey: true });
    expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
  });

  it("lets a pending chord win over the reservation — the user explicitly opened it", () => {
    mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: true,
    });
    render(<Host />);
    pressInTerminal({ key: "w", ctrlKey: true });
    expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
  });

  it("resolves reserved keys normally outside terminals", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });
    render(<Host />);
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true })
      );
    });
    expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
  });
});

describe("useGlobalKeybindings — row-menu stand-down", () => {
  // The capture handler claims Shift+F10 / the ContextMenu key for the focused
  // panel's menu. Surfaces that own a row-level menu mark themselves
  // `data-row-menu` so the keypress reaches their own handler instead; an
  // already-open Radix menu is the second case, and it portals to
  // `document.body` where no such marker is in scope (#11757).
  function pressMenuKey(target: HTMLElement): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key: "F10",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function mount(html: string): HTMLElement {
    mocks.keybindingService.getEffectiveCombo.mockImplementation((actionId: string) =>
      actionId === "terminal.contextMenu" ? "Shift+F10" : undefined
    );
    render(<Host />);
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
  }

  afterEach(() => {
    document.querySelectorAll("body > div:not([id])").forEach((node) => node.remove());
  });

  it("claims the menu key on an ordinary target", () => {
    const host = mount(`<div id="plain"></div>`);
    // Consuming the event is the whole behaviour — the dispatch itself is gated
    // on a focused panel, which this harness deliberately has none of.
    expect(pressMenuKey(host.querySelector<HTMLElement>("#plain")!).defaultPrevented).toBe(true);
  });

  it("stands down inside a surface that owns its rows' menus", () => {
    const host = mount(`<div data-row-menu=""><div id="row"></div></div>`);
    expect(pressMenuKey(host.querySelector<HTMLElement>("#row")!).defaultPrevented).toBe(false);
  });

  it("never hands an owned menu key on to general resolution", () => {
    // The combos are `terminal.contextMenu`'s own default bindings, so the
    // resolver would consume them like any other shortcut — the stand-down has
    // to stop before it, not just skip the panel-menu branch.
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "terminal.contextMenu" },
      chordPrefix: false,
      shouldConsume: true,
    });
    const host = mount(`<div data-row-menu=""><div id="row"></div></div>`);

    expect(pressMenuKey(host.querySelector<HTMLElement>("#row")!).defaultPrevented).toBe(false);
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    mocks.keybindingService.resolveKeybinding.mockReset();
  });

  it("stands down inside an already-open menu, which portals outside every marker", () => {
    const host = mount(`<div role="menu"><div id="item" role="menuitem"></div></div>`);
    expect(pressMenuKey(host.querySelector<HTMLElement>("#item")!).defaultPrevented).toBe(false);
  });
});

describe("useGlobalKeybindings — panel menu keys follow the action's bindings", () => {
  const SHIFT_F10 = { key: "F10", shiftKey: true };
  const MENU_KEY = { key: "ContextMenu" };
  const NO_MATCH = { match: undefined, chordPrefix: false, shouldConsume: false };

  function press(init: KeyboardEventInit, target: HTMLElement = document.body): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function dispatchedActionIds(): string[] {
    return mocks.actionService.dispatch.mock.calls.map(([actionId]) => actionId);
  }

  beforeEach(() => {
    mocks.panelState.focusedId = "panel-1";
    mocks.keybindingService.resolveKeybinding.mockReturnValue(NO_MATCH);
  });

  afterEach(() => {
    mocks.keybindingService.resolveKeybinding.mockReset();
    document.querySelectorAll("body > div:not([id])").forEach((node) => node.remove());
  });

  it.each([
    ["Shift+F10", SHIFT_F10],
    ["ContextMenu", MENU_KEY],
  ])("opens the focused panel's menu on %s while it is bound", (_name, init) => {
    bindTriggers({ "terminal.contextMenu": ["Shift+F10", "ContextMenu"] });
    render(<Host />);

    const event = press(init);

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
      "terminal.contextMenu",
      { terminalId: "panel-1" },
      { source: "keybinding" }
    );
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
  });

  it("still reaches the panel's menu from a text field while the key is bound", () => {
    bindTriggers({ "terminal.contextMenu": ["Shift+F10", "ContextMenu"] });
    render(<Host />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      const event = press(SHIFT_F10, input);

      expect(event.defaultPrevented).toBe(true);
      expect(dispatchedActionIds()).toEqual(["terminal.contextMenu"]);
    } finally {
      input.remove();
    }
  });

  it("routes a key the user kept wherever it sits in the override, and only that key", () => {
    bindTriggers({ "terminal.contextMenu": ["F9", "ContextMenu"] });
    render(<Host />);

    expect(press(MENU_KEY).defaultPrevented).toBe(true);
    expect(dispatchedActionIds()).toEqual(["terminal.contextMenu"]);

    mocks.actionService.dispatch.mockClear();
    press(SHIFT_F10);
    expect(dispatchedActionIds()).toEqual([]);
    expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
  });

  describe("after the action is rebound to F9", () => {
    beforeEach(() => {
      bindTriggers({ "terminal.contextMenu": ["F9"] });
    });

    it.each([
      ["Shift+F10", SHIFT_F10],
      ["ContextMenu", MENU_KEY],
    ])("no longer opens the panel's menu on %s", (_name, init) => {
      render(<Host />);

      const event = press(init);

      expect(dispatchedActionIds()).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
      // Handed to ordinary resolution, which is where whatever else holds it runs.
      expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
    });

    it("opens it on F9, through ordinary resolution", () => {
      mocks.keybindingService.resolveKeybinding.mockReturnValue({
        match: { actionId: "terminal.contextMenu" },
        chordPrefix: false,
        shouldConsume: true,
      });
      render(<Host />);

      const event = press({ key: "F9" });

      expect(event.defaultPrevented).toBe(true);
      expect(mocks.actionService.dispatch).toHaveBeenCalledTimes(1);
      expect(mocks.actionService.dispatch).toHaveBeenCalledWith("terminal.contextMenu", undefined, {
        source: "keybinding",
      });
    });

    it.each([
      ["Shift+F10", SHIFT_F10],
      ["ContextMenu", MENU_KEY],
    ])("runs another action that now holds %s", (_name, init) => {
      mocks.keybindingService.resolveKeybinding.mockReturnValue({
        match: { actionId: "nav.toggleSidebar" },
        chordPrefix: false,
        shouldConsume: true,
      });
      render(<Host />);

      const event = press(init);

      expect(event.defaultPrevented).toBe(true);
      expect(dispatchedActionIds()).toEqual(["nav.toggleSidebar"]);
    });

    it("keeps Shift+F10 typing in a text field, as any unmodified key is", () => {
      render(<Host />);
      const input = document.createElement("input");
      document.body.appendChild(input);
      try {
        const event = press(SHIFT_F10, input);

        expect(event.defaultPrevented).toBe(false);
        expect(dispatchedActionIds()).toEqual([]);
        expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      } finally {
        input.remove();
      }
    });
  });

  // The stand-down follows the physical key, not the binding: a surface with
  // its own menu keeps both keys whatever the panel menu is bound to.
  describe.each<[string, string]>([
    ["a surface that owns its rows' menus", `<div data-row-menu=""><div id="target"></div></div>`],
    ["an already-open menu", `<div role="menu"><div id="target" role="menuitem"></div></div>`],
  ])("inside %s", (_owner, html) => {
    it.each<[string, KeyboardEventInit, string[]]>([
      ["Shift+F10", SHIFT_F10, ["Shift+F10", "ContextMenu"]],
      ["ContextMenu", MENU_KEY, ["Shift+F10", "ContextMenu"]],
      ["Shift+F10 after a rebind to F9", SHIFT_F10, ["F9"]],
      ["ContextMenu after a rebind to F9", MENU_KEY, ["F9"]],
    ])("leaves %s to its owner", (_key, init, combos) => {
      bindTriggers({ "terminal.contextMenu": combos });
      render(<Host />);
      const host = document.createElement("div");
      host.innerHTML = html;
      document.body.appendChild(host);

      const event = press(init, host.querySelector<HTMLElement>("#target")!);

      expect(event.defaultPrevented).toBe(false);
      expect(dispatchedActionIds()).toEqual([]);
      expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["Shift+F10", SHIFT_F10],
    ["ContextMenu", MENU_KEY],
  ])("treats an explicitly empty override as off for %s", (_name, init) => {
    bindTriggers({ "terminal.contextMenu": [] });
    render(<Host />);

    const event = press(init);

    expect(dispatchedActionIds()).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalledTimes(1);
  });
});

describe("command HUD direct completion", () => {
  beforeEach(() => {
    mocks.keybindingService.getPendingChord.mockReturnValue("Cmd+K");
    mocks.keybindingService.getChordCompletions.mockReturnValue([
      { actionId: "git.push", secondKey: "Cmd+P", description: "Push to remote" },
    ]);
  });

  afterEach(() => {
    mocks.keybindingService.getChordCompletions.mockReset().mockReturnValue([]);
    mocks.actionService.get.mockReset().mockReturnValue(null);
    mocks.keybindingService.resolveKeybinding.mockReset();
  });

  function pressCmdP(): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key: "p",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    return event;
  }

  it("keeps the chord open and skips dispatch when the completion is disabled", () => {
    mocks.actionService.get.mockReturnValue({
      enabled: false,
      disabledReason: "No upstream branch",
    });
    const blocked = vi.fn();
    window.addEventListener("daintree:command-hud-blocked", blocked);
    render(<Host />);

    const event = pressCmdP();
    window.removeEventListener("daintree:command-hud-blocked", blocked);
    expect(blocked).toHaveBeenCalledTimes(1);

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.keybindingService.resolveKeybinding).not.toHaveBeenCalled();
    expect(mocks.keybindingService.clearPendingChord).not.toHaveBeenCalled();
    expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
  });

  it("completes an enabled command through the normal resolution path", () => {
    mocks.actionService.get.mockReturnValue({ enabled: true });
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: { actionId: "git.push" },
      chordPrefix: false,
      shouldConsume: true,
    });
    render(<Host />);

    pressCmdP();

    expect(mocks.keybindingService.resolveKeybinding).toHaveBeenCalled();
    expect(mocks.actionService.dispatch).toHaveBeenCalledWith(
      "git.push",
      undefined,
      expect.anything()
    );
  });
});

describe("useGlobalKeybindings — per-keystroke document scans", () => {
  it("only scans the document for modal dialogs when the key is Escape", () => {
    mocks.keybindingService.resolveKeybinding.mockReturnValue({
      match: undefined,
      chordPrefix: false,
      shouldConsume: false,
    });
    render(<Host />);
    const querySelector = vi.spyOn(document, "querySelector");
    try {
      const xterm = document.createElement("div");
      xterm.className = "xterm";
      document.body.appendChild(xterm);
      act(() => {
        for (const init of [{ key: "a" }, { key: "Enter" }, { key: "k", metaKey: true }]) {
          xterm.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
        }
      });
      expect(querySelector).not.toHaveBeenCalled();

      act(() => {
        xterm.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(querySelector).toHaveBeenCalledWith(APP_MODAL_SELECTOR);
      expect(querySelector).toHaveBeenCalledWith(`[${ESCAPE_BACKSTOP_DIALOG_ATTR}]`);
      xterm.remove();
    } finally {
      querySelector.mockRestore();
    }
  });
});
