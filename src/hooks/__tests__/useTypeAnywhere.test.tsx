// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

const pingTerminal = vi.fn();
const setFocused = vi.fn();
const exitMaximize = vi.fn();
const focusPanelInput = vi.fn<(id: string, surface?: string) => boolean>(() => true);
// The request module has its own suite; this stands in for whether the one
// request type-anywhere makes is still current.
const focusRequest = vi.hoisted(() => ({
  current: null as { id: string; surface: string } | null,
}));
const requestPaneFocus = vi.hoisted(() =>
  vi.fn((id: string, surface: string) => {
    focusRequest.current = { id, surface };
    return false;
  })
);

let panelState: {
  panelsById: Record<string, PanelInstance>;
  panelIds: string[];
  maximizedId: string | null;
  backendStatus: string;
};
let armedIds: Set<string>;
let screenReaderEnabled: boolean;
let activePaletteId: string | null;
let workspaceId: string | null;

vi.mock("@/store", () => ({
  usePanelStore: {
    getState: () => ({
      ...panelState,
      pingTerminal,
      setFocused,
      exitMaximize,
    }),
  },
}));

vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: { getState: () => ({ armedIds }) },
}));

vi.mock("@/store/screenReaderStore", () => ({
  useScreenReaderStore: {
    getState: () => ({ resolvedScreenReaderEnabled: () => screenReaderEnabled }),
  },
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId }) },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ currentProject: { id: "proj" } }) },
}));

vi.mock("@/store/viewWorkspaceId", () => ({
  getViewWorkspaceId: () => workspaceId,
}));

vi.mock("@/components/Panel/panelFocusRegistry", () => ({
  focusPanelInput: (id: string, surface?: string) => focusPanelInput(id, surface),
}));

vi.mock("@/components/Terminal/paneFocusRequest", () => ({
  requestPaneFocus,
  requestedPaneSurface: (id: string) =>
    focusRequest.current?.id === id ? focusRequest.current.surface : null,
}));

import { useTypeAnywhere, LOCATE_EPISODE_MS } from "../useTypeAnywhere";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useTypingLocatorStore } from "@/store/typingLocatorStore";

function agentPanel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: "Claude",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    hasPty: true,
    runtimeStatus: "running",
    launchAgentId: "claude",
    isVisible: true,
    ...overrides,
  };
}

function setPanels(panels: PanelInstance[], maximizedId: string | null = null) {
  const panelsById: Record<string, PanelInstance> = {};
  for (const p of panels) panelsById[p.id] = p;
  panelState = {
    panelsById,
    panelIds: panels.map((p) => p.id),
    maximizedId,
    backendStatus: "connected",
  };
}

/** Dispatch a keydown as the browser would: at the window, in capture phase. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}

function draftOf(id: string): string {
  return useTerminalInputStore.getState().getDraftInput(id, "proj");
}

describe("useTypeAnywhere", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    focusPanelInput.mockImplementation(() => true);
    focusRequest.current = null;
    document.body.innerHTML = "";
    // jsdom ships no scrollIntoView; without this the reveal step throws and
    // aborts the handler mid-way. Tests asserting the scroll shadow this with
    // an element-level spy.
    Element.prototype.scrollIntoView = vi.fn();
    setPanels([agentPanel("a1")]);
    armedIds = new Set();
    screenReaderEnabled = false;
    activePaletteId = null;
    workspaceId = "proj";
    useTerminalInputStore.setState({
      draftInputs: new Map(),
      externalDraftRevision: 0,
      lastTypedAgentTarget: null,
      voiceSubmittingPanels: new Set(),
      hybridInputEnabled: true,
      hybridInputAutoFocus: true,
    });
    useTypingLocatorStore.setState({ message: null, revision: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("rescue", () => {
    it("routes the keystroke into the sole agent's draft and consumes it", () => {
      renderHook(() => useTypeAnywhere());

      const e = press("h");

      expect(draftOf("a1")).toBe("h");
      expect(e.defaultPrevented).toBe(true);
      expect(setFocused).toHaveBeenCalledWith("a1");
      // Asked of the pane once it is selected, rather than steering every
      // later arrival through the shared preference.
      expect(requestPaneFocus).toHaveBeenCalledExactlyOnceWith("a1", "hybridInput");
      expect(setFocused.mock.invocationCallOrder[0]!).toBeLessThan(
        requestPaneFocus.mock.invocationCallOrder[0]!
      );
    });

    // Type-anywhere saved the keystroke in the hybrid input's draft, so that is
    // where the keyboard goes, whichever surface arrivals land on.
    it.each([true, false])(
      "asks for the hybrid input whatever home is (Focus the input bar first: %s)",
      (hybridInputAutoFocus) => {
        useTerminalInputStore.setState({ hybridInputAutoFocus });
        renderHook(() => useTypeAnywhere());

        press("h");

        expect(draftOf("a1")).toBe("h");
        expect(requestPaneFocus).toHaveBeenCalledExactlyOnceWith("a1", "hybridInput");
      }
    );

    it("appends to an existing draft rather than replacing it", () => {
      useTerminalInputStore.getState().setDraftInput("a1", "fix the ", "proj");
      renderHook(() => useTypeAnywhere());

      press("b");

      expect(draftOf("a1")).toBe("fix the b");
    });

    it("never submits — it only bumps the draft revision", () => {
      renderHook(() => useTypeAnywhere());

      press("h");

      // Enter stays the user's decision; the rescue's only external signal is
      // the draft-sync revision.
      expect(useTerminalInputStore.getState().externalDraftRevision).toBe(1);
    });

    it("prefers the last agent typed to over other open agents", () => {
      setPanels([agentPanel("a1"), agentPanel("a2")]);
      useTerminalInputStore.setState({
        lastTypedAgentTarget: { terminalId: "a2", workspaceId: "proj" },
      });
      renderHook(() => useTypeAnywhere());

      press("x");

      expect(draftOf("a2")).toBe("x");
      expect(draftOf("a1")).toBe("");
    });

    it("ignores a target claimed by a sibling project view", () => {
      setPanels([agentPanel("a1"), agentPanel("a2")]);
      useTerminalInputStore.setState({
        lastTypedAgentTarget: { terminalId: "a2", workspaceId: "other-view" },
      });
      renderHook(() => useTypeAnywhere());

      const e = press("x");

      // No history usable here + two agents = ambiguous = refuse.
      expect(e.defaultPrevented).toBe(false);
      expect(draftOf("a2")).toBe("");
    });

    it("reveals the pane: un-maximizes a different pane and scrolls the target in", () => {
      const scrollIntoView = vi.fn();
      document.body.innerHTML = `<div data-panel-id="a1"></div>`;
      const host = document.querySelector<HTMLElement>('[data-panel-id="a1"]');
      host!.scrollIntoView = scrollIntoView;
      setPanels([agentPanel("a1")], "other");
      renderHook(() => useTypeAnywhere());

      press("h");

      expect(exitMaximize).toHaveBeenCalled();
      expect(scrollIntoView).toHaveBeenCalled();
    });

    it("refuses while a fleet broadcast is live", () => {
      armedIds = new Set(["a1", "a2"]);
      renderHook(() => useTypeAnywhere());

      const e = press("h");

      expect(e.defaultPrevented).toBe(false);
      expect(draftOf("a1")).toBe("");
    });

    it("still rescues when a single agent is armed — that is a preview, not a broadcast", () => {
      armedIds = new Set(["a1"]);
      renderHook(() => useTypeAnywhere());

      press("h");

      expect(draftOf("a1")).toBe("h");
    });

    it("refuses when the hybrid input bar is switched off — the draft would be invisible", () => {
      // With the setting off no agent renders a draft bar, so a routed character
      // would land in a store nothing displays: the same silent loss, one layer
      // deeper. Refusing lets the key fall through untouched instead.
      useTerminalInputStore.setState({ hybridInputEnabled: false });
      renderHook(() => useTypeAnywhere());

      const e = press("h");

      expect(e.defaultPrevented).toBe(false);
      expect(draftOf("a1")).toBe("");
      expect(setFocused).not.toHaveBeenCalled();
    });

    it("refuses while the PTY backend is down", () => {
      setPanels([agentPanel("a1")]);
      panelState.backendStatus = "recovering";
      renderHook(() => useTypeAnywhere());

      const e = press("h");

      expect(e.defaultPrevented).toBe(false);
      expect(draftOf("a1")).toBe("");
    });

    it("refuses when a screen reader is active — single letters are quick-nav keys", () => {
      screenReaderEnabled = true;
      renderHook(() => useTypeAnywhere());

      const e = press("h");

      expect(e.defaultPrevented).toBe(false);
      expect(draftOf("a1")).toBe("");
    });

    it("refuses while a modal is open", () => {
      document.body.innerHTML = `<div role="dialog" aria-modal="true"></div>`;
      renderHook(() => useTypeAnywhere());

      const e = press("h");

      expect(e.defaultPrevented).toBe(false);
      expect(draftOf("a1")).toBe("");
    });

    it("refuses while a palette is open", () => {
      activePaletteId = "actions";
      renderHook(() => useTypeAnywhere());

      const e = press("h");

      expect(e.defaultPrevented).toBe(false);
      expect(draftOf("a1")).toBe("");
    });

    it("leaves typing in a real input alone", () => {
      document.body.innerHTML = `<input id="i" />`;
      document.getElementById("i")?.focus();
      renderHook(() => useTypeAnywhere());

      const e = press("h");

      expect(e.defaultPrevented).toBe(false);
      expect(draftOf("a1")).toBe("");
    });

    it("leaves menu typeahead alone", () => {
      // An open menu consumes bare letters to jump between items. Stealing "h"
      // would break navigation and silently append it to an agent draft.
      document.body.innerHTML = `
        <div role="menu"><div id="mi" role="menuitem" tabindex="-1">Hide</div></div>`;
      const item = document.getElementById("mi");
      item?.focus();
      renderHook(() => useTypeAnywhere());

      const e = new KeyboardEvent("keydown", {
        key: "h",
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      act(() => {
        item?.dispatchEvent(e);
      });

      expect(e.defaultPrevented).toBe(false);
      expect(draftOf("a1")).toBe("");
    });

    it("ignores Enter, Space and modifier chords", () => {
      renderHook(() => useTypeAnywhere());

      press("Enter");
      press(" ");
      press("s", { metaKey: true });

      expect(draftOf("a1")).toBe("");
    });

    it("retries focus until it lands in the target's hybrid input", async () => {
      vi.useFakeTimers();
      const rafSpy = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
      // The first attempt is accepted without focus landing (a handle that
      // reports a mounted view, not a focused one); the lazy editor takes the
      // keyboard on the next.
      const editor = document.createElement("div");
      editor.setAttribute("data-hybrid-input-root", "a1");
      editor.tabIndex = 0;
      focusPanelInput.mockImplementation(() => {
        if (focusPanelInput.mock.calls.length < 2) return true;
        document.body.appendChild(editor);
        editor.focus();
        return true;
      });
      renderHook(() => useTypeAnywhere());

      press("h");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(focusPanelInput).toHaveBeenCalledTimes(2);
      expect(focusPanelInput).toHaveBeenLastCalledWith("a1", "hybridInput");
      expect(document.activeElement).toBe(editor);

      editor.remove();
      rafSpy.mockRestore();
    });

    // A press elsewhere or a newer request ends the request, and a retry after
    // that would drag the keyboard back to where the user has left.
    it.each([
      ["ended", null],
      ["replaced by a request for the terminal", { id: "a1", surface: "xterm" }],
    ])("stops retrying once its request is %s", async (_, next) => {
      vi.useFakeTimers();
      const rafSpy = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
      focusPanelInput.mockImplementation(() => {
        focusRequest.current = next;
        return false;
      });
      renderHook(() => useTypeAnywhere());

      press("h");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(focusPanelInput).toHaveBeenCalledTimes(1);

      rafSpy.mockRestore();
    });
  });

  describe("locate", () => {
    function focusOffscreenTerminal(id: string) {
      document.body.innerHTML = `
        <div data-panel-id="${id}">
          <div class="xterm"><div id="x" tabindex="0"></div></div>
        </div>`;
      document.getElementById("x")?.focus();
    }

    it("reveals an off-screen focused terminal without stealing the keystroke", () => {
      setPanels([agentPanel("a1", { isVisible: false })]);
      focusOffscreenTerminal("a1");
      const host = document.querySelector<HTMLElement>('[data-panel-id="a1"]');
      const scrollIntoView = vi.fn();
      host!.scrollIntoView = scrollIntoView;
      renderHook(() => useTypeAnywhere());

      const e = press("h");

      expect(scrollIntoView).toHaveBeenCalled();
      expect(pingTerminal).toHaveBeenCalledWith("a1");
      expect(useTypingLocatorStore.getState().message?.target).toContain("Claude");
      // The key belongs to that terminal — it must land there, untouched.
      expect(e.defaultPrevented).toBe(false);
      expect(setFocused).not.toHaveBeenCalled();
      expect(draftOf("a1")).toBe("");
    });

    it("stays silent when the focused terminal is already visible", () => {
      setPanels([agentPanel("a1", { isVisible: true })]);
      focusOffscreenTerminal("a1");
      renderHook(() => useTypeAnywhere());

      const e = press("h");

      expect(pingTerminal).not.toHaveBeenCalled();
      expect(useTypingLocatorStore.getState().message).toBeNull();
      expect(e.defaultPrevented).toBe(false);
    });

    it("locates a raw shell too — the keystroke is legitimately its own", () => {
      // The rescue must never route INTO a shell, but a focused off-screen shell
      // still deserves to be found.
      setPanels([agentPanel("sh", { isVisible: false, launchAgentId: undefined, title: "zsh" })]);
      focusOffscreenTerminal("sh");
      renderHook(() => useTypeAnywhere());

      press("l");

      expect(pingTerminal).toHaveBeenCalledWith("sh");
      expect(useTypingLocatorStore.getState().message?.target).toContain("zsh");
    });

    it("locates once per episode, not once per keystroke", () => {
      setPanels([agentPanel("a1", { isVisible: false })]);
      focusOffscreenTerminal("a1");
      const host = document.querySelector<HTMLElement>('[data-panel-id="a1"]');
      const scrollIntoView = vi.fn();
      host!.scrollIntoView = scrollIntoView;
      renderHook(() => useTypeAnywhere());
      const revisionBefore = useTypingLocatorStore.getState().revision;

      press("h");
      press("e");
      press("y");

      // Each ping advances pingSeq, and the worktree card mounts a fresh receipt
      // overlay per advance — three pings is three background flashes.
      expect(pingTerminal).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(useTypingLocatorStore.getState().revision - revisionBefore).toBe(1);
    });

    it("starts a new episode once the pane has been seen on screen again", () => {
      setPanels([agentPanel("a1", { isVisible: false })]);
      focusOffscreenTerminal("a1");
      renderHook(() => useTypeAnywhere());

      press("h");
      expect(pingTerminal).toHaveBeenCalledTimes(1);

      // The reveal lands: a keystroke into the now-visible pane closes the
      // episode without locating anything.
      setPanels([agentPanel("a1", { isVisible: true })]);
      press("e");
      expect(pingTerminal).toHaveBeenCalledTimes(1);

      // Scrolled away again — the user is typing blind once more.
      setPanels([agentPanel("a1", { isVisible: false })]);
      press("y");
      expect(pingTerminal).toHaveBeenCalledTimes(2);
    });

    it("keeps suppressing while the locator is still on screen", () => {
      vi.useFakeTimers();
      try {
        setPanels([agentPanel("a1", { isVisible: false })]);
        focusOffscreenTerminal("a1");
        renderHook(() => useTypeAnywhere());

        press("h");
        // Still inside the pill's life, so the pane is already named on screen.
        vi.advanceTimersByTime(LOCATE_EPISODE_MS - 1);
        press("e");

        expect(pingTerminal).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-locates a still-hidden pane once the locator has cleared", () => {
      vi.useFakeTimers();
      try {
        setPanels([agentPanel("a1", { isVisible: false })]);
        focusOffscreenTerminal("a1");
        renderHook(() => useTypeAnywhere());

        press("h");
        press("e");
        expect(pingTerminal).toHaveBeenCalledTimes(1);

        // The pill has been cleared, so nothing on screen still names the pane
        // and a keystroke landing off-screen has earned a fresh locate.
        vi.advanceTimersByTime(LOCATE_EPISODE_MS);
        press("y");

        expect(pingTerminal).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts a new episode after a backward wall-clock step", () => {
      vi.useFakeTimers();
      try {
        setPanels([agentPanel("a1", { isVisible: false })]);
        focusOffscreenTerminal("a1");
        renderHook(() => useTypeAnywhere());

        press("h");
        // An NTP correction must not strand the pane un-locatable until real
        // time catches back up to the episode stamp.
        vi.setSystemTime(Date.now() - 60_000);
        press("e");

        expect(pingTerminal).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-locates a pane the rescue branch renamed the locator away from", () => {
      setPanels([agentPanel("a1", { isVisible: false })]);
      focusOffscreenTerminal("a1");
      renderHook(() => useTypeAnywhere());

      press("h");
      expect(pingTerminal).toHaveBeenCalledTimes(1);

      // Focus leaves the terminal entirely and the rescue repoints the pill at
      // its own target, so nothing on screen still names a1.
      document.body.innerHTML += `<div id="elsewhere" tabindex="0"></div>`;
      document.getElementById("elsewhere")?.focus();
      press("e");
      expect(useTypingLocatorStore.getState().message?.target).toContain("Claude");

      focusOffscreenTerminal("a1");
      press("y");

      expect(pingTerminal).toHaveBeenCalledTimes(2);
    });

    it("locates each pane separately when focus moves between them", () => {
      setPanels([
        agentPanel("a1", { isVisible: false }),
        agentPanel("a2", { isVisible: false, title: "Codex" }),
      ]);
      focusOffscreenTerminal("a1");
      renderHook(() => useTypeAnywhere());

      press("h");
      focusOffscreenTerminal("a2");
      press("i");
      // Coming straight back is a new context: the pill now names a2.
      focusOffscreenTerminal("a1");
      press("o");

      expect(pingTerminal).toHaveBeenNthCalledWith(1, "a1");
      expect(pingTerminal).toHaveBeenNthCalledWith(2, "a2");
      expect(pingTerminal).toHaveBeenNthCalledWith(3, "a1");
    });
  });

  it("removes its listener on unmount", () => {
    const { unmount } = renderHook(() => useTypeAnywhere());
    unmount();

    press("h");

    expect(draftOf("a1")).toBe("");
  });
});
