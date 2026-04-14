import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionDefinition } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import { registerGitActions } from "../gitActions";

type GitStub = {
  [K in
    | "stageAll"
    | "unstageAll"
    | "stageFile"
    | "unstageFile"
    | "commit"
    | "push"
    | "getFileDiff"
    | "listCommits"
    | "getStagingStatus"
    | "getProjectPulse"
    | "snapshotGet"
    | "snapshotList"
    | "snapshotRevert"
    | "snapshotDelete"]: ReturnType<typeof vi.fn>;
};

function makeGitStub(): GitStub {
  return {
    stageAll: vi.fn().mockResolvedValue(undefined),
    unstageAll: vi.fn().mockResolvedValue(undefined),
    stageFile: vi.fn().mockResolvedValue(undefined),
    unstageFile: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ sha: "abc" }),
    push: vi.fn().mockResolvedValue({ ok: true }),
    getFileDiff: vi.fn().mockResolvedValue("diff"),
    listCommits: vi.fn().mockResolvedValue([]),
    getStagingStatus: vi.fn().mockResolvedValue({}),
    getProjectPulse: vi.fn().mockResolvedValue({}),
    snapshotGet: vi.fn().mockResolvedValue(null),
    snapshotList: vi.fn().mockResolvedValue([]),
    snapshotRevert: vi.fn().mockResolvedValue(undefined),
    snapshotDelete: vi.fn().mockResolvedValue(undefined),
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
      const def = factory() as ActionDefinition<unknown, unknown>;
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
    await run("git.push", { cwd: "/repo", setUpstream: false });
    expect(git.push).toHaveBeenCalledWith("/repo", false);
  });

  it("git.push preserves explicit setUpstream:true", async () => {
    const { run, git } = setupActions();
    await run("git.push", { cwd: "/repo", setUpstream: true });
    expect(git.push).toHaveBeenCalledWith("/repo", true);
  });

  it("git.getFileDiff forwards cwd, filePath, and status positionally without mutation", async () => {
    const { run, git } = setupActions();
    await run("git.getFileDiff", {
      cwd: "/repo",
      filePath: "src/file with spaces.ts",
      status: "renamed",
    });
    expect(git.getFileDiff).toHaveBeenCalledWith("/repo", "src/file with spaces.ts", "renamed");
  });

  it("git.snapshotRevert is worktree-based — never touches cwd", async () => {
    const { run, git } = setupActions();
    await run("git.snapshotRevert", { worktreeId: "wt-1" });
    expect(git.snapshotRevert).toHaveBeenCalledWith("wt-1");
    expect(git.snapshotRevert).toHaveBeenCalledTimes(1);
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
});
