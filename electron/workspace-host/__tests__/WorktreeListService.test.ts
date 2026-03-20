import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SimpleGit } from "simple-git";
import { WorktreeListService } from "../WorktreeListService.js";

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn((p: string) => `${p}/.git`),
}));

function makePorcelain(...entries: string[]): string {
  return entries.join("\n\n") + "\n";
}

function worktreeEntry(
  path: string,
  opts: { branch?: string; bare?: boolean; detached?: boolean; head?: string } = {}
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
  });

  describe("mapToWorktrees", () => {
    it("uses directory name for main worktree display name", () => {
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

      const worktrees = service.mapToWorktrees(raw);

      expect(worktrees[0].name).toBe("my-repo");
      expect(worktrees[1].name).toBe("feature/cool");
    });
  });
});
