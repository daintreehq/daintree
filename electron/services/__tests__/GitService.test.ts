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

    it("places --end-of-options after --track for fromRemote worktrees", async () => {
      const service = new GitService(tempDir);
      const target = path.join(tempDir, "new-wt-remote");

      await service.createWorktree({
        baseBranch: "origin/main",
        newBranch: "feature/x",
        path: target,
        fromRemote: true,
      });

      const args = gitClientMock.raw.mock.calls[0][0] as string[];
      expect(args).toContain("--track");
      const trackIdx = args.indexOf("--track");
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
