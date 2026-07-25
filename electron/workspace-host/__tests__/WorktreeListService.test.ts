import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SimpleGit } from "simple-git";
import path from "path";
import { WorktreeListService } from "../WorktreeListService.js";

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn((p: string) => `${p}/.git`),
}));

function makePorcelain(...entries: string[]): string {
  return entries.join("\n\n") + "\n";
}

function worktreeEntry(
  path: string,
  opts: {
    branch?: string;
    bare?: boolean;
    detached?: boolean;
    head?: string;
    locked?: string | true;
    prunable?: string | true;
  } = {}
): string {
  const lines = [`worktree ${path}`];
  if (opts.head) lines.push(`HEAD ${opts.head}`);
  if (opts.bare) {
    lines.push("bare");
  } else if (opts.detached) {
    lines.push("detached");
  } else if (opts.branch) {
    lines.push(`branch refs/heads/${opts.branch}`);
  }
  if (opts.locked !== undefined) {
    lines.push(opts.locked === true ? "locked" : `locked ${opts.locked}`);
  }
  if (opts.prunable !== undefined) {
    lines.push(opts.prunable === true ? "prunable" : `prunable ${opts.prunable}`);
  }
  return lines.join("\n");
}

describe("WorktreeListService", () => {
  let service: WorktreeListService;
  let mockGit: SimpleGit;

  beforeEach(() => {
    service = new WorktreeListService();
    mockGit = { raw: vi.fn() } as unknown as SimpleGit;
  });

  describe("list", () => {
    it("marks the first entry as main worktree regardless of projectRootPath", async () => {
      const output = makePorcelain(
        worktreeEntry("/repo/main", { branch: "main", head: "aaa111" }),
        worktreeEntry("/repo/feature", { branch: "feature/foo", head: "bbb222" })
      );
      vi.mocked(mockGit.raw).mockResolvedValue(output);
      service.setGit(mockGit, "/repo/feature");

      const result = await service.list({ forceRefresh: true });

      expect(result).toHaveLength(2);
      expect(result[0].isMainWorktree).toBe(true);
      expect(result[0].path).toBe("/repo/main");
      expect(result[1].isMainWorktree).toBe(false);
      expect(result[1].path).toBe("/repo/feature");
    });

    it("marks single entry as main worktree", async () => {
      const output = makePorcelain(worktreeEntry("/repo/main", { branch: "main", head: "aaa111" }));
      vi.mocked(mockGit.raw).mockResolvedValue(output);
      service.setGit(mockGit, "/repo/main");

      const result = await service.list({ forceRefresh: true });

      expect(result).toHaveLength(1);
      expect(result[0].isMainWorktree).toBe(true);
    });

    it("handles porcelain output without trailing newline", async () => {
      const output =
        worktreeEntry("/repo/main", { branch: "main", head: "aaa111" }) +
        "\n\n" +
        worktreeEntry("/repo/feature", { branch: "feat", head: "bbb222" });
      vi.mocked(mockGit.raw).mockResolvedValue(output);
      service.setGit(mockGit, "/other/path");

      const result = await service.list({ forceRefresh: true });

      expect(result).toHaveLength(2);
      expect(result[0].isMainWorktree).toBe(true);
      expect(result[1].isMainWorktree).toBe(false);
    });

    it("marks first entry as main when projectRootPath is null", async () => {
      const output = makePorcelain(worktreeEntry("/repo/main", { branch: "main", head: "aaa111" }));
      vi.mocked(mockGit.raw).mockResolvedValue(output);
      service.setGit(mockGit, null);

      const result = await service.list({ forceRefresh: true });

      expect(result).toHaveLength(1);
      expect(result[0].isMainWorktree).toBe(true);
    });

    it("marks detached HEAD first entry as main", async () => {
      const output = makePorcelain(
        worktreeEntry("/repo/main", { detached: true, head: "abc123" }),
        worktreeEntry("/repo/feature", { branch: "feature/bar", head: "def456" })
      );
      vi.mocked(mockGit.raw).mockResolvedValue(output);
      service.setGit(mockGit, "/repo/feature");

      const result = await service.list({ forceRefresh: true });

      expect(result).toHaveLength(2);
      expect(result[0].isMainWorktree).toBe(true);
      expect(result[0].isDetached).toBe(true);
      expect(result[1].isMainWorktree).toBe(false);
    });

    it("marks bare first entry as main", async () => {
      const output = makePorcelain(
        worktreeEntry("/repo/bare", { bare: true }),
        worktreeEntry("/repo/feature", { branch: "feature/baz", head: "fff999" })
      );
      vi.mocked(mockGit.raw).mockResolvedValue(output);
      service.setGit(mockGit, "/repo/feature");

      const result = await service.list({ forceRefresh: true });

      expect(result).toHaveLength(2);
      expect(result[0].isMainWorktree).toBe(true);
      expect(result[0].bare).toBe(true);
      expect(result[1].isMainWorktree).toBe(false);
    });

    it("parses locked line without reason", async () => {
      const output = makePorcelain(
        worktreeEntry("/repo/main", { branch: "main", head: "aaa111" }),
        worktreeEntry("/repo/feature", {
          branch: "feature/foo",
          head: "bbb222",
          locked: true,
        })
      );
      vi.mocked(mockGit.raw).mockResolvedValue(output);
      service.setGit(mockGit, "/repo/main");

      const result = await service.list({ forceRefresh: true });

      expect(result).toHaveLength(2);
      expect(result[1].isLocked).toBe(true);
      expect(result[1].lockReason).toBeUndefined();
    });

    it("parses locked line with reason", async () => {
      const output = makePorcelain(
        worktreeEntry("/repo/main", { branch: "main", head: "aaa111" }),
        worktreeEntry("/repo/feature", {
          branch: "feature/foo",
          head: "bbb222",
          locked: "manual lock",
        })
      );
      vi.mocked(mockGit.raw).mockResolvedValue(output);
      service.setGit(mockGit, "/repo/main");

      const result = await service.list({ forceRefresh: true });

      expect(result).toHaveLength(2);
      expect(result[1].isLocked).toBe(true);
      expect(result[1].lockReason).toBe("manual lock");
    });

    it("parses prunable line without reason", async () => {
      const output = makePorcelain(
        worktreeEntry("/repo/main", { branch: "main", head: "aaa111" }),
        worktreeEntry("/repo/feature", {
          branch: "feature/foo",
          head: "bbb222",
          prunable: true,
        })
      );
      vi.mocked(mockGit.raw).mockResolvedValue(output);
      service.setGit(mockGit, "/repo/main");

      const result = await service.list({ forceRefresh: true });

      expect(result).toHaveLength(2);
      expect(result[1].isPrunable).toBe(true);
      expect(result[1].prunableReason).toBeUndefined();
    });

    it("parses prunable line with reason", async () => {
      const output = makePorcelain(
        worktreeEntry("/repo/main", { branch: "main", head: "aaa111" }),
        worktreeEntry("/repo/feature", {
          branch: "feature/foo",
          head: "bbb222",
          prunable: "gitdir file points to non-existent location",
        })
      );
      vi.mocked(mockGit.raw).mockResolvedValue(output);
      service.setGit(mockGit, "/repo/main");

      const result = await service.list({ forceRefresh: true });

      expect(result).toHaveLength(2);
      expect(result[1].isPrunable).toBe(true);
      expect(result[1].prunableReason).toBe("gitdir file points to non-existent location");
    });

    it("does not leak locked/prunable state to the next worktree entry", async () => {
      const output = makePorcelain(
        worktreeEntry("/repo/main", { branch: "main", head: "aaa111", locked: "manual" }),
        worktreeEntry("/repo/feature", { branch: "feature/foo", head: "bbb222" })
      );
      vi.mocked(mockGit.raw).mockResolvedValue(output);
      service.setGit(mockGit, "/repo/main");

      const result = await service.list({ forceRefresh: true });

      expect(result).toHaveLength(2);
      expect(result[0].isLocked).toBe(true);
      expect(result[1].isLocked).toBeUndefined();
      expect(result[1].lockReason).toBeUndefined();
      expect(result[1].isPrunable).toBeUndefined();
    });
  });

  describe("mapToWorktrees", () => {
    it("uses directory name for main worktree display name", async () => {
      const raw = [
        {
          path: "/projects/my-repo",
          branch: "main",
          bare: false,
          isMainWorktree: true,
        },
        {
          path: "/projects/my-repo-feature",
          branch: "feature/cool",
          bare: false,
          isMainWorktree: false,
        },
      ];

      const worktrees = await service.mapToWorktrees(raw);

      expect(worktrees[0].name).toBe("my-repo");
      expect(worktrees[1].name).toBe("feature/cool");
    });

    it("normalizes listed paths before using them as worktree IDs", async () => {
      const basePath = path.resolve("/projects/my-repo");
      const rawPath = `${basePath}${path.sep}..${path.sep}my-repo-feature`;
      const expectedPath = path.resolve(basePath, "..", "my-repo-feature");
      const raw = [
        {
          path: rawPath,
          branch: "feature/cool",
          bare: false,
          isMainWorktree: false,
        },
      ];

      const worktrees = await service.mapToWorktrees(raw);

      expect(worktrees[0].id).toBe(expectedPath);
      expect(worktrees[0].path).toBe(expectedPath);
      expect(worktrees[0].gitDir).toBe(`${expectedPath}/.git`);
    });

    it("propagates locked/prunable fields to the mapped Worktree", async () => {
      const raw = [
        {
          path: "/projects/my-repo",
          branch: "main",
          bare: false,
          isMainWorktree: true,
        },
        {
          path: "/projects/my-repo-feature",
          branch: "feature/cool",
          bare: false,
          isMainWorktree: false,
          isLocked: true,
          lockReason: "CI",
          isPrunable: true,
          prunableReason: "stale",
        },
      ];

      const worktrees = await service.mapToWorktrees(raw);

      expect(worktrees[0].isLocked).toBeUndefined();
      expect(worktrees[1].isLocked).toBe(true);
      expect(worktrees[1].lockReason).toBe("CI");
      expect(worktrees[1].isPrunable).toBe(true);
      expect(worktrees[1].prunableReason).toBe("stale");
    });
  });

  describe("mapToWorktrees external classification", () => {
    const projectRoot = path.resolve("/projects/my-repo");

    it("flags a worktree outside the repository's parent directory", async () => {
      service.setGit(mockGit, projectRoot);
      const raw = [
        { path: projectRoot, branch: "main", bare: false, isMainWorktree: true },
        {
          path: path.resolve("/var/tmp/scratch/bench-baseline"),
          branch: "develop",
          bare: false,
          isMainWorktree: false,
        },
      ];

      const worktrees = await service.mapToWorktrees(raw);

      expect(worktrees[0].isExternal).toBe(false);
      expect(worktrees[1].isExternal).toBe(true);
    });

    it("treats worktrees anywhere under the parent directory as internal", async () => {
      service.setGit(mockGit, projectRoot);
      const parentDir = path.dirname(projectRoot);
      const raw = [
        { path: projectRoot, branch: "main", bare: false, isMainWorktree: true },
        {
          path: path.join(parentDir, "my-repo-worktrees", "feature-a"),
          branch: "feature/a",
          bare: false,
          isMainWorktree: false,
        },
        {
          path: path.join(parentDir, "somewhere", "deeply", "nested"),
          branch: "feature/b",
          bare: false,
          isMainWorktree: false,
        },
      ];

      const worktrees = await service.mapToWorktrees(raw);

      expect(worktrees.map((w) => w.isExternal)).toEqual([false, false, false]);
    });

    it("does not admit a sibling whose name merely extends the parent directory", async () => {
      service.setGit(mockGit, projectRoot);
      const parentDir = path.dirname(projectRoot);
      const raw = [
        { path: projectRoot, branch: "main", bare: false, isMainWorktree: true },
        {
          path: `${parentDir}-other${path.sep}feature`,
          branch: "feature/a",
          bare: false,
          isMainWorktree: false,
        },
      ];

      const worktrees = await service.mapToWorktrees(raw);

      expect(worktrees[1].isExternal).toBe(true);
    });

    it("leaves classification unset for every worktree when projectRootPath is null", async () => {
      service.setGit(mockGit, null);
      const raw = [
        { path: projectRoot, branch: "main", bare: false, isMainWorktree: true },
        {
          path: path.resolve("/var/tmp/scratch/bench-baseline"),
          branch: "develop",
          bare: false,
          isMainWorktree: false,
        },
      ];

      const worktrees = await service.mapToWorktrees(raw);

      // Unknown boundary must never resolve to "everything is external" (#2251).
      expect(worktrees.every((w) => w.isExternal === undefined)).toBe(true);
    });

    it("leaves classification unset when the repository sits at the filesystem root", async () => {
      // The parent of a filesystem-root repo is the root itself, which would
      // accept every path on the system — the same case `assertWorktreePathContained`
      // refuses rather than degrading to an open boundary.
      service.setGit(mockGit, path.resolve("/"));
      const raw = [
        { path: path.resolve("/"), branch: "main", bare: false, isMainWorktree: true },
        {
          path: path.resolve("/var/tmp/scratch/bench-baseline"),
          branch: "develop",
          bare: false,
          isMainWorktree: false,
        },
      ];

      const worktrees = await service.mapToWorktrees(raw);

      expect(worktrees.every((w) => w.isExternal === undefined)).toBe(true);
    });

    it("resolves a relative porcelain path against the main worktree, not the host cwd", async () => {
      // Git 2.48+ `worktree.useRelativePaths` emits linked worktrees relative to
      // the repository while the main entry stays absolute.
      service.setGit(mockGit, projectRoot);
      const raw = [
        { path: projectRoot, branch: "main", bare: false, isMainWorktree: true },
        {
          path: path.join("..", "my-repo-worktrees", "feature-a"),
          branch: "feature/a",
          bare: false,
          isMainWorktree: false,
        },
      ];

      const worktrees = await service.mapToWorktrees(raw);

      expect(worktrees[1].id).toBe(
        path.resolve(projectRoot, "..", "my-repo-worktrees", "feature-a")
      );
      expect(worktrees[1].path).toBe(worktrees[1].id);
      expect(worktrees[1].isExternal).toBe(false);
    });

    it("falls back to cwd resolution for a relative path with no absolute main entry", async () => {
      service.setGit(mockGit, projectRoot);
      const relative = path.join("detached", "worktree");
      const raw = [{ path: relative, branch: "feature/a", bare: false, isMainWorktree: false }];

      const worktrees = await service.mapToWorktrees(raw);

      expect(worktrees[0].id).toBe(path.resolve(relative));
    });
  });
});
