// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  worktrees: new Map<string, unknown>(),
  viewStoreThrows: false,
  navigate: vi.fn(async (_context: unknown) => true),
  suppressResizes: vi.fn(),
}));

// A real store holding only the roster, so the live hook's subscriptions are exercised.
vi.mock("@/store/panelStore", async () => {
  const { create } = await import("zustand");
  return { usePanelStore: create(() => ({ panelsById: {} as Record<string, unknown> })) };
});

vi.mock("@/lib/sidebarToggle", () => ({ suppressSidebarResizes: mocks.suppressResizes }));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => {
    if (mocks.viewStoreThrows) throw new Error("no worktree view store mounted");
    return { getState: () => ({ worktrees: mocks.worktrees }) };
  },
}));

vi.mock("@/components/Notifications/notificationNavigation", () => ({
  navigateToNotificationSource: mocks.navigate,
}));

import {
  resolveMcpConfirmRequester,
  showMcpRequester,
  useMcpRequesterLiveState,
} from "../mcpConfirmRequester";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFocusStore } from "@/store/focusStore";
import type { McpConfirmRequester } from "@/store/mcpConfirmStore";

const initialHelp = useHelpPanelStore.getState();

function setPanels(panelsById: Record<string, unknown>): void {
  usePanelStore.setState({ panelsById } as never);
}
const initialSelection = useWorktreeSelectionStore.getState();
const initialFocus = useFocusStore.getState();

function lane(terminalId: string | null, sessionId: string | null) {
  return {
    terminalId,
    agentId: "claude",
    sessionId,
    conversationTouched: true,
    figures: [],
    activeFigureNumber: null,
  };
}

beforeEach(() => {
  setPanels({});
  mocks.worktrees = new Map();
  mocks.viewStoreThrows = false;
  mocks.navigate.mockClear();
  mocks.suppressResizes.mockClear();
  usePreferencesStore.setState({ showAgentTaskTitles: true });
});

afterEach(() => {
  useHelpPanelStore.setState(initialHelp, true);
  useWorktreeSelectionStore.setState(initialSelection, true);
  useFocusStore.setState(initialFocus, true);
});

describe("resolveMcpConfirmRequester — a pane", () => {
  const identity = { kind: "pane", terminalId: "p1" } as const;

  it("names the pane as its header does, with its agent and worktree", () => {
    mocks.worktrees.set("wt-1", { branch: "feature/auth", name: "auth" });
    setPanels({
      p1: {
        id: "p1",
        title: "Orchestrator",
        worktreeId: "wt-1",
        detectedAgentId: "claude",
        agentState: "working",
        location: "grid",
      },
    });

    expect(resolveMcpConfirmRequester(identity)).toEqual({
      identity,
      name: "Orchestrator",
      kindLabel: "Claude",
      worktreeId: "wt-1",
      worktreeName: "feature/auth",
    });
  });

  it("doesn't repeat an agent the pane's title already names", () => {
    setPanels({
      p1: { id: "p1", title: "Claude", detectedAgentId: "claude", location: "grid" },
    });

    const requester = resolveMcpConfirmRequester(identity);
    expect(requester.name).toBe("Claude");
    expect(requester).not.toHaveProperty("kindLabel");
  });

  it("follows the task-title preference the pane's own header follows", () => {
    const pane = {
      id: "p1",
      title: "Orchestrator",
      detectedAgentId: "claude",
      agentState: "working",
      lastObservedTitle: "✳ fix auth tests",
      location: "grid",
    };
    setPanels({ p1: pane });
    const shown = resolveMcpConfirmRequester(identity).name;

    usePreferencesStore.setState({ showAgentTaskTitles: false });
    const hidden = resolveMcpConfirmRequester(identity).name;

    expect(shown).not.toBe(hidden);
    expect(shown).toContain("fix auth tests");
    expect(hidden).toBe("Orchestrator");
  });

  it.each([
    ["isn't in this view", {}],
    ["is in the trash", { p1: { id: "p1", title: "zsh", location: "trash" } }],
  ])("keeps only the identity for a pane that %s", (_label, panels) => {
    setPanels(panels);
    expect(resolveMcpConfirmRequester(identity)).toEqual({ identity });
  });

  it("does not resolve an id off Object.prototype", () => {
    const own = { kind: "pane", terminalId: "constructor" } as const;
    expect(resolveMcpConfirmRequester(own)).toEqual({ identity: own });
  });

  it("keeps the worktree's id when no worktree store is mounted to name it", () => {
    mocks.viewStoreThrows = true;
    setPanels({ p1: { id: "p1", title: "zsh", worktreeId: "wt-1", location: "grid" } });

    const requester = resolveMcpConfirmRequester(identity);
    expect(requester.worktreeId).toBe("wt-1");
    expect(requester).not.toHaveProperty("worktreeName");
  });
});

describe("resolveMcpConfirmRequester — an Assistant tab", () => {
  const identity = { kind: "assistant", helpSessionId: "help-b" } as const;

  it("finds the lane by its help session, not by slot, and names it as its tab does", () => {
    useHelpPanelStore.setState({
      sessions: { 0: lane("t-a", "help-a"), 1: lane("t-b", "help-b") },
    });

    expect(resolveMcpConfirmRequester(identity)).toEqual({ identity, name: "Session 2" });
  });

  it("names the lane by its agent's task while task titles are shown", () => {
    setPanels({
      "t-b": {
        id: "t-b",
        kind: "terminal",
        title: "Claude",
        detectedAgentId: "claude",
        agentState: "working",
        lastObservedTitle: "✳ review the auth changes",
        location: "grid",
      },
    });
    useHelpPanelStore.setState({ sessions: { 0: lane("t-b", "help-b") } });

    const shown = resolveMcpConfirmRequester(identity).name;
    usePreferencesStore.setState({ showAgentTaskTitles: false });
    const hidden = resolveMcpConfirmRequester(identity).name;

    expect(shown).toContain("review the auth changes");
    expect(hidden).toBe("Session 1");
  });

  it("keeps only the identity once the session's lane has gone", () => {
    useHelpPanelStore.setState({ sessions: { 0: lane("t-a", "help-a") } });
    expect(resolveMcpConfirmRequester(identity)).toEqual({ identity });
  });
});

describe("useMcpRequesterLiveState", () => {
  const PANE: McpConfirmRequester = {
    identity: { kind: "pane", terminalId: "p1" },
    name: "Orchestrator",
    worktreeId: "wt-1",
    worktreeName: "feature/auth",
  };
  const live = (requester: McpConfirmRequester) =>
    renderHook(() => useMcpRequesterLiveState(requester)).result.current;

  it("names no worktree for a pane in the one on screen", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    setPanels({ p1: { id: "p1", title: "Orchestrator", worktreeId: "wt-1" } });

    expect(live(PANE)).toEqual({ present: true });
  });

  it("names the worktree the pane asked from while another is on screen", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-9" });
    setPanels({ p1: { id: "p1", title: "Orchestrator", worktreeId: "wt-1" } });

    expect(live(PANE)).toEqual({ present: true, otherWorktreeName: "feature/auth" });
  });

  it("follows the pane while the dialog is up: moved, then trashed", () => {
    mocks.worktrees.set("wt-2", { branch: "feature/moved", name: "moved" });
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    setPanels({ p1: { id: "p1", title: "Orchestrator", worktreeId: "wt-1" } });
    const { result } = renderHook(() => useMcpRequesterLiveState(PANE));
    expect(result.current).toEqual({ present: true });

    // Moved since it asked: named where it is now, as Show pane will go.
    act(() => setPanels({ p1: { id: "p1", title: "Orchestrator", worktreeId: "wt-2" } }));
    expect(result.current).toEqual({ present: true, otherWorktreeName: "feature/moved" });

    act(() => useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-2" }));
    expect(result.current).toEqual({ present: true });

    act(() => setPanels({ p1: { id: "p1", title: "Orchestrator", location: "trash" } }));
    expect(result.current.present).toBe(false);
  });

  it("finds an Assistant lane by its session while it holds it", () => {
    const tab: McpConfirmRequester = {
      identity: { kind: "assistant", helpSessionId: "help-b" },
      name: "Session 1",
    };
    useHelpPanelStore.setState({ sessions: { 0: lane("t-b", "help-b") } });
    const { result } = renderHook(() => useMcpRequesterLiveState(tab));
    expect(result.current.present).toBe(true);

    // The same slot, a new conversation.
    act(() => useHelpPanelStore.setState({ sessions: { 0: lane("t-c", "help-c") } }));
    expect(result.current.present).toBe(false);
  });
});

describe("showMcpRequester", () => {
  it("goes to the pane itself, and never to its worktree in its place", async () => {
    mocks.navigate.mockResolvedValueOnce(false);

    await expect(showMcpRequester({ kind: "pane", terminalId: "p1" })).resolves.toBe(false);
    expect(mocks.navigate).toHaveBeenCalledWith({ panelId: "p1" });
  });

  it("opens the Assistant on the asking lane and asks it for focus", async () => {
    useHelpPanelStore.setState({
      isOpen: false,
      activeSlot: 0,
      sessions: { 0: lane("t-a", "help-a"), 1: lane("t-b", "help-b") },
    });
    const focusBefore = useHelpPanelStore.getState().focusRequest;

    await expect(showMcpRequester({ kind: "assistant", helpSessionId: "help-b" })).resolves.toBe(
      true
    );

    const state = useHelpPanelStore.getState();
    expect(state.activeSlot).toBe(1);
    expect(state.isOpen).toBe(true);
    expect(state.focusRequest).toBeGreaterThan(focusBefore);
    // Opening moves the layout, so the terminals sit out the transition.
    expect(mocks.suppressResizes).toHaveBeenCalledTimes(1);
  });

  it("brings back an Assistant that focus mode hid", async () => {
    useHelpPanelStore.setState({ isOpen: true, sessions: { 0: lane("t-b", "help-b") } });
    useFocusStore.setState({ gestureAssistantHidden: true, isFocusMode: true });

    await expect(showMcpRequester({ kind: "assistant", helpSessionId: "help-b" })).resolves.toBe(
      true
    );

    expect(useFocusStore.getState().gestureAssistantHidden).toBe(false);
    expect(mocks.suppressResizes).toHaveBeenCalledTimes(1);
  });

  it("leaves the layout alone when the Assistant is already on screen", async () => {
    useHelpPanelStore.setState({ isOpen: true, sessions: { 0: lane("t-b", "help-b") } });

    await showMcpRequester({ kind: "assistant", helpSessionId: "help-b" });

    expect(mocks.suppressResizes).not.toHaveBeenCalled();
  });

  it("changes nothing for a session whose lane has gone", async () => {
    useHelpPanelStore.setState({ isOpen: false, activeSlot: 0, sessions: { 0: lane("t-a", "x") } });

    await expect(showMcpRequester({ kind: "assistant", helpSessionId: "help-b" })).resolves.toBe(
      false
    );
    expect(useHelpPanelStore.getState().isOpen).toBe(false);
  });
});
