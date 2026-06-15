import { describe, expect, it, vi } from "vitest";
import type { SimpleGit } from "simple-git";
import {
  PluginHostGit,
  PluginGitCommitMessageRequiredError,
  PluginGitPathNotAllowedError,
} from "../pluginHostGit.js";
import type { WorktreeChanges } from "../../../../shared/types/index.js";

function fakeGit(overrides: Partial<Record<keyof SimpleGit, unknown>> = {}): {
  git: SimpleGit;
  diff: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  raw: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
} {
  const diff = vi.fn().mockResolvedValue("");
  const add = vi.fn().mockResolvedValue(undefined);
  const raw = vi.fn().mockResolvedValue("");
  const commit = vi.fn().mockResolvedValue({ commit: "abc123" });
  const git = { diff, add, raw, commit, ...overrides } as unknown as SimpleGit;
  return { git, diff, add, raw, commit };
}

const emptyChanges: WorktreeChanges = {
  changes: [],
  totalChanges: 0,
} as unknown as WorktreeChanges;

describe("PluginHostGit", () => {
  it("commit refuses an empty message without mutating (no silent fallback)", async () => {
    const { git, commit, diff } = fakeGit();
    const host = new PluginHostGit("p", async () => git);

    await expect(host.commit("/wt", { message: "" })).rejects.toBeInstanceOf(
      PluginGitCommitMessageRequiredError
    );
    await expect(host.commit("/wt", { message: "   " })).rejects.toBeInstanceOf(
      PluginGitCommitMessageRequiredError
    );
    // Neither the diff-preview nor the commit ran — the guard fired before any work.
    expect(diff).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("commit computes the staged diff as a change preview before committing", async () => {
    const callOrder: string[] = [];
    const diff = vi.fn(async () => {
      callOrder.push("diff");
      return "diff --git a/x b/x\n+hello";
    });
    const commit = vi.fn(async () => {
      callOrder.push("commit");
      return { commit: "deadbee" };
    });
    const git = { diff, commit } as unknown as SimpleGit;
    const host = new PluginHostGit("p", async () => git);

    const result = await host.commit("/wt", { message: "feat: thing" });

    // The preview (staged diff) is computed BEFORE the commit — the D2 safeguard.
    expect(callOrder).toEqual(["diff", "commit"]);
    expect(diff).toHaveBeenCalledWith(["--cached", "--no-ext-diff", "--no-textconv", "--no-color"]);
    expect(result.commit).toBe("deadbee");
    expect(result.message).toBe("feat: thing");
    expect(result.preview).toContain("+hello");
  });

  it("add stages all changes when no paths are given (with -- end-of-options)", async () => {
    const { git, raw } = fakeGit();
    const host = new PluginHostGit("p", async () => git);
    await host.add("/wt");
    expect(raw).toHaveBeenCalledWith(["add", "--", "."]);
  });

  it("add filters non-string path entries and forces -- end-of-options", async () => {
    const { git, raw } = fakeGit();
    const host = new PluginHostGit("p", async () => git);
    await host.add("/wt", ["a.ts", "", "b.ts"]);
    expect(raw).toHaveBeenCalledWith(["add", "--", "a.ts", "b.ts"]);
  });

  it("add rejects an escaping or option-injecting pathspec", async () => {
    const { git, raw } = fakeGit();
    const host = new PluginHostGit("p", async () => git);
    // Traversal, absolute, pathspec magic, and git OPTION injection (-A/--all
    // would otherwise stage the whole repo, escaping the contained worktree).
    for (const escape of ["../outside.ts", "/etc/passwd", ":(top)secret", "-A", "--all"]) {
      await expect(host.add("/wt", [escape])).rejects.toBeInstanceOf(PluginGitPathNotAllowedError);
    }
    // None of the rejected pathspecs reach git.
    expect(raw).not.toHaveBeenCalled();
  });

  it("diff rejects an escaping pathspec before shelling out", async () => {
    const { git, diff } = fakeGit();
    const host = new PluginHostGit("p", async () => git);
    await expect(host.diff("/wt", "../outside.ts")).rejects.toBeInstanceOf(
      PluginGitPathNotAllowedError
    );
    expect(diff).not.toHaveBeenCalled();
  });

  it("status projects the changes provider output", async () => {
    const changes: WorktreeChanges = {
      changes: [
        { path: "b.ts", status: "modified" },
        { path: "a.ts", status: "added" },
      ],
      totalChanges: 2,
    } as unknown as WorktreeChanges;
    const host = new PluginHostGit(
      "p",
      async () => fakeGit().git,
      async () => changes
    );
    const status = await host.status("/wt");
    expect(status.worktreePath).toBe("/wt");
    expect(status.changedFileCount).toBe(2);
    // Projected + sorted by path.
    expect(status.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("status returns an empty set when the provider has no changes", async () => {
    const host = new PluginHostGit(
      "p",
      async () => fakeGit().git,
      async () => emptyChanges
    );
    const status = await host.status("/wt");
    expect(status.changedFileCount).toBe(0);
    expect(status.files).toEqual([]);
  });

  describe("AbortSignal", () => {
    it("commit does NOT create the commit when the signal aborts during the staged-diff", async () => {
      // The destructive-mutation regression: an abort that fires while the
      // change-preview diff is being computed must stop the commit, not let it
      // proceed (the re-check between diff and commit).
      const controller = new AbortController();
      const diff = vi.fn(async () => {
        controller.abort();
        return "staged diff";
      });
      const commit = vi.fn(async () => ({ commit: "deadbee" }));
      const git = { diff, commit } as unknown as SimpleGit;
      const host = new PluginHostGit("p", async () => git);

      await expect(
        host.commit("/wt", { message: "feat: thing" }, controller.signal)
      ).rejects.toThrow();
      expect(diff).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
    });

    it("commit rejects before any work when the signal is already aborted", async () => {
      const { git, diff, commit } = fakeGit();
      const host = new PluginHostGit("p", async () => git);
      await expect(host.commit("/wt", { message: "msg" }, AbortSignal.abort())).rejects.toThrow();
      expect(diff).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    });

    it("status rejects an already-aborted signal before reading", async () => {
      const provider = vi.fn(async () => emptyChanges);
      const host = new PluginHostGit("p", async () => fakeGit().git, provider);
      await expect(host.status("/wt", AbortSignal.abort())).rejects.toThrow();
      expect(provider).not.toHaveBeenCalled();
    });

    it("add rejects an already-aborted signal before staging", async () => {
      const { git, raw } = fakeGit();
      const host = new PluginHostGit("p", async () => git);
      await expect(host.add("/wt", ["a.ts"], AbortSignal.abort())).rejects.toThrow();
      expect(raw).not.toHaveBeenCalled();
    });

    it("commit proceeds normally when the signal is not aborted", async () => {
      const { git, commit } = fakeGit();
      const host = new PluginHostGit("p", async () => git);
      const result = await host.commit("/wt", { message: "msg" }, new AbortController().signal);
      expect(commit).toHaveBeenCalledWith("msg");
      expect(result.message).toBe("msg");
    });
  });
});
