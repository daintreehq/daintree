// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  panelsById: {} as Record<string, unknown>,
  worktrees: new Map<string, unknown>(),
  viewStoreThrows: false,
  navigate: vi.fn(async (_context: unknown) => true),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById: mocks.panelsById }) },
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => {
    if (mocks.viewStoreThrows) throw new Error("no worktree view store mounted");
    return { getState: () => ({ worktrees: mocks.worktrees }) };
  },
}));

vi.mock("@/components/Notifications/notificationNavigation", () => ({
  navigateToNotificationSource: mocks.navigate,
}));

import { resolveMcpConfirmRequester, showMcpRequester } from "../mcpConfirmRequester";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePreferencesStore } from "@/store/preferencesStore";

const initialHelp = useHelpPanelStore.getState();

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
  mocks.panelsById = {};
  mocks.worktrees = new Map();
  mocks.viewStoreThrows = false;
  mocks.navigate.mockClear();
  usePreferencesStore.setState({ showAgentTaskTitles: true });
});

afterEach(() => {
  useHelpPanelStore.setState(initialHelp, true);
});

describe("resolveMcpConfirmRequester — a pane", () => {
  const identity = { kind: "pane", terminalId: "p1" } as const;

  it("names the pane as its header does, with its agent and worktree", () => {
    mocks.worktrees.set("wt-1", { branch: "feature/auth", name: "auth" });
    mocks.panelsById = {
      p1: {
        id: "p1",
        title: "Orchestrator",
        worktreeId: "wt-1",
        detectedAgentId: "claude",
        agentState: "working",
        location: "grid",
      },
    };

    expect(resolveMcpConfirmRequester(identity)).toEqual({
      identity,
      name: "Orchestrator",
      kindLabel: "Claude",
      worktreeId: "wt-1",
      worktreeName: "feature/auth",
    });
  });

  it("doesn't repeat an agent the pane's title already names", () => {
    mocks.panelsById = {
      p1: { id: "p1", title: "Claude", detectedAgentId: "claude", location: "grid" },
    };

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
    mocks.panelsById = { p1: pane };
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
    mocks.panelsById = panels;
    expect(resolveMcpConfirmRequester(identity)).toEqual({ identity });
  });

  it("does not resolve an id off Object.prototype", () => {
    const own = { kind: "pane", terminalId: "constructor" } as const;
    expect(resolveMcpConfirmRequester(own)).toEqual({ identity: own });
  });

  it("keeps the worktree's id when no worktree store is mounted to name it", () => {
    mocks.viewStoreThrows = true;
    mocks.panelsById = { p1: { id: "p1", title: "zsh", worktreeId: "wt-1", location: "grid" } };

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
    mocks.panelsById = {
      "t-b": {
        id: "t-b",
        kind: "terminal",
        title: "Claude",
        detectedAgentId: "claude",
        agentState: "working",
        lastObservedTitle: "✳ review the auth changes",
        location: "grid",
      },
    };
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
  });

  it("changes nothing for a session whose lane has gone", async () => {
    useHelpPanelStore.setState({ isOpen: false, activeSlot: 0, sessions: { 0: lane("t-a", "x") } });

    await expect(showMcpRequester({ kind: "assistant", helpSessionId: "help-b" })).resolves.toBe(
      false
    );
    expect(useHelpPanelStore.getState().isOpen).toBe(false);
  });
});
