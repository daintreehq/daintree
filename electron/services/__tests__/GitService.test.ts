import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const gitClientMock = vi.hoisted(() => ({
  branch: vi.fn(),
  diff: vi.fn(),
  raw: vi.fn(),
  getRemotes: vi.fn(),
  revparse: vi.fn(),
}));

const createHardenedGitMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../../utils/hardenedGit.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/hardenedGit.js")>(
    "../../utils/hardenedGit.js"
  );
  return {
    ...actual,
    createHardenedGit: createHardenedGitMock,
  };
});

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: logWarnMock,
  logError: logErrorMock,
}));

import { GitService } from "../GitService.js";
import { GitError, GitOperationError, WorktreeRemovedError } from "../../utils/errorTypes.js";
import { simpleGitMissingBinaryError } from "../../../shared/testing/simpleGitErrorFixtures.js";

describe("GitService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-git-service-"));
    vi.clearAllMocks();
    createHardenedGitMock.mockImplementation(() => gitClientMock);
    gitClientMock.branch.mockResolvedValue({ branches: {} });
    gitClientMock.diff.mockResolvedValue("");
    gitClientMock.raw.mockResolvedValue("");
    gitClientMock.getRemotes.mockResolvedValue([]);
    gitClientMock.revparse.mockResolvedValue(`${tempDir}\n`);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("allows filenames containing double-dots that are not traversal segments", async () => {
    const filePath = path.join(tempDir, "notes..backup.txt");
    await fs.writeFile(filePath, "line one\nline two", "utf8");

    const service = new GitService(tempDir);
    const diff = await service.getFileDiff("notes..backup.txt", "untracked");

    expect(diff).toContain("+++ b/notes..backup.txt");
    expect(diff).toContain("+line one");
  });

  it("allows Next.js catch-all route filenames with [...slug]", async () => {
    const dir = path.join(tempDir, "pages");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "[...slug].tsx");
    await fs.writeFile(filePath, "export default function Page() {}", "utf8");

    const service = new GitService(tempDir);
    const diff = await service.getFileDiff("pages/[...slug].tsx", "untracked");

    expect(diff).toContain("+++ b/pages/[...slug].tsx");
    expect(diff).toContain("+export default function Page() {}");
  });

  it("rejects traversal paths in getFileDiff", async () => {
    const service = new GitService(tempDir);

    await expect(service.getFileDiff("../secrets.txt", "modified")).rejects.toThrow(
      "Path traversal detected"
    );
  });

  it("returns BINARY_FILE for untracked binary files", async () => {
    const filePath = path.join(tempDir, "blob.bin");
    await fs.writeFile(filePath, Buffer.from([0x00, 0xff, 0x00, 0x7f]));

    const service = new GitService(tempDir);
    const diff = await service.getFileDiff("blob.bin", "untracked");

    expect(diff).toBe("BINARY_FILE");
  });

  it("returns BINARY_FILE when null byte is at position 0", async () => {
    const filePath = path.join(tempDir, "null-at-0.bin");
    await fs.writeFile(filePath, Buffer.from([0x00, 0x41, 0x42, 0x43]));

    const service = new GitService(tempDir);
    const diff = await service.getFileDiff("null-at-0.bin", "untracked");

    expect(diff).toBe("BINARY_FILE");
  });

  it("returns a diff (not BINARY_FILE) for an empty file", async () => {
    const filePath = path.join(tempDir, "empty.txt");
    await fs.writeFile(filePath, Buffer.from([]));

    const service = new GitService(tempDir);
    const diff = await service.getFileDiff("empty.txt", "untracked");

    expect(diff).not.toBe("BINARY_FILE");
    expect(diff).toContain("diff --git");
  });

  it("returns a diff (not BINARY_FILE) for a text file", async () => {
    const filePath = path.join(tempDir, "readme.txt");
    await fs.writeFile(filePath, Buffer.from("hello world\n"));

    const service = new GitService(tempDir);
    const diff = await service.getFileDiff("readme.txt", "untracked");

    expect(diff).not.toBe("BINARY_FILE");
    expect(diff).toContain("diff --git");
  });

  it("returns the diff for a tracked file whose added lines quote the binary marker", async () => {
    const trackedDiff = `diff --git a/README.md b/README.md
index 1a2b3c4..5d6e7f8 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Notes
+Git prints Binary files a/x and b/x differ when it skips a blob.
`;
    gitClientMock.diff.mockResolvedValue(trackedDiff);

    const service = new GitService(tempDir);
    const diff = await service.getFileDiff("README.md", "modified");

    expect(diff).toBe(trackedDiff);
  });

  it("returns BINARY_FILE for a tracked file git reports as binary", async () => {
    gitClientMock.diff.mockResolvedValue(
      "diff --git a/logo.png b/logo.png\nindex 1a2b3c4..5d6e7f8 100644\nBinary files a/logo.png and b/logo.png differ\n"
    );

    const service = new GitService(tempDir);
    const diff = await service.getFileDiff("logo.png", "modified");

    expect(diff).toBe("BINARY_FILE");
  });

  it("finds next local branch suffix while ignoring remote-only conflicts", async () => {
    gitClientMock.branch.mockResolvedValue({
      branches: {
        "feature/foo+bar": { current: false, commit: "a" },
        "feature/foo+bar-2": { current: false, commit: "b" },
        "feature/foo+bar-10": { current: false, commit: "c" },
        "remotes/origin/feature/foo+bar-999": { current: false, commit: "d" },
      },
    });

    const service = new GitService(tempDir);
    const next = await service.findAvailableBranchName("feature/foo+bar");

    expect(next).toBe("feature/foo+bar-11");
  });

  it("filters pseudo HEAD references when listing branches", async () => {
    gitClientMock.branch.mockResolvedValue({
      branches: {
        main: { current: true, commit: "1" },
        "remotes/origin/main": { current: false, commit: "1" },
        "HEAD -> origin/main": { current: false, commit: "1" },
        "remotes/origin/HEAD": { current: false, commit: "1" },
      },
    });

    const service = new GitService(tempDir);
    const branches = await service.listBranches();

    expect(branches.map((branch) => branch.name)).toEqual(["main", "origin/main"]);
  });

  describe("listBranches committer dates", () => {
    beforeEach(() => {
      gitClientMock.branch.mockResolvedValue({
        branches: {
          main: { current: true, commit: "1" },
          "remotes/origin/main": { current: false, commit: "1" },
        },
      });
    });

    it("attaches each branch's own tip date, matched by full ref", async () => {
      gitClientMock.raw.mockResolvedValue(
        [
          "refs/heads/main\t2026-08-01T10:00:00+00:00",
          "refs/remotes/origin/main\t2026-07-30T09:00:00+00:00",
        ].join("\n")
      );

      const branches = await new GitService(tempDir).listBranches();

      expect(Object.fromEntries(branches.map((b) => [b.name, b.committerDate]))).toEqual({
        main: "2026-08-01T10:00:00+00:00",
        "origin/main": "2026-07-30T09:00:00+00:00",
      });
    });

    it("still returns the branch list when the date pass fails", async () => {
      // The dates are optional enrichment; losing them must not turn the picker
      // into a load error.
      gitClientMock.raw.mockRejectedValue(new Error("for-each-ref exploded"));

      const branches = await new GitService(tempDir).listBranches();

      expect(branches.map((b) => b.name)).toEqual(["main", "origin/main"]);
      expect(branches.every((b) => b.committerDate === undefined)).toBe(true);
    });

    it("leaves branches git reported no date for undated", async () => {
      gitClientMock.raw.mockResolvedValue("refs/heads/main\t2026-08-01T10:00:00+00:00");

      const branches = await new GitService(tempDir).listBranches();

      expect(branches.find((b) => b.name === "origin/main")!.committerDate).toBeUndefined();
    });
  });

  it("listBranches throws GitOperationError with classified reason on failure", async () => {
    gitClientMock.branch.mockRejectedValue(new Error("fatal: not a git repository"));
    const service = new GitService(tempDir);

    let caught: unknown;
    try {
      await service.listBranches();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GitOperationError);
    expect(caught).toBeInstanceOf(GitError);
    const opError = caught as GitOperationError;
    expect(opError.reason).toBe("not-a-repository");
    expect(opError.op).toBe("list-branches");
    expect(opError.context).toEqual(
      expect.objectContaining({ cwd: tempDir, op: "list-branches", reason: "not-a-repository" })
    );
  });

  it("listBranches classifies authentication failures", async () => {
    gitClientMock.branch.mockRejectedValue(
      new Error("remote: Authentication failed for 'https://github.com/foo/bar.git/'")
    );
    const service = new GitService(tempDir);

    let caught: unknown;
    try {
      await service.listBranches();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GitOperationError);
    expect((caught as GitOperationError).reason).toBe("auth-failed");
  });

  describe("compareWorktrees", () => {
    it("expands branches to refs/heads/ in two-dot range by default", async () => {
      gitClientMock.raw.mockResolvedValue("");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test");

      expect(gitClientMock.raw).toHaveBeenCalledWith(
        expect.arrayContaining(["refs/heads/main..refs/heads/feature/test"])
      );
    });

    it("expands branches to refs/heads/ in three-dot range when useMergeBase is true", async () => {
      gitClientMock.raw.mockResolvedValue("");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test", undefined, true);

      expect(gitClientMock.raw).toHaveBeenCalledWith(
        expect.arrayContaining(["refs/heads/main...refs/heads/feature/test"])
      );
    });

    it("rejects leading-dash branch names before invoking git", async () => {
      const service = new GitService(tempDir);

      await expect(service.compareWorktrees("--exec=evil", "main")).rejects.toThrow(
        "cannot start with '-'"
      );
      expect(gitClientMock.raw).not.toHaveBeenCalled();
    });

    it("rejects an invalid name even when both branches are equal", async () => {
      // The equality fast-path must not mask validation; otherwise a caller
      // could pass `--exec=evil` for both args and get a silent OK back.
      const service = new GitService(tempDir);

      await expect(service.compareWorktrees("--exec=evil", "--exec=evil")).rejects.toThrow(
        "cannot start with '-'"
      );
      expect(gitClientMock.raw).not.toHaveBeenCalled();
    });

    it("passes --no-textconv to defeat user-defined textconv drivers", async () => {
      gitClientMock.raw.mockResolvedValue("");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test");

      expect(gitClientMock.raw).toHaveBeenCalledWith(expect.arrayContaining(["--no-textconv"]));
    });

    it("places --end-of-options before the range to defuse stray flag-like tokens", async () => {
      gitClientMock.raw.mockResolvedValue("");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test", "src/app.ts");

      const args = gitClientMock.raw.mock.calls[0][0] as string[];
      const eooIdx = args.indexOf("--end-of-options");
      const rangeIdx = args.indexOf("refs/heads/main..refs/heads/feature/test");
      expect(eooIdx).toBeGreaterThanOrEqual(0);
      expect(rangeIdx).toBeGreaterThan(eooIdx);
    });

    it("returns file list for two-dot range", async () => {
      gitClientMock.raw.mockResolvedValue("M\tsrc/app.ts\nA\tsrc/new.ts\n");

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test");

      expect(typeof result).toBe("object");
      if (typeof result === "object") {
        expect(result.files).toHaveLength(2);
        expect(result.files[0]).toMatchObject({ status: "M", path: "src/app.ts" });
        expect(result.files[1]).toMatchObject({ status: "A", path: "src/new.ts" });
      }
    });

    it("returns file list for three-dot range (useMergeBase)", async () => {
      gitClientMock.raw.mockResolvedValue("M\tsrc/app.ts\n");

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test", undefined, true);

      expect(typeof result).toBe("object");
      if (typeof result === "object") {
        expect(result.files).toHaveLength(1);
        expect(result.files[0]).toMatchObject({ status: "M", path: "src/app.ts" });
      }
    });

    it("returns NO_CHANGES string for empty file diff", async () => {
      gitClientMock.raw.mockResolvedValue("   ");

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test", "src/app.ts");

      expect(result).toBe("NO_CHANGES");
    });

    it("returns the diff when a compared file's added lines quote the binary marker", async () => {
      const comparedDiff = `diff --git a/README.md b/README.md
index 1a2b3c4..5d6e7f8 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Notes
+Git prints Binary files a/x and b/x differ when it skips a blob.
`;
      gitClientMock.raw.mockResolvedValue(comparedDiff);

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test", "README.md");

      expect(result).toBe(comparedDiff);
    });

    it("returns BINARY_FILE when git reports a compared file as binary", async () => {
      gitClientMock.raw.mockResolvedValue(
        "diff --git a/logo.png b/logo.png\nindex 1a2b3c4..5d6e7f8 100644\nBinary files a/logo.png and b/logo.png differ\n"
      );

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test", "logo.png");

      expect(result).toBe("BINARY_FILE");
    });

    it("classifies the deleted-file marker form, which names /dev/null second", async () => {
      gitClientMock.raw.mockResolvedValue(
        "diff --git a/logo.png b/logo.png\ndeleted file mode 100644\nBinary files a/logo.png and /dev/null differ\n"
      );

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test", "logo.png");

      expect(result).toBe("BINARY_FILE");
    });

    it("classifies on content, not on whether --ignore-all-space was requested", async () => {
      const markerDiff =
        "diff --git a/logo.png b/logo.png\nindex 1a2b3c4..5d6e7f8 100644\nBinary files a/logo.png and b/logo.png differ\n";
      gitClientMock.raw.mockResolvedValue(markerDiff);

      const service = new GitService(tempDir);
      const ignoring = await service.compareWorktrees(
        "main",
        "feature/test",
        "logo.png",
        false,
        true
      );
      const notIgnoring = await service.compareWorktrees("main", "feature/test", "logo.png");

      expect(ignoring).toBe(notIgnoring);
      expect(ignoring).toBe("BINARY_FILE");
    });

    it("returns empty file list without calling git when branch1 equals branch2", async () => {
      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "main");

      expect(gitClientMock.raw).not.toHaveBeenCalled();
      expect(result).toEqual({ branch1: "main", branch2: "main", files: [] });
    });

    it("returns empty file list without calling git when branch1 equals branch2 with useMergeBase", async () => {
      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "main", undefined, true);

      expect(gitClientMock.raw).not.toHaveBeenCalled();
      expect(result).toEqual({ branch1: "main", branch2: "main", files: [] });
    });

    it("returns NO_CHANGES without calling git when branch1 equals branch2 with filePath", async () => {
      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "main", "src/app.ts");

      expect(gitClientMock.raw).not.toHaveBeenCalled();
      expect(result).toBe("NO_CHANGES");
    });

    it("uses three-dot range for per-file diff when useMergeBase is true", async () => {
      gitClientMock.raw.mockResolvedValue("diff --git a/src/app.ts b/src/app.ts\n+new line");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test", "src/app.ts", true);

      expect(gitClientMock.raw).toHaveBeenCalledWith(
        expect.arrayContaining(["refs/heads/main...refs/heads/feature/test", "--", "src/app.ts"])
      );
    });

    it("passes --ignore-all-space on the per-file diff when ignoreWhitespace is true", async () => {
      gitClientMock.raw.mockResolvedValue("diff --git a/src/app.ts b/src/app.ts\n+new line");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test", "src/app.ts", false, true);

      const args = gitClientMock.raw.mock.calls[0][0] as string[];
      expect(args).toContain("--ignore-all-space");
      expect(args.indexOf("--ignore-all-space")).toBeLessThan(args.indexOf("--end-of-options"));
    });

    it("omits --ignore-all-space on the per-file diff by default", async () => {
      gitClientMock.raw.mockResolvedValue("diff --git a/src/app.ts b/src/app.ts\n+new line");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test", "src/app.ts");

      expect(gitClientMock.raw).not.toHaveBeenCalledWith(
        expect.arrayContaining(["--ignore-all-space"])
      );
    });

    it("passes --ignore-all-space on the file-listing diffs when ignoreWhitespace is true", async () => {
      gitClientMock.raw.mockResolvedValue("");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test", undefined, false, true);

      const listingCalls = gitClientMock.raw.mock.calls.map((call) => call[0] as string[]);
      const nameStatusArgs = listingCalls.find((args) => args.includes("--name-status"));
      const numstatArgs = listingCalls.find((args) => args.includes("--numstat"));
      expect(nameStatusArgs).toContain("--ignore-all-space");
      expect(numstatArgs).toContain("--ignore-all-space");
    });
  });

  describe("createWorktree hardening", () => {
    it("rejects a leading-dash newBranch before any git call", async () => {
      const service = new GitService(tempDir);

      const target = path.join(tempDir, "new-wt-1");
      await expect(
        service.createWorktree({
          baseBranch: "main",
          newBranch: "--exec=touch /tmp/x",
          path: target,
        })
      ).rejects.toThrow("cannot start with '-'");
      expect(gitClientMock.raw).not.toHaveBeenCalled();
    });

    it("rejects a leading-dash baseBranch before any git call", async () => {
      const service = new GitService(tempDir);

      const target = path.join(tempDir, "new-wt-2");
      await expect(
        service.createWorktree({
          baseBranch: "-upload-pack=evil",
          newBranch: "feature/x",
          path: target,
        })
      ).rejects.toThrow("cannot start with '-'");
      expect(gitClientMock.raw).not.toHaveBeenCalled();
    });

    it("places --end-of-options between subcommand flags and positionals (local)", async () => {
      const service = new GitService(tempDir);
      const target = path.join(tempDir, "new-wt-local");

      await service.createWorktree({
        baseBranch: "main",
        newBranch: "feature/x",
        path: target,
      });

      const args = gitClientMock.raw.mock.calls[0][0] as string[];
      const eooIdx = args.indexOf("--end-of-options");
      const pathIdx = args.indexOf(target);
      const baseIdx = args.indexOf("main");
      const branchIdx = args.indexOf("feature/x");
      expect(eooIdx).toBeGreaterThanOrEqual(0);
      // EOO must come after the -b <branch> pair and before the positionals
      expect(branchIdx).toBeLessThan(eooIdx);
      expect(eooIdx).toBeLessThan(pathIdx);
      expect(eooIdx).toBeLessThan(baseIdx);
    });

    it("places --end-of-options after the tracking flag for fromRemote worktrees", async () => {
      const service = new GitService(tempDir);
      const target = path.join(tempDir, "new-wt-remote");

      await service.createWorktree({
        baseBranch: "origin/main",
        newBranch: "feature/x",
        path: target,
        fromRemote: true,
      });

      const args = gitClientMock.raw.mock.calls[0][0] as string[];
      expect(args).toContain("--no-track");
      const trackIdx = args.indexOf("--no-track");
      const eooIdx = args.indexOf("--end-of-options");
      const pathIdx = args.indexOf(target);
      expect(trackIdx).toBeLessThan(eooIdx);
      expect(eooIdx).toBeLessThan(pathIdx);
    });
  });

  describe("removeWorktree hardening", () => {
    it("places --end-of-options before the worktree path", async () => {
      const service = new GitService(tempDir);
      const target = path.join(tempDir, "old-wt");

      await service.removeWorktree(target);

      const args = gitClientMock.raw.mock.calls[0][0] as string[];
      const eooIdx = args.indexOf("--end-of-options");
      const pathIdx = args.indexOf(target);
      expect(eooIdx).toBeGreaterThanOrEqual(0);
      expect(pathIdx).toBeGreaterThan(eooIdx);
    });

    it("keeps --end-of-options after --force when force is true", async () => {
      const service = new GitService(tempDir);
      const target = path.join(tempDir, "old-wt-force");

      await service.removeWorktree(target, true);

      const args = gitClientMock.raw.mock.calls[0][0] as string[];
      expect(args).toContain("--force");
      const forceIdx = args.indexOf("--force");
      const eooIdx = args.indexOf("--end-of-options");
      const pathIdx = args.indexOf(target);
      expect(forceIdx).toBeLessThan(eooIdx);
      expect(eooIdx).toBeLessThan(pathIdx);
    });
  });

  it("passes --no-ext-diff to git.diff for modified files", async () => {
    gitClientMock.diff.mockResolvedValue("diff --git a/foo.ts b/foo.ts\n+change");

    const service = new GitService(tempDir);
    await service.getFileDiff("foo.ts", "modified");

    expect(gitClientMock.diff).toHaveBeenCalledWith(expect.arrayContaining(["--no-ext-diff"]));
  });

  it("passes --no-textconv to git.diff for modified files", async () => {
    gitClientMock.diff.mockResolvedValue("diff --git a/foo.ts b/foo.ts\n+change");

    const service = new GitService(tempDir);
    await service.getFileDiff("foo.ts", "modified");

    expect(gitClientMock.diff).toHaveBeenCalledWith(expect.arrayContaining(["--no-textconv"]));
  });

  it("passes --no-ext-diff to git.raw for cross-worktree file diff", async () => {
    gitClientMock.raw.mockResolvedValue("diff --git a/foo.ts b/foo.ts\n+change");

    const service = new GitService(tempDir);
    await service.compareWorktrees("main", "feature/test", "src/app.ts");

    expect(gitClientMock.raw).toHaveBeenCalledWith(
      expect.arrayContaining(["diff", "--no-ext-diff"])
    );
  });

  it("passes --no-ext-diff to git.raw for cross-worktree file list", async () => {
    gitClientMock.raw.mockResolvedValue("M\tsrc/app.ts\n");

    const service = new GitService(tempDir);
    await service.compareWorktrees("main", "feature/test");

    expect(gitClientMock.raw).toHaveBeenCalledWith(
      expect.arrayContaining(["diff", "--no-ext-diff", "--name-status"])
    );
  });

  it("logs at warn level (not error) when path is not a git repository", async () => {
    gitClientMock.revparse.mockRejectedValue(
      new Error("fatal: not a git repository (or any of the parent directories): .git\n")
    );

    const service = new GitService(tempDir);

    const error = await service.getRepositoryRoot(tempDir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error).not.toBeInstanceOf(WorktreeRemovedError);
    expect(logWarnMock).toHaveBeenCalled();
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it("reports a missing git binary rather than a removed worktree", async () => {
    // Every method routes through the same handler, whose ENOENT text match
    // used to claim the worktree was gone — for a machine that just has no
    // Git installed, and a worktree that is perfectly fine (#11764).
    const spawnFailure = simpleGitMissingBinaryError();
    gitClientMock.revparse.mockRejectedValue(spawnFailure);

    const service = new GitService(tempDir);

    const error = await service.getRepositoryRoot(tempDir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitOperationError);
    expect(error).not.toBeInstanceOf(WorktreeRemovedError);
    expect(error).toMatchObject({ reason: "git-not-installed" });
    // The original stays reachable, which is what lets ProjectStore classify
    // this same failure after another layer has wrapped it.
    expect((error as GitOperationError).cause).toBe(spawnFailure);
  });

  it("still reports a removed worktree when the spawn ENOENT is the missing cwd", async () => {
    // Node raises the same `spawn git ENOENT` when the spawn's cwd is gone, and
    // the cached SimpleGit instance means simple-git's construction-time folder
    // check ran long before the deletion — so the error alone cannot tell the
    // two apart. Without the root-path guard this reads as "install Git".
    const removedPath = path.join(tempDir, "removed-worktree");
    await fs.mkdir(removedPath);
    gitClientMock.revparse.mockRejectedValue(simpleGitMissingBinaryError());

    const service = new GitService(removedPath);
    await fs.rm(removedPath, { recursive: true, force: true });

    const error = await service.getRepositoryRoot(removedPath).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorktreeRemovedError);
    // The missing-binary branch throws a GitOperationError instead, so this
    // rules out having taken it.
    expect(error).not.toBeInstanceOf(GitOperationError);
  });
});

describe("GitService.readFileAtHead", () => {
  let tempDir: string;
  const binaryCatFileMock = vi.fn();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-git-head-"));
    vi.clearAllMocks();
    createHardenedGitMock.mockImplementation(() => ({
      ...gitClientMock,
      binaryCatFile: binaryCatFileMock,
    }));
    gitClientMock.raw.mockResolvedValue("");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects absolute paths before touching git", async () => {
    const service = new GitService(tempDir);
    await expect(service.readFileAtHead("/etc/passwd", 1024)).rejects.toThrow(/absolute/i);
    expect(gitClientMock.raw).not.toHaveBeenCalled();
  });

  it("rejects traversal that only appears after normalization", async () => {
    const service = new GitService(tempDir);
    await expect(service.readFileAtHead("assets/../../outside.png", 1024)).rejects.toThrow(
      /traversal/i
    );
    expect(gitClientMock.raw).not.toHaveBeenCalled();
  });

  it("rejects null bytes", async () => {
    const service = new GitService(tempDir);
    await expect(service.readFileAtHead("img\0.png", 1024)).rejects.toThrow(/null/i);
    expect(gitClientMock.raw).not.toHaveBeenCalled();
  });

  it("size-probes with --end-of-options and a HEAD: spec so leading-dash names stay inert", async () => {
    gitClientMock.raw.mockResolvedValue("10\n");
    binaryCatFileMock.mockResolvedValue(Buffer.from("image-data"));
    const service = new GitService(tempDir);

    const result = await service.readFileAtHead("-flag.png", 1024);

    expect(gitClientMock.raw).toHaveBeenCalledWith([
      "cat-file",
      "-s",
      "--end-of-options",
      "HEAD:-flag.png",
    ]);
    // binaryCatFile has no --end-of-options; the HEAD: prefix is what keeps
    // the spec from ever starting with a dash.
    expect(binaryCatFileMock).toHaveBeenCalledWith(["blob", "HEAD:-flag.png"]);
    expect(result).toEqual({ ok: true, content: Buffer.from("image-data") });
  });

  it("converts backslash separators to git's forward-slash object spec", async () => {
    gitClientMock.raw.mockResolvedValue("4\n");
    binaryCatFileMock.mockResolvedValue(Buffer.from("data"));
    const service = new GitService(tempDir);

    await service.readFileAtHead("assets\\logo.png", 1024);

    expect(gitClientMock.raw).toHaveBeenCalledWith([
      "cat-file",
      "-s",
      "--end-of-options",
      "HEAD:assets/logo.png",
    ]);
  });

  it("maps a file missing at HEAD to NOT_FOUND", async () => {
    gitClientMock.raw.mockRejectedValue(
      new Error("fatal: path 'new.png' does not exist in 'HEAD'")
    );
    const service = new GitService(tempDir);

    await expect(service.readFileAtHead("new.png", 1024)).resolves.toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect(binaryCatFileMock).not.toHaveBeenCalled();
  });

  it("rejects oversized blobs from the size probe without reading content", async () => {
    gitClientMock.raw.mockResolvedValue(String(5 * 1024 * 1024) + "\n");
    const service = new GitService(tempDir);

    await expect(service.readFileAtHead("big.png", 1024)).resolves.toEqual({
      ok: false,
      reason: "TOO_LARGE",
    });
    expect(binaryCatFileMock).not.toHaveBeenCalled();
  });

  it("caps content that slips past a malformed size probe", async () => {
    gitClientMock.raw.mockResolvedValue("not-a-number\n");
    binaryCatFileMock.mockResolvedValue(Buffer.alloc(2048));
    const service = new GitService(tempDir);

    await expect(service.readFileAtHead("odd.png", 1024)).resolves.toEqual({
      ok: false,
      reason: "TOO_LARGE",
    });
  });
});

describe("GitService.readPreviousFileVersion", () => {
  let tempDir: string;
  const binaryCatFileMock = vi.fn();
  const DELETING_SHA = "a".repeat(40);
  const PREVIOUS_SHA = "b".repeat(40);

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-git-prev-"));
    vi.clearAllMocks();
    createHardenedGitMock.mockImplementation(() => ({
      ...gitClientMock,
      binaryCatFile: binaryCatFileMock,
    }));
    gitClientMock.raw.mockResolvedValue("");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function mockRevList(output: string): void {
    gitClientMock.raw.mockImplementation(async (args: string[]) =>
      args.includes("rev-list") ? output : "10\n"
    );
  }

  it("rejects absolute paths before touching git", async () => {
    const service = new GitService(tempDir);
    await expect(service.readPreviousFileVersion("/etc/passwd.png", 1024)).rejects.toThrow(
      /absolute/i
    );
    expect(gitClientMock.raw).not.toHaveBeenCalled();
  });

  it("rejects traversal that only appears after normalization", async () => {
    const service = new GitService(tempDir);
    await expect(service.readPreviousFileVersion("assets/../../outside.png", 1024)).rejects.toThrow(
      /traversal/i
    );
    expect(gitClientMock.raw).not.toHaveBeenCalled();
  });

  it("walks history behind --end-of-options and reads the second commit's blob", async () => {
    mockRevList(`${DELETING_SHA}\n${PREVIOUS_SHA}\n`);
    binaryCatFileMock.mockResolvedValue(Buffer.from("old-bytes"));
    const service = new GitService(tempDir);

    const result = await service.readPreviousFileVersion("-flag.png", 1024);

    expect(gitClientMock.raw).toHaveBeenCalledWith([
      "--literal-pathspecs",
      "rev-list",
      "-2",
      "--end-of-options",
      "HEAD",
      "--",
      "-flag.png",
    ]);
    expect(gitClientMock.raw).toHaveBeenCalledWith([
      "cat-file",
      "-s",
      "--end-of-options",
      `${PREVIOUS_SHA}:-flag.png`,
    ]);
    expect(binaryCatFileMock).toHaveBeenCalledWith(["blob", `${PREVIOUS_SHA}:-flag.png`]);
    expect(result).toEqual({ ok: true, content: Buffer.from("old-bytes") });
  });

  it("converts backslash separators to git's forward-slash path", async () => {
    mockRevList(`${DELETING_SHA}\n${PREVIOUS_SHA}\n`);
    binaryCatFileMock.mockResolvedValue(Buffer.from("data"));
    const service = new GitService(tempDir);

    await service.readPreviousFileVersion("assets\\logo.png", 1024);

    expect(gitClientMock.raw).toHaveBeenCalledWith([
      "--literal-pathspecs",
      "rev-list",
      "-2",
      "--end-of-options",
      "HEAD",
      "--",
      "assets/logo.png",
    ]);
  });

  it("passes glob metacharacters through as a literal pathspec", async () => {
    mockRevList(`${DELETING_SHA}\n${PREVIOUS_SHA}\n`);
    binaryCatFileMock.mockResolvedValue(Buffer.from("data"));
    const service = new GitService(tempDir);

    await service.readPreviousFileVersion("image[1].png", 1024);

    expect(gitClientMock.raw).toHaveBeenCalledWith([
      "--literal-pathspecs",
      "rev-list",
      "-2",
      "--end-of-options",
      "HEAD",
      "--",
      "image[1].png",
    ]);
    expect(binaryCatFileMock).toHaveBeenCalledWith(["blob", `${PREVIOUS_SHA}:image[1].png`]);
  });

  it("returns NOT_FOUND when only the deleting commit is reachable for the path", async () => {
    mockRevList(`${DELETING_SHA}\n`);
    const service = new GitService(tempDir);

    await expect(service.readPreviousFileVersion("once.png", 1024)).resolves.toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect(binaryCatFileMock).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for a never-tracked file", async () => {
    mockRevList("");
    const service = new GitService(tempDir);

    await expect(service.readPreviousFileVersion("untracked.png", 1024)).resolves.toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect(binaryCatFileMock).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for an unborn HEAD in an empty repository", async () => {
    gitClientMock.raw.mockRejectedValue(
      new Error(
        "fatal: ambiguous argument 'HEAD': unknown revision or working tree path not in the working tree."
      )
    );
    const service = new GitService(tempDir);

    await expect(service.readPreviousFileVersion("img.png", 1024)).resolves.toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
  });

  it("maps a path missing at the prior commit to NOT_FOUND", async () => {
    gitClientMock.raw.mockImplementation(async (args: string[]) => {
      if (args.includes("rev-list")) return `${DELETING_SHA}\n${PREVIOUS_SHA}\n`;
      throw new Error(`fatal: path 'img.png' does not exist in '${PREVIOUS_SHA}'`);
    });
    const service = new GitService(tempDir);

    await expect(service.readPreviousFileVersion("img.png", 1024)).resolves.toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect(binaryCatFileMock).not.toHaveBeenCalled();
  });

  it("never passes malformed rev-list output to cat-file", async () => {
    mockRevList("--flag-injection\nnot-a-sha\n");
    const service = new GitService(tempDir);

    await expect(service.readPreviousFileVersion("img.png", 1024)).rejects.toThrow(
      GitOperationError
    );
    expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
    expect(binaryCatFileMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized prior blob from the size probe without reading content", async () => {
    gitClientMock.raw.mockImplementation(async (args: string[]) =>
      args.includes("rev-list")
        ? `${DELETING_SHA}\n${PREVIOUS_SHA}\n`
        : `${String(5 * 1024 * 1024)}\n`
    );
    const service = new GitService(tempDir);

    await expect(service.readPreviousFileVersion("big.png", 1024)).resolves.toEqual({
      ok: false,
      reason: "TOO_LARGE",
    });
    expect(binaryCatFileMock).not.toHaveBeenCalled();
  });

  it("surfaces unexpected rev-list failures as git operation errors", async () => {
    gitClientMock.raw.mockRejectedValue(new Error("git exploded"));
    const service = new GitService(tempDir);

    await expect(service.readPreviousFileVersion("img.png", 1024)).rejects.toThrow(
      GitOperationError
    );
  });
});
