import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import { registerGitActions } from "../gitActions";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";

/**
 * `git.push` now awaits a deferred-Promise confirm gate (#8242). In a unit
 * context there is no mounted `GitPushConfirmDialog`, so resolve the pending
 * request explicitly once `run()` has registered it.
 */
async function resolvePushConfirm(ok: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(useGitPushConfirmStore.getState().pendingConfirm).not.toBeNull();
  });
  useGitPushConfirmStore.getState().resolveConfirmation(ok);
}

/** Same deferred-Promise gate, for `git.pullRebase` (#8242). */
async function resolvePullRebaseConfirm(ok: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).not.toBeNull();
  });
  useGitPullRebaseConfirmStore.getState().resolveConfirmation(ok);
}

type GitStub = {
  [
    K in
      | "stageAll"
      | "unstageAll"
      | "stageFile"
      | "unstageFile"
      | "commit"
      | "push"
      | "pullRebase"
      | "getFileDiff"
      | "listCommits"
      | "getStagingStatus"
      | "getProjectPulse"
  ]: ReturnType<typeof vi.fn>;
};

function makeGitStub(): GitStub {
  return {
    stageAll: vi.fn().mockResolvedValue(undefined),
    unstageAll: vi.fn().mockResolvedValue(undefined),
    stageFile: vi.fn().mockResolvedValue(undefined),
    unstageFile: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ sha: "abc" }),
    push: vi.fn().mockResolvedValue({ ok: true }),
    pullRebase: vi.fn().mockResolvedValue(undefined),
    getFileDiff: vi.fn().mockResolvedValue("diff"),
    listCommits: vi.fn().mockResolvedValue([]),
    getStagingStatus: vi.fn().mockResolvedValue({}),
    getProjectPulse: vi.fn().mockResolvedValue({}),
  };
}

function setupActions(): {
  run: (id: string, args?: unknown, ctx?: Record<string, unknown>) => Promise<unknown>;
  git: GitStub;
} {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerGitActions(actions, callbacks);
  const git = makeGitStub();
  return {
    git,
    run: async (id, args, ctx) => {
      const factory = actions.get(id);
      if (!factory) throw new Error(`missing ${id}`);
      const def = factory() as AnyActionDefinition;
      Object.defineProperty(globalThis, "window", {
        value: { electron: { git } },
        configurable: true,
        writable: true,
      });
      return def.run(args, (ctx ?? {}) as never);
    },
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
  // Both stores are module singletons. A test that fails mid-gate would
  // otherwise leave a pending request behind and contaminate the next one.
  if (useGitPushConfirmStore.getState().pendingConfirm) {
    useGitPushConfirmStore.getState().resolveConfirmation(false);
  }
  if (useGitPullRebaseConfirmStore.getState().pendingConfirm) {
    useGitPullRebaseConfirmStore.getState().resolveConfirmation(false);
  }
});

describe("gitActions adversarial", () => {
  it("git.stageAll uses ctx.activeWorktreePath when no cwd arg is provided", async () => {
    const { run, git } = setupActions();
    await run("git.stageAll", undefined, { activeWorktreePath: "/repo" });
    expect(git.stageAll).toHaveBeenCalledWith("/repo");
  });

  it("git.stageAll rejects cleanly when neither arg nor context has a cwd", async () => {
    const { run, git } = setupActions();
    await expect(run("git.stageAll")).rejects.toThrow("No active worktree");
    expect(git.stageAll).not.toHaveBeenCalled();
  });

  it("git.commit rejects whitespace-only messages rather than forwarding them to git", async () => {
    const { run, git } = setupActions();

    await expect(run("git.commit", { cwd: "/repo", message: "   " })).rejects.toThrow(
      /Commit message/
    );

    expect(git.commit).not.toHaveBeenCalled();
  });

  it("git.commit rejects newline-only messages", async () => {
    const { run, git } = setupActions();
    await expect(run("git.commit", { cwd: "/repo", message: "\n\n\t" })).rejects.toThrow(
      /Commit message/
    );
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("git.commit falls back to ctx.activeWorktreePath when cwd is not supplied", async () => {
    const { run, git } = setupActions();
    await run("git.commit", { message: "feat: x" }, { activeWorktreePath: "/repo" });
    expect(git.commit).toHaveBeenCalledWith("/repo", "feat: x");
  });

  it("git.push preserves explicit setUpstream:false (doesn't convert it to undefined)", async () => {
    const { run, git } = setupActions();
    const p = run("git.push", { cwd: "/repo", setUpstream: false });
    await resolvePushConfirm(true);
    await p;
    expect(git.push).toHaveBeenCalledWith("/repo", false);
  });

  it("git.push preserves explicit setUpstream:true", async () => {
    const { run, git } = setupActions();
    const p = run("git.push", { cwd: "/repo", setUpstream: true });
    await resolvePushConfirm(true);
    await p;
    expect(git.push).toHaveBeenCalledWith("/repo", true);
  });

  it("git.push does not reach IPC when the confirm gate is declined", async () => {
    const { run, git } = setupActions();
    const p = run("git.push", { cwd: "/repo" });
    await resolvePushConfirm(false);
    await p;
    expect(git.push).not.toHaveBeenCalled();
  });

  it("git.pullRebase fires IPC only after the confirm gate is accepted", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", { cwd: "/repo" });
    expect(git.pullRebase).not.toHaveBeenCalled();
    await resolvePullRebaseConfirm(true);
    await p;
    expect(git.pullRebase).toHaveBeenCalledWith("/repo");
  });

  it("git.pullRebase does not reach IPC when the confirm gate is declined", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", { cwd: "/repo" });
    await resolvePullRebaseConfirm(false);
    await p;
    expect(git.pullRebase).not.toHaveBeenCalled();
  });

  // #11538: an agent dispatch reaching run() already cleared ActionService's
  // host-attested confirm gate against the MCP bridge's own modal. The deferred
  // store here resolves only from a renderer dialog, which a headless MCP client
  // can never click — so awaiting it again hangs the push forever.
  it("git.push skips the renderer confirm store entirely for agent dispatch", async () => {
    const { run, git } = setupActions();
    await run("git.push", { cwd: "/repo" }, { dispatchSource: "agent" });
    expect(git.push).toHaveBeenCalledWith("/repo", undefined);
    expect(useGitPushConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("git.pullRebase skips the renderer confirm store entirely for agent dispatch", async () => {
    const { run, git } = setupActions();
    await run("git.pullRebase", { cwd: "/repo" }, { dispatchSource: "agent" });
    expect(git.pullRebase).toHaveBeenCalledWith("/repo");
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("git.push carries setUpstream through the agent bypass unchanged", async () => {
    const { run, git } = setupActions();
    await run("git.push", { cwd: "/repo", setUpstream: false }, { dispatchSource: "agent" });
    expect(git.push).toHaveBeenCalledWith("/repo", false);
  });

  // The bypass is keyed to "agent" alone — no other source has been through the
  // MCP confirm, so widening this to any non-foreground source would let plugin
  // dispatch push with no confirmation at all.
  it("git.push still gates plugin dispatch on the confirm store", async () => {
    const { run, git } = setupActions();
    const p = run("git.push", { cwd: "/repo" }, { dispatchSource: "plugin" });
    await resolvePushConfirm(false);
    await p;
    expect(git.push).not.toHaveBeenCalled();
  });

  it("git.pullRebase still gates user dispatch on the confirm store", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", { cwd: "/repo" }, { dispatchSource: "user" });
    await resolvePullRebaseConfirm(true);
    await p;
    expect(git.pullRebase).toHaveBeenCalledWith("/repo");
  });

  it("git.pullRebase still gates plugin dispatch on the confirm store", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", { cwd: "/repo" }, { dispatchSource: "plugin" });
    await resolvePullRebaseConfirm(false);
    await p;
    expect(git.pullRebase).not.toHaveBeenCalled();
  });

  // A reverted bypass would otherwise only surface as a suite timeout. Assert
  // the store stays empty synchronously, before awaiting, so the failure is
  // immediate and legible.
  it("git.push registers no pending confirm at all for agent dispatch", async () => {
    const { run, git } = setupActions();
    const p = run("git.push", { cwd: "/repo" }, { dispatchSource: "agent" });
    expect(useGitPushConfirmStore.getState().pendingConfirm).toBeNull();
    await p;
    expect(git.push).toHaveBeenCalled();
  });

  it("git.pullRebase registers no pending confirm at all for agent dispatch", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", { cwd: "/repo" }, { dispatchSource: "agent" });
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).toBeNull();
    await p;
    expect(git.pullRebase).toHaveBeenCalled();
  });

  it("git.pullRebase falls back to ctx.activeWorktreePath when no cwd arg is given", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", undefined, { activeWorktreePath: "/repo" });
    await resolvePullRebaseConfirm(true);
    await p;
    expect(git.pullRebase).toHaveBeenCalledWith("/repo");
  });

  it("git.getFileDiff forwards cwd, filePath, and status positionally without mutation", async () => {
    const { run, git } = setupActions();
    await run("git.getFileDiff", {
      cwd: "/repo",
      filePath: "src/file with spaces.ts",
      status: "renamed",
    });
    expect(git.getFileDiff).toHaveBeenCalledWith(
      "/repo",
      "src/file with spaces.ts",
      "renamed",
      undefined
    );
  });

  it("git.stageFile rejects when filePath is empty — schema guard", async () => {
    const { run, git } = setupActions();
    // Schema allows empty string; this documents current behavior.
    // If it becomes a validation gate, this assertion should flip.
    await run("git.stageFile", { cwd: "/repo", filePath: "" });
    expect(git.stageFile).toHaveBeenCalledWith("/repo", "");
  });

  it("git.commit rejects missing message (undefined) before touching git", async () => {
    const { run, git } = setupActions();
    await expect(run("git.commit", { cwd: "/repo" })).rejects.toThrow(/Commit message is required/);
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("git.getStagingStatus falls back to ctx.activeWorktreePath when no args", async () => {
    const { run, git } = setupActions();
    await run("git.getStagingStatus", undefined, { activeWorktreePath: "/repo" });
    expect(git.getStagingStatus).toHaveBeenCalledWith("/repo");
  });

  it("git.getStagingStatus prefers explicit cwd over ctx", async () => {
    const { run, git } = setupActions();
    await run("git.getStagingStatus", { cwd: "/explicit" }, { activeWorktreePath: "/ctx" });
    expect(git.getStagingStatus).toHaveBeenCalledWith("/explicit");
  });

  it("git.getStagingStatus throws when no cwd and no ctx", async () => {
    const { run } = setupActions();
    await expect(run("git.getStagingStatus")).rejects.toThrow("No active worktree");
  });

  it("git.getFileDiff falls back to ctx.activeWorktreePath", async () => {
    const { run, git } = setupActions();
    await run(
      "git.getFileDiff",
      { filePath: "x.ts", status: "modified" },
      { activeWorktreePath: "/repo" }
    );
    expect(git.getFileDiff).toHaveBeenCalledWith("/repo", "x.ts", "modified", undefined);
  });

  it("git.listCommits falls back to ctx.activeWorktreePath and forwards filters", async () => {
    const { run, git } = setupActions();
    await run("git.listCommits", { search: "fix", limit: 5 }, { activeWorktreePath: "/repo" });
    expect(git.listCommits).toHaveBeenCalledWith({ cwd: "/repo", search: "fix", limit: 5 });
  });

  it("git.stageFile falls back to ctx.activeWorktreePath", async () => {
    const { run, git } = setupActions();
    await run("git.stageFile", { filePath: "a.ts" }, { activeWorktreePath: "/repo" });
    expect(git.stageFile).toHaveBeenCalledWith("/repo", "a.ts");
  });

  it("git.unstageFile falls back to ctx.activeWorktreePath", async () => {
    const { run, git } = setupActions();
    await run("git.unstageFile", { filePath: "a.ts" }, { activeWorktreePath: "/repo" });
    expect(git.unstageFile).toHaveBeenCalledWith("/repo", "a.ts");
  });

  it("git.unstageAll falls back to ctx.activeWorktreePath", async () => {
    const { run, git } = setupActions();
    await run("git.unstageAll", undefined, { activeWorktreePath: "/repo" });
    expect(git.unstageAll).toHaveBeenCalledWith("/repo");
  });

  it("git.getProjectPulse falls back to ctx.activeWorktreeId and defaults rangeDays to 60", async () => {
    const { run, git } = setupActions();
    await run("git.getProjectPulse", undefined, { activeWorktreeId: "wt-1" });
    expect(git.getProjectPulse).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "wt-1", rangeDays: 60 })
    );
  });

  it("git.getProjectPulse preserves explicit rangeDays and forwards include flags", async () => {
    const { run, git } = setupActions();
    await run(
      "git.getProjectPulse",
      { worktreeId: "wt-2", rangeDays: 180, includeDelta: true },
      { activeWorktreeId: "wt-ctx" }
    );
    expect(git.getProjectPulse).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "wt-2", rangeDays: 180, includeDelta: true })
    );
  });

  it("git.getProjectPulse preserves explicit rangeDays even when worktreeId falls back to ctx", async () => {
    const { run, git } = setupActions();
    await run("git.getProjectPulse", { rangeDays: 120 }, { activeWorktreeId: "wt-ctx" });
    expect(git.getProjectPulse).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "wt-ctx", rangeDays: 120 })
    );
  });
});
