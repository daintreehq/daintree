import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";

const liveContext = vi.hoisted(() => ({ current: {} as ActionContext }));

vi.mock("@/services/ActionService", () => ({
  getActionContext: () => ({ ...liveContext.current }),
}));

const { buildAgentLaunchContext } = await import("../agentLaunchContext");

describe("buildAgentLaunchContext (#12486)", () => {
  beforeEach(() => {
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
  });

  it("pins the worktree the pane spawns into, not the one selected at launch", () => {
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
      focusedWorktreeId: "wt-pane",
    });
  });

  it("carries no worktree description, which is resolved per dispatch instead", () => {
    // Captured here it could be missing (a pane restored before its view's
    // worktrees load) or go stale (a branch switch) for the pane's whole life —
    // and a selected worktree's path beside the pane's id would be worse.
    const context = buildAgentLaunchContext({
      launchAgentId: "claude",
      terminalId: "pane-1",
      worktreeId: "wt-pane",
    })!;

    expect(context.activeWorktreeName).toBeUndefined();
    expect(context.activeWorktreePath).toBeUndefined();
    expect(context.activeWorktreeBranch).toBeUndefined();
    expect(context.activeWorktreeIsMain).toBeUndefined();
  });

  it("carries no worktree identity when the spawn names none", () => {
    // A pane filed to no worktree must fall back to the view's live selection
    // per dispatch, not replay whichever worktree happened to be selected when
    // it launched — a worktree it has no relationship with.
    const context = buildAgentLaunchContext({ launchAgentId: "claude", terminalId: "pane-1" })!;

    expect("activeWorktreeId" in context).toBe(false);
    expect("focusedWorktreeId" in context).toBe(false);
    expect(context.activeWorktreeName).toBeUndefined();
    expect(context.activeWorktreePath).toBeUndefined();
    expect(context.activeWorktreeBranch).toBeUndefined();
    expect(context.activeWorktreeIsMain).toBeUndefined();
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

  it.each([["codex"], ["daintree-assistant"], [undefined]])(
    "returns undefined for %s, whose spawn payload stays unchanged",
    (launchAgentId) => {
      // The assistant's context comes from its own caller (#10647), and no
      // other agent is bound to its launch workspace.
      expect(buildAgentLaunchContext({ launchAgentId, terminalId: "pane-1" })).toBeUndefined();
    }
  );
});
