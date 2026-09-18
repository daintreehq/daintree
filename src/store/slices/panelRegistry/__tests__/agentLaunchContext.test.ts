import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";

const { liveContext, worktrees } = vi.hoisted(() => ({
  liveContext: { current: {} as ActionContext },
  worktrees: new Map<
    string,
    { name: string; path: string; branch?: string; isMainWorktree?: boolean }
  >(),
}));

vi.mock("@/services/ActionService", () => ({
  getActionContext: () => ({ ...liveContext.current }),
}));

vi.mock("@/store/storeAccessors", () => ({
  getWorktreeIdentityById: (id: string) => worktrees.get(id),
}));

const { buildAgentLaunchContext } = await import("../agentLaunchContext");

describe("buildAgentLaunchContext (#12486)", () => {
  beforeEach(() => {
    worktrees.clear();
    liveContext.current = {
      projectId: "p1",
      projectName: "Project",
      projectPath: "/repo",
      activeWorktreeId: "wt-selected",
      activeWorktreeName: "selected",
      activeWorktreePath: "/repo/selected",
      activeWorktreeBranch: "feature/selected",
      activeWorktreeIsMain: false,
      focusedWorktreeId: "wt-selected",
      focusedTerminalId: "someone-elses-terminal",
      focusedTerminalKind: "browser",
      focusedTerminalTitle: "Docs",
      isSettingsOpen: true,
    };
    worktrees.set("wt-pane", {
      name: "pane",
      path: "/repo/pane",
      branch: "feature/pane",
      isMainWorktree: false,
    });
  });

  it("describes the worktree the pane spawns into, not the one selected at launch", () => {
    // A recipe or an MCP launch routinely targets a worktree the user is not
    // looking at; "current worktree" must mean the pane's own.
    const context = buildAgentLaunchContext({
      launchAgentId: "claude",
      terminalId: "pane-1",
      title: "Claude",
      worktreeId: "wt-pane",
    });

    expect(context).toMatchObject({
      projectId: "p1",
      projectName: "Project",
      projectPath: "/repo",
      activeWorktreeId: "wt-pane",
      activeWorktreeName: "pane",
      activeWorktreePath: "/repo/pane",
      activeWorktreeBranch: "feature/pane",
      activeWorktreeIsMain: false,
      focusedWorktreeId: "wt-pane",
    });
  });

  it("makes the pane itself the focused terminal", () => {
    const context = buildAgentLaunchContext({
      launchAgentId: "claude",
      terminalId: "pane-1",
      title: "Claude",
    });

    expect(context).toMatchObject({
      focusedTerminalId: "pane-1",
      focusedTerminalKind: "terminal",
      focusedTerminalTitle: "Claude",
    });
  });

  it("drops isSettingsOpen, which a snapshot would carry stale for the pane's whole life", () => {
    const context = buildAgentLaunchContext({ launchAgentId: "claude", terminalId: "pane-1" });

    expect(context).toBeDefined();
    expect("isSettingsOpen" in context!).toBe(false);
  });

  it("keeps the live worktree when the spawn names none", () => {
    const context = buildAgentLaunchContext({ launchAgentId: "claude", terminalId: "pane-1" });

    expect(context).toMatchObject({
      activeWorktreeId: "wt-selected",
      activeWorktreePath: "/repo/selected",
    });
  });

  it("names an unknown destination worktree without borrowing the selected one's details", () => {
    // Borrowing the selected worktree's path would point "current worktree"
    // somewhere the pane is not.
    const context = buildAgentLaunchContext({
      launchAgentId: "claude",
      terminalId: "pane-1",
      worktreeId: "wt-unknown",
    });

    expect(context!.activeWorktreeId).toBe("wt-unknown");
    expect(context!.activeWorktreePath).toBeUndefined();
    expect(context!.activeWorktreeName).toBeUndefined();
  });

  it.each([["codex"], ["daintree-assistant"], [undefined]])(
    "returns undefined for %s, whose spawn payload stays unchanged",
    (launchAgentId) => {
      // The assistant's context comes from its own caller (#10647), and no
      // other agent is bound to its launch workspace.
      expect(buildAgentLaunchContext({ launchAgentId, terminalId: "pane-1" })).toBeUndefined();
    }
  );
});
