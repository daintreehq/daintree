// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { switchProjectMock, reopenProjectMock, notifyMock, projectState, useProjectStoreMock } =
  vi.hoisted(() => {
    const switchProjectMock = vi.fn().mockResolvedValue(undefined);
    const reopenProjectMock = vi.fn().mockResolvedValue(undefined);
    const notifyMock = vi.fn().mockReturnValue("");

    const projectState = {
      projects: [
        { id: "p-current", path: "/p-current", name: "Current", emoji: "tree", lastOpened: 500 },
        { id: "p-recent", path: "/p-recent", name: "Recent", emoji: "apple", lastOpened: 400 },
        { id: "p-older", path: "/p-older", name: "Older", emoji: "carrot", lastOpened: 300 },
        { id: "p-oldest", path: "/p-oldest", name: "Oldest", emoji: "cactus", lastOpened: 200 },
      ] as Array<{
        id: string;
        path: string;
        name: string;
        emoji: string;
        lastOpened: number;
        status?: "active" | "background" | "closed" | "missing";
      }>,
      currentProject: { id: "p-current" } as { id: string } | null,
      switchProject: switchProjectMock,
      reopenProject: reopenProjectMock,
    };

    const useProjectStoreMock = Object.assign(
      vi.fn((selector: (state: typeof projectState) => unknown) => selector(projectState)),
      { getState: () => projectState }
    );

    return {
      switchProjectMock,
      reopenProjectMock,
      notifyMock,
      projectState,
      useProjectStoreMock,
    };
  });

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

vi.mock("@/store/projectStore", () => ({
  useProjectStore: useProjectStoreMock,
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
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

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

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

describe("useProjectMruSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectState.currentProject = { id: "p-current" };
    projectState.projects = [
      { id: "p-current", path: "/p-current", name: "Current", emoji: "tree", lastOpened: 500 },
      { id: "p-recent", path: "/p-recent", name: "Recent", emoji: "apple", lastOpened: 400 },
      { id: "p-older", path: "/p-older", name: "Older", emoji: "carrot", lastOpened: 300 },
      { id: "p-oldest", path: "/p-oldest", name: "Oldest", emoji: "cactus", lastOpened: 200 },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Cmd+Alt+- is ignored so the shortcut remains free", () => {
    renderHook(() => useProjectMruSwitcher());

    let event: KeyboardEvent | undefined;
    act(() => {
      event = keyDown("Minus");
    });

    expect(event?.defaultPrevented).toBe(false);
    expect(switchProjectMock).not.toHaveBeenCalled();
    expect(reopenProjectMock).not.toHaveBeenCalled();
  });

  it("Cmd+Alt+= immediately switches forward through MRU", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal");
    });

    expect(switchProjectMock).toHaveBeenCalledWith("p-recent");
  });

  it("Cmd+Shift+Alt+= switches backward through MRU (Shift inverts direction)", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal", { shiftKey: true });
    });

    // Shift maps to "newer" → least-recently-opened non-current project
    expect(switchProjectMock).toHaveBeenCalledWith("p-oldest");
  });

  it("numpad add switches forward and numpad subtract remains free", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("NumpadAdd");
    });
    expect(switchProjectMock).toHaveBeenCalledWith("p-recent");

    vi.clearAllMocks();

    let event: KeyboardEvent | undefined;
    act(() => {
      event = keyDown("NumpadSubtract");
    });
    expect(event?.defaultPrevented).toBe(false);
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("two-project state lets plus toggle to the other project", () => {
    projectState.projects = [
      { id: "p-current", path: "/p-current", name: "Current", emoji: "tree", lastOpened: 500 },
      { id: "p-other", path: "/p-other", name: "Other", emoji: "leaf", lastOpened: 400 },
    ];
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal");
    });
    expect(switchProjectMock).toHaveBeenCalledWith("p-other");
  });

  it("repeat keydowns are consumed but do not switch again", () => {
    render(<AppLikeKeybindingHost />);

    let event: KeyboardEvent | undefined;
    act(() => {
      event = keyDown("Equal", { repeat: true });
    });

    expect(event?.defaultPrevented).toBe(true);
    expect(switchProjectMock).not.toHaveBeenCalled();
    expect(keybindingServiceMock.resolveKeybinding).not.toHaveBeenCalled();
    expect(actionDispatchMock).not.toHaveBeenCalled();
  });

  it("single-project state is a no-op", () => {
    projectState.projects = [
      { id: "p-current", path: "/p-current", name: "Current", emoji: "tree", lastOpened: 500 },
    ];
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal");
    });

    expect(switchProjectMock).not.toHaveBeenCalled();
    expect(reopenProjectMock).not.toHaveBeenCalled();
  });

  it("IME composition keydown is ignored", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal", { isComposing: true });
    });

    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("commits background project via reopenProject", () => {
    projectState.projects = [
      { id: "p-current", path: "/p-current", name: "Current", emoji: "tree", lastOpened: 500 },
      {
        id: "p-bg",
        path: "/p-bg",
        name: "BG",
        emoji: "leaf",
        lastOpened: 400,
        status: "background",
      },
    ];
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal");
    });

    expect(reopenProjectMock).toHaveBeenCalledWith("p-bg");
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("no-ops when target is an editable input outside xterm", () => {
    renderHook(() => useProjectMruSwitcher());

    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      keyDown("Equal", { target: input });
    });

    expect(switchProjectMock).not.toHaveBeenCalled();
    input.remove();
  });

  it("still fires inside an .xterm container", () => {
    renderHook(() => useProjectMruSwitcher());

    const term = document.createElement("div");
    term.className = "xterm";
    document.body.appendChild(term);
    act(() => {
      keyDown("Equal", { target: term });
    });

    expect(switchProjectMock).toHaveBeenCalledWith("p-recent");
    term.remove();
  });

  it("fires inside xterm helper textarea", () => {
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

    expect(switchProjectMock).toHaveBeenCalledWith("p-recent");
    term.remove();
  });

  it("switchProject rejection surfaces via notify", async () => {
    const err = new Error("boom");
    switchProjectMock.mockRejectedValueOnce(err);

    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal");
    });

    await vi.waitFor(() => {
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: "boom" })
      );
    });
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

    expect(switchProjectMock).toHaveBeenCalledWith("p-recent");
    expect(keybindingServiceMock.resolveKeybinding).not.toHaveBeenCalled();
    expect(actionDispatchMock).not.toHaveBeenCalled();
  });

  it("forces current project out of the selectable MRU set even when not newest", () => {
    projectState.currentProject = { id: "p-stale" };
    projectState.projects = [
      { id: "p-stale", path: "/p-stale", name: "Stale", emoji: "tree", lastOpened: 100 },
      { id: "p-fresh", path: "/p-fresh", name: "Fresh", emoji: "apple", lastOpened: 500 },
    ];
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal");
    });

    expect(switchProjectMock).toHaveBeenCalledWith("p-fresh");
  });

  it("ignores keydowns when modifiers are absent", () => {
    renderHook(() => useProjectMruSwitcher());

    const event = keyDown("Equal", { metaKey: false, altKey: false });

    expect(event.defaultPrevented).toBe(false);
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  describe("with a scratch active (no current project)", () => {
    beforeEach(() => {
      // Switching to a scratch clears `currentProject` but leaves every
      // project's `lastOpened` untouched, so the pre-scratch project is still
      // the MRU head. Statuses here are the post-reconciliation snapshot, once
      // main has repaired the departed row to "background" (#11085).
      projectState.currentProject = null;
      projectState.projects = [
        {
          id: "p-prev",
          path: "/p-prev",
          name: "Previous",
          emoji: "tree",
          lastOpened: 500,
          status: "background",
        },
        {
          id: "p-older",
          path: "/p-older",
          name: "Older",
          emoji: "carrot",
          lastOpened: 300,
          status: "background",
        },
      ];
    });

    it("Cmd+Alt+= returns to the project active before the scratch", () => {
      renderHook(() => useProjectMruSwitcher());

      act(() => {
        keyDown("Equal");
      });

      expect(reopenProjectMock).toHaveBeenCalledTimes(1);
      expect(reopenProjectMock).toHaveBeenCalledWith("p-prev");
      expect(switchProjectMock).not.toHaveBeenCalled();
    });

    it("Cmd+Shift+Alt+= wraps to the least-recent project", () => {
      renderHook(() => useProjectMruSwitcher());

      act(() => {
        keyDown("Equal", { shiftKey: true });
      });

      expect(reopenProjectMock).toHaveBeenCalledTimes(1);
      expect(reopenProjectMock).toHaveBeenCalledWith("p-older");
      expect(switchProjectMock).not.toHaveBeenCalled();
    });

    it("still targets the pre-scratch project before main reconciles its status", () => {
      // The immediate post-switch snapshot: the departed row is still "active"
      // because the scratch switch never demoted or broadcast it.
      projectState.projects = [
        {
          id: "p-prev",
          path: "/p-prev",
          name: "Previous",
          emoji: "tree",
          lastOpened: 500,
          status: "active",
        },
        {
          id: "p-older",
          path: "/p-older",
          name: "Older",
          emoji: "carrot",
          lastOpened: 300,
          status: "background",
        },
      ];
      renderHook(() => useProjectMruSwitcher());

      act(() => {
        keyDown("Equal");
      });

      expect(switchProjectMock).toHaveBeenCalledTimes(1);
      expect(switchProjectMock).toHaveBeenCalledWith("p-prev");
      expect(reopenProjectMock).not.toHaveBeenCalled();
    });

    it("no-ops when no projects exist at all", () => {
      projectState.projects = [];
      renderHook(() => useProjectMruSwitcher());

      act(() => {
        keyDown("Equal");
      });

      expect(switchProjectMock).not.toHaveBeenCalled();
      expect(reopenProjectMock).not.toHaveBeenCalled();
    });
  });
});
