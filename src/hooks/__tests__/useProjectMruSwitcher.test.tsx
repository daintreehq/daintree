// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { peekMock, notifyMock } = vi.hoisted(() => ({
  peekMock: vi.fn().mockResolvedValue(null),
  notifyMock: vi.fn().mockReturnValue(""),
}));

const { actionDispatchMock, keybindingServiceMock } = vi.hoisted(() => {
  const actionDispatchMock = vi.fn(async () => ({ ok: true, result: undefined }));
  const keybindingServiceMock = {
    resolveKeybinding: vi.fn(() => ({
      match: { actionId: "project.mruCycleOlder" },
      chordPrefix: false,
      shouldConsume: true,
    })),
    getPendingChord: vi.fn<() => string | null>(() => null),
    clearPendingChord: vi.fn(),
    popPendingChord: vi.fn(),
    getEffectiveCombo: vi.fn<() => string | undefined>(() => undefined),
    matchesEvent: vi.fn(() => false),
    subscribe: vi.fn(() => () => {}),
    setWhenContextProvider: vi.fn(),
  };
  return { actionDispatchMock, keybindingServiceMock };
});

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

// The nav module reads the project store to pick switch-vs-reopen; this suite
// only cares that the keyboard reaches it.
vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      currentProject: { id: "current" },
      projects: [],
      switchProject: vi.fn().mockResolvedValue(undefined),
      reopenProject: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: actionDispatchMock },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: keybindingServiceMock,
  normalizeKeyForBinding: (event: KeyboardEvent) => {
    if (event.code === "Equal" || event.code === "NumpadAdd") return "=";
    if (event.code === "Minus" || event.code === "NumpadSubtract") return "-";
    return event.key;
  },
}));

vi.mock("../../store", () => ({
  usePanelStore: { getState: () => ({ focusedId: null }) },
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

// The when-context builder reads real Zustand stores; this suite only needs
// the provider registration to succeed.
vi.mock("@/services/keybindingWhenContext", () => ({
  buildKeybindingWhenContext: vi.fn(() => ({})),
}));

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { useProjectMruSwitcher } from "../useProjectMruSwitcher";
import { useGlobalKeybindings } from "../useGlobalKeybindings";

function keyDown(
  code: "Minus" | "Equal" | "NumpadAdd" | "NumpadSubtract",
  opts: {
    repeat?: boolean;
    isComposing?: boolean;
    target?: Element | null;
    shiftKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
  } = {}
) {
  const key = code === "Minus" || code === "NumpadSubtract" ? "-" : opts.shiftKey ? "+" : "=";
  const event = new KeyboardEvent("keydown", {
    key,
    code,
    metaKey: opts.metaKey ?? true,
    altKey: opts.altKey ?? true,
    shiftKey: opts.shiftKey ?? false,
    repeat: opts.repeat ?? false,
    isComposing: opts.isComposing ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (opts.target) {
    Object.defineProperty(event, "target", { value: opts.target, writable: false });
  }
  window.dispatchEvent(event);
  return event;
}

function AppLikeKeybindingHost() {
  useProjectMruSwitcher();
  useGlobalKeybindings(true);
  return null;
}

/**
 * Which project a step lands on belongs to the history service
 * (`ProjectHistoryService.test.ts`). This suite owns the keyboard contract: the
 * shortcut has to survive being pressed inside a terminal, stay out of the way
 * while the user is typing, and consume its event so nothing dispatches twice.
 */
describe("useProjectMruSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    peekMock.mockResolvedValue(null);
    (window as unknown as { electron: unknown }).electron = {
      projectHistory: { peek: peekMock },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves Cmd+Alt+- free", () => {
    renderHook(() => useProjectMruSwitcher());

    let event: KeyboardEvent | undefined;
    act(() => {
      event = keyDown("Minus");
    });

    expect(event?.defaultPrevented).toBe(false);
    expect(peekMock).not.toHaveBeenCalled();
  });

  it("switches on Cmd+Alt+=", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal");
    });

    expect(peekMock).toHaveBeenCalledTimes(1);
  });

  it("leaves Cmd+Shift+Alt+= free", () => {
    renderHook(() => useProjectMruSwitcher());

    let event: KeyboardEvent | undefined;
    act(() => {
      event = keyDown("Equal", { shiftKey: true });
    });

    // A toggle has no inverse, so the shifted combo must fall through rather
    // than being swallowed by a handler with nothing left to do.
    expect(event?.defaultPrevented).toBe(false);
    expect(peekMock).not.toHaveBeenCalled();
  });

  it("accepts numpad add and leaves numpad subtract free", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("NumpadAdd");
    });
    expect(peekMock).toHaveBeenCalledTimes(1);

    peekMock.mockClear();
    let event: KeyboardEvent | undefined;
    act(() => {
      event = keyDown("NumpadSubtract");
    });
    expect(event?.defaultPrevented).toBe(false);
    expect(peekMock).not.toHaveBeenCalled();
  });

  it("consumes auto-repeat without stepping again", () => {
    renderHook(() => useProjectMruSwitcher());

    let event: KeyboardEvent | undefined;
    act(() => {
      event = keyDown("Equal", { repeat: true });
    });

    // Holding the keys down must not machine-gun through repeated switches, but
    // the event is still swallowed so nothing else acts on it.
    expect(event?.defaultPrevented).toBe(true);
    expect(peekMock).not.toHaveBeenCalled();
  });

  it("ignores an IME composition keydown", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal", { isComposing: true });
    });

    expect(peekMock).not.toHaveBeenCalled();
  });

  it("stays out of the way while typing in an input", () => {
    renderHook(() => useProjectMruSwitcher());
    const input = document.createElement("input");
    document.body.appendChild(input);

    let event: KeyboardEvent | undefined;
    act(() => {
      event = keyDown("Equal", { target: input });
    });

    expect(peekMock).not.toHaveBeenCalled();
    expect(event?.defaultPrevented).toBe(false);
    input.remove();
  });

  it("fires inside a terminal", () => {
    renderHook(() => useProjectMruSwitcher());
    const term = document.createElement("div");
    term.className = "xterm";
    const child = document.createElement("div");
    term.appendChild(child);
    document.body.appendChild(term);

    act(() => {
      keyDown("Equal", { target: child });
    });

    // Terminals are where this shortcut is most useful, so the editable-target
    // guard must not treat xterm's DOM as a text field.
    expect(peekMock).toHaveBeenCalledTimes(1);
    term.remove();
  });

  it("fires inside the xterm helper textarea", () => {
    renderHook(() => useProjectMruSwitcher());
    const term = document.createElement("div");
    term.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    term.appendChild(helper);
    document.body.appendChild(term);

    act(() => {
      keyDown("Equal", { target: helper });
    });

    expect(peekMock).toHaveBeenCalledTimes(1);
    term.remove();
  });

  it("surfaces a failed switch with a retry", async () => {
    peekMock.mockRejectedValueOnce(new Error("switch failed"));
    renderHook(() => useProjectMruSwitcher());

    await act(async () => {
      keyDown("Equal");
      await Promise.resolve();
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const call = notifyMock.mock.calls[0]![0] as { type: string; title: string };
    expect(call.type).toBe("error");
    expect(call.title).toBe("Couldn't switch project");
  });

  it("calls preventDefault and stopPropagation on handled keydowns", () => {
    renderHook(() => useProjectMruSwitcher());

    const event = new KeyboardEvent("keydown", {
      key: "=",
      code: "Equal",
      metaKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");
    const stopPropagation = vi.spyOn(event, "stopPropagation");
    const stopImmediatePropagation = vi.spyOn(event, "stopImmediatePropagation");

    act(() => {
      window.dispatchEvent(event);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(stopImmediatePropagation).toHaveBeenCalled();
  });

  it("blocks the generic keybinding fallback in the app-like hook order", () => {
    render(<AppLikeKeybindingHost />);

    act(() => {
      keyDown("Equal");
    });

    // The capture-phase listener runs first and stops propagation, so the
    // registered action must not also fire and step twice.
    expect(peekMock).toHaveBeenCalledTimes(1);
    expect(keybindingServiceMock.resolveKeybinding).not.toHaveBeenCalled();
    expect(actionDispatchMock).not.toHaveBeenCalled();
  });

  it("ignores keydowns without both modifiers", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal", { metaKey: false });
      keyDown("Equal", { altKey: false });
    });

    expect(peekMock).not.toHaveBeenCalled();
  });
});
