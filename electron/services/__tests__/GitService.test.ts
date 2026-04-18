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

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: createHardenedGitMock,
}));

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: logWarnMock,
  logError: logErrorMock,
}));

import { GitService } from "../GitService.js";
import { GitError, GitOperationError, WorktreeRemovedError } from "../../utils/errorTypes.js";

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
    it("uses two-dot range by default", async () => {
      gitClientMock.raw.mockResolvedValue("");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test");

      expect(gitClientMock.raw).toHaveBeenCalledWith(
        expect.arrayContaining(["main..feature/test"])
      );
    });

    it("uses three-dot range when useMergeBase is true", async () => {
      gitClientMock.raw.mockResolvedValue("");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test", undefined, true);

      expect(gitClientMock.raw).toHaveBeenCalledWith(
        expect.arrayContaining(["main...feature/test"])
      );
    });

    it("returns file list for two-dot range", async () => {
      gitClientMock.raw.mockResolvedValue("M\tsrc/app.ts\nA\tsrc/new.ts\n");

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test");

      expect(typeof result).toBe("object");
      if (typeof result === "object") {
        expect(result.files).toHaveLength(2);
        expect(result.files[0]).toEqual({ status: "M", path: "src/app.ts" });
        expect(result.files[1]).toEqual({ status: "A", path: "src/new.ts" });
      }
    });

    it("returns file list for three-dot range (useMergeBase)", async () => {
      gitClientMock.raw.mockResolvedValue("M\tsrc/app.ts\n");

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test", undefined, true);

      expect(typeof result).toBe("object");
      if (typeof result === "object") {
        expect(result.files).toHaveLength(1);
        expect(result.files[0]).toEqual({ status: "M", path: "src/app.ts" });
      }
    });

    it("returns NO_CHANGES string for empty file diff", async () => {
      gitClientMock.raw.mockResolvedValue("   ");

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test", "src/app.ts");

      expect(result).toBe("NO_CHANGES");
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
        expect.arrayContaining(["main...feature/test", "--", "src/app.ts"])
      );
    });
  });

  it("passes --no-ext-diff to git.diff for modified files", async () => {
    gitClientMock.diff.mockResolvedValue("diff --git a/foo.ts b/foo.ts\n+change");

    const service = new GitService(tempDir);
    await service.getFileDiff("foo.ts", "modified");

    expect(gitClientMock.diff).toHaveBeenCalledWith(expect.arrayContaining(["--no-ext-diff"]));
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
});
