import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitError, WorktreeRemovedError } from "../errorTypes.js";

const mockGit = {
  raw: vi.fn(),
  status: vi.fn(),
  diff: vi.fn(),
  revparse: vi.fn(),
};

const readFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(Buffer.from("line1\nline2\n")));

vi.mock("../hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockGit),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    promises: {
      ...(actual as { promises: Record<string, unknown> }).promises,
      access: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtimeMs: 1000, size: 512 }),
      readFile: readFileMock,
      realpath: vi.fn(async (p: string) => p),
    },
  };
});

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  getLatestTrackedFileMtime,
  getWorktreeChangesWithStats,
  listCommits,
  invalidateWorktreeCache,
  __clearPerFileDiffStatCacheForTesting,
} from "../git.js";
import { createHardenedGit } from "../hardenedGit.js";
import { promises as fs } from "fs";

describe("getLatestTrackedFileMtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns commit timestamp for worktree with commits", async () => {
    const commitUnixTime = 1702639200; // 2023-12-15 10:00:00 UTC
    mockGit.raw.mockResolvedValue(`${commitUnixTime}`);

    const timestamp = await getLatestTrackedFileMtime("/test/path");

    expect(timestamp).toBe(commitUnixTime * 1000);
    expect(createHardenedGit).toHaveBeenCalledWith("/test/path");
    expect(mockGit.raw).toHaveBeenCalledWith(["log", "-1", "--format=%ct"]);
  });

  it("returns null for worktree with no commits", async () => {
    mockGit.raw.mockResolvedValue("");

    const timestamp = await getLatestTrackedFileMtime("/test/path");

    expect(timestamp).toBeNull();
  });

  it("returns null when git operations fail", async () => {
    mockGit.raw.mockRejectedValue(new Error("Not a git repository"));

    const timestamp = await getLatestTrackedFileMtime("/invalid/path");

    expect(timestamp).toBeNull();
  });

  it("returns null for invalid timestamp", async () => {
    mockGit.raw.mockResolvedValue("not-a-number");

    const timestamp = await getLatestTrackedFileMtime("/test/path");

    expect(timestamp).toBeNull();
  });

  it("returns null for zero timestamp", async () => {
    mockGit.raw.mockResolvedValue("0");

    const timestamp = await getLatestTrackedFileMtime("/test/path");

    expect(timestamp).toBeNull();
  });

  it("returns null for negative timestamp", async () => {
    mockGit.raw.mockResolvedValue("-1");

    const timestamp = await getLatestTrackedFileMtime("/test/path");

    expect(timestamp).toBeNull();
  });

  it("handles timestamp with whitespace", async () => {
    const commitUnixTime = 1702639200;
    mockGit.raw.mockResolvedValue(`  ${commitUnixTime}  \n`);

    const timestamp = await getLatestTrackedFileMtime("/test/path");

    expect(timestamp).toBe(commitUnixTime * 1000);
  });
});

describe("getWorktreeChangesWithStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it("throws WorktreeRemovedError when directory does not exist (ENOENT)", async () => {
    const enoentError = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
    (fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(enoentError);

    await expect(getWorktreeChangesWithStats("/deleted/worktree", true)).rejects.toThrow(
      WorktreeRemovedError
    );
  });

  it("throws WorktreeRemovedError when git reports 'not a git repository'", async () => {
    mockGit.status.mockRejectedValue(
      new Error("fatal: not a git repository: /main/.git/worktrees/feature-branch")
    );

    await expect(getWorktreeChangesWithStats("/deregistered/worktree", true)).rejects.toThrow(
      WorktreeRemovedError
    );
  });

  it("does not throw WorktreeRemovedError for unrelated git errors", async () => {
    mockGit.status.mockRejectedValue(new Error("fatal: unable to access remote"));

    await expect(getWorktreeChangesWithStats("/valid/worktree", true)).rejects.not.toThrow(
      WorktreeRemovedError
    );
  });
});

describe("getWorktreeChangesWithStats --no-ext-diff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    mockGit.status.mockResolvedValue({
      modified: ["src/app.ts"],
      created: [],
      deleted: [],
      renamed: [],
      staged: [],
      conflicted: [],
      not_added: [],
      files: [{ path: "src/app.ts", index: " ", working_dir: "M" }],
    });
    mockGit.revparse.mockResolvedValue("/test/path\n");
    mockGit.raw.mockResolvedValue("100\t0\tsome msg");
    mockGit.diff.mockResolvedValue("1\t0\tsrc/app.ts");
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 1000, size: 512 });
  });

  it("passes --no-ext-diff, --no-renames, and --numstat in diff call", async () => {
    await getWorktreeChangesWithStats("/test/path", true);

    expect(mockGit.diff).toHaveBeenCalledWith(
      expect.arrayContaining(["--no-ext-diff", "--no-renames", "--numstat"])
    );
  });
});

describe("getWorktreeChangesWithStats upstream tracking normalization", () => {
  const baseStatus = {
    modified: [],
    created: [],
    deleted: [],
    renamed: [],
    staged: [],
    conflicted: [],
    not_added: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    mockGit.revparse.mockResolvedValue("/test/path\n");
    mockGit.raw.mockResolvedValue("100\t0\tsome msg");
    mockGit.diff.mockResolvedValue("");
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 1000 });
  });

  it("preserves zero ahead/behind when tracking is configured (in-sync branch)", async () => {
    mockGit.status.mockResolvedValue({
      ...baseStatus,
      tracking: "origin/main",
      ahead: 0,
      behind: 0,
    });

    const cwd = "/upstream-test/" + Math.random();
    const result = await getWorktreeChangesWithStats(cwd, true);

    expect(result.tracking).toBe("origin/main");
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
  });

  it("surfaces non-zero ahead/behind from a tracked branch", async () => {
    mockGit.status.mockResolvedValue({
      ...baseStatus,
      tracking: "origin/feature",
      ahead: 3,
      behind: 1,
    });

    const cwd = "/upstream-test/" + Math.random();
    const result = await getWorktreeChangesWithStats(cwd, true);

    expect(result.tracking).toBe("origin/feature");
    expect(result.ahead).toBe(3);
    expect(result.behind).toBe(1);
  });

  it("normalizes null tracking to undefined ahead/behind", async () => {
    mockGit.status.mockResolvedValue({
      ...baseStatus,
      tracking: null,
      ahead: 0,
      behind: 0,
    });

    const cwd = "/upstream-test/" + Math.random();
    const result = await getWorktreeChangesWithStats(cwd, true);

    expect(result.tracking).toBeNull();
    expect(result.ahead).toBeUndefined();
    expect(result.behind).toBeUndefined();
  });

  it("normalizes empty-string tracking to null + undefined counts", async () => {
    mockGit.status.mockResolvedValue({
      ...baseStatus,
      tracking: "",
      ahead: 0,
      behind: 0,
    });

    const cwd = "/upstream-test/" + Math.random();
    const result = await getWorktreeChangesWithStats(cwd, true);

    expect(result.tracking).toBeNull();
    expect(result.ahead).toBeUndefined();
    expect(result.behind).toBeUndefined();
  });
});

describe("getWorktreeChangesWithStats in-flight deduplication", () => {
  const emptyStatus = {
    modified: [],
    created: [],
    deleted: [],
    renamed: [],
    staged: [],
    conflicted: [],
    not_added: [],
  };

  function setupGitMocks() {
    (fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    mockGit.revparse.mockResolvedValue("/test/dedup\n");
    mockGit.raw.mockResolvedValue("100\t0\tsome msg");
    mockGit.diff.mockResolvedValue("");
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 1000 });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates concurrent calls for the same cwd when forceRefresh is false", async () => {
    setupGitMocks();
    // Use a unique path to avoid cache from prior tests
    const cwd = "/dedup-test/" + Math.random();

    let resolveStatus!: (value: unknown) => void;
    mockGit.status.mockReturnValue(new Promise((r) => (resolveStatus = r)));

    const callA = getWorktreeChangesWithStats(cwd, false);
    const callB = getWorktreeChangesWithStats(cwd, false);

    resolveStatus(emptyStatus);

    const [resultA, resultB] = await Promise.all([callA, callB]);
    expect(resultA).toEqual(resultB);
    // createHardenedGit should only be called once for the deduplicated pair
    expect(vi.mocked(createHardenedGit)).toHaveBeenCalledTimes(1);
  });

  it("does not deduplicate when forceRefresh is true", async () => {
    setupGitMocks();
    const cwd = "/dedup-test/" + Math.random();
    mockGit.status.mockResolvedValue(emptyStatus);

    const call1 = getWorktreeChangesWithStats(cwd, true);
    const call2 = getWorktreeChangesWithStats(cwd, true);

    await Promise.all([call1, call2]);
    expect(vi.mocked(createHardenedGit)).toHaveBeenCalledTimes(2);
  });

  it("propagates rejection to all waiters and cleans up the map", async () => {
    setupGitMocks();
    const cwd = "/dedup-test/" + Math.random();
    mockGit.status.mockRejectedValue(new Error("fatal: unable to access remote"));

    const callA = getWorktreeChangesWithStats(cwd, false);
    const callB = getWorktreeChangesWithStats(cwd, false);

    // Both callers should get GitError (normalized by the IIFE)
    await expect(callA).rejects.toThrow(GitError);
    await expect(callB).rejects.toThrow(GitError);

    // After rejection, the map should be cleaned up — a new call creates a fresh operation
    mockGit.status.mockResolvedValue(emptyStatus);
    const result = await getWorktreeChangesWithStats(cwd, false);
    expect(result.changedFileCount).toBe(0);
  });

  it("normalizes errors consistently for all deduplicated callers", async () => {
    setupGitMocks();
    const cwd = "/dedup-test/" + Math.random();
    mockGit.status.mockRejectedValue(
      new Error("fatal: not a git repository: /main/.git/worktrees/gone")
    );

    const callA = getWorktreeChangesWithStats(cwd, false);
    const callB = getWorktreeChangesWithStats(cwd, false);

    // Both callers should get WorktreeRemovedError, not a raw Error
    await expect(callA).rejects.toThrow(WorktreeRemovedError);
    await expect(callB).rejects.toThrow(WorktreeRemovedError);
  });

  it("cleans up map after resolution so next call starts fresh", async () => {
    setupGitMocks();
    const cwd = "/dedup-test/" + Math.random();
    mockGit.status.mockResolvedValue(emptyStatus);

    await getWorktreeChangesWithStats(cwd, false);

    // Invalidate cache so next call doesn't hit the cache
    invalidateWorktreeCache(cwd);
    vi.mocked(createHardenedGit).mockClear();

    await getWorktreeChangesWithStats(cwd, false);
    // Should have called createHardenedGit again (not reused old promise)
    expect(vi.mocked(createHardenedGit)).toHaveBeenCalledTimes(1);
  });

  it("forceRefresh does not evict an existing normal in-flight entry", async () => {
    setupGitMocks();
    const cwd = "/dedup-test/" + Math.random();

    let resolveNormal!: (value: unknown) => void;
    mockGit.status.mockReturnValueOnce(new Promise((r) => (resolveNormal = r)));

    // Start a normal (non-forceRefresh) call — this registers in the in-flight map
    const normalCall = getWorktreeChangesWithStats(cwd, false);

    // Now issue a forceRefresh call while normal is in-flight
    mockGit.status.mockResolvedValueOnce(emptyStatus);
    const forceCall = getWorktreeChangesWithStats(cwd, true);
    await forceCall;

    // After forceCall completes, the in-flight entry should still be the normal one.
    // A third normal call should deduplicate with the first (not create a new operation).
    vi.mocked(createHardenedGit).mockClear();
    const thirdCall = getWorktreeChangesWithStats(cwd, false);

    resolveNormal(emptyStatus);
    await Promise.all([normalCall, thirdCall]);

    // createHardenedGit should NOT have been called for the third call (it got the in-flight entry)
    expect(vi.mocked(createHardenedGit)).not.toHaveBeenCalled();
  });

  it("deduplicates calls for different cwds independently", async () => {
    setupGitMocks();
    const cwdA = "/dedup-test/" + Math.random();
    const cwdB = "/dedup-test/" + Math.random();

    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    mockGit.status
      .mockReturnValueOnce(new Promise((r) => (resolveA = r)))
      .mockReturnValueOnce(new Promise((r) => (resolveB = r)));

    const callA = getWorktreeChangesWithStats(cwdA, false);
    const callB = getWorktreeChangesWithStats(cwdB, false);

    resolveA(emptyStatus);
    resolveB(emptyStatus);

    await Promise.all([callA, callB]);
    expect(vi.mocked(createHardenedGit)).toHaveBeenCalledTimes(2);
  });
});

describe("getWorktreeChangesWithStats concurrent worktree isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 1000 });
  });

  it("returns per-worktree results when multiple worktrees refresh concurrently with forceRefresh", async () => {
    const cwdMain = "/worktree-main/" + Math.random();
    const cwdFeature = "/worktree-feature/" + Math.random();

    const mockGitMain = {
      raw: vi.fn().mockResolvedValue("100\t0\tcommit msg"),
      status: vi.fn().mockResolvedValue({
        modified: ["src/main-file.ts"],
        created: [],
        deleted: [],
        renamed: [],
        staged: [],
        conflicted: [],
        not_added: [],
      }),
      diff: vi.fn().mockResolvedValue("10\t2\tsrc/main-file.ts"),
      revparse: vi.fn().mockResolvedValue(cwdMain + "\n"),
    };

    const mockGitFeature = {
      raw: vi.fn().mockResolvedValue("200\t0\tfeature msg"),
      status: vi.fn().mockResolvedValue({
        modified: ["src/feature-file.ts", "src/other.ts"],
        created: [],
        deleted: [],
        renamed: [],
        staged: [],
        conflicted: [],
        not_added: [],
      }),
      diff: vi.fn().mockResolvedValue("5\t1\tsrc/feature-file.ts\n3\t0\tsrc/other.ts"),
      revparse: vi.fn().mockResolvedValue(cwdFeature + "\n"),
    };

    vi.mocked(createHardenedGit).mockImplementation((cwd: string) => {
      if (cwd === cwdMain) return mockGitMain as unknown as ReturnType<typeof createHardenedGit>;
      if (cwd === cwdFeature)
        return mockGitFeature as unknown as ReturnType<typeof createHardenedGit>;
      return mockGit as unknown as ReturnType<typeof createHardenedGit>;
    });

    const [resultMain, resultFeature] = await Promise.all([
      getWorktreeChangesWithStats(cwdMain, true),
      getWorktreeChangesWithStats(cwdFeature, true),
    ]);

    // Main worktree: 1 file
    expect(resultMain.worktreeId).toBe(cwdMain);
    expect(resultMain.changedFileCount).toBe(1);
    expect(resultMain.changes[0].path).toContain("main-file.ts");

    // Feature worktree: 2 files
    expect(resultFeature.worktreeId).toBe(cwdFeature);
    expect(resultFeature.changedFileCount).toBe(2);
    expect(resultFeature.changes.some((c) => c.path.includes("feature-file.ts"))).toBe(true);
    expect(resultFeature.changes.some((c) => c.path.includes("other.ts"))).toBe(true);

    // No cross-contamination
    expect(resultMain.changes.some((c) => c.path.includes("feature-file.ts"))).toBe(false);
    expect(resultFeature.changes.some((c) => c.path.includes("main-file.ts"))).toBe(false);
  });
});

describe("getWorktreeChangesWithStats per-file diff cache", () => {
  const emptyStatus = {
    modified: [],
    created: [],
    deleted: [],
    renamed: [],
    staged: [],
    conflicted: [],
    not_added: [],
  };

  function setupRevparse(cwd: string, headOid: string) {
    mockGit.raw.mockImplementation((args: string[]) => {
      if (Array.isArray(args) && args[0] === "rev-parse") {
        return Promise.resolve(`${headOid}\n${cwd}`);
      }
      return Promise.resolve("");
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    __clearPerFileDiffStatCacheForTesting();
    (fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    mockGit.raw.mockResolvedValue("");
  });

  it("scopes the numstat diff to cache-miss paths via pathspec", async () => {
    const cwd = "/per-file-cache-scope/" + Math.random();
    setupRevparse(cwd, "head-oid-scope");
    mockGit.status.mockResolvedValue({
      ...emptyStatus,
      modified: ["src/a.ts"],
    });
    mockGit.diff.mockResolvedValue("4\t2\tsrc/a.ts");
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 1000, size: 50 });

    await getWorktreeChangesWithStats(cwd, true);

    expect(mockGit.diff).toHaveBeenCalledTimes(1);
    expect(mockGit.diff).toHaveBeenCalledWith([
      "--no-ext-diff",
      "--no-renames",
      "--numstat",
      "HEAD",
      "--",
      "src/a.ts",
    ]);
  });

  it("skips git.diff when every tracked file hits the per-file cache", async () => {
    const cwd = "/per-file-cache-allhit/" + Math.random();
    setupRevparse(cwd, "head-oid-allhit");
    mockGit.status.mockResolvedValue({
      ...emptyStatus,
      modified: ["src/cached.ts"],
    });
    mockGit.diff.mockResolvedValue("9\t1\tsrc/cached.ts");
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 2000, size: 75 });

    // First call populates the cache.
    await getWorktreeChangesWithStats(cwd, true);
    expect(mockGit.diff).toHaveBeenCalledTimes(1);

    // Second call with identical (HEAD, path, mtime, size) should hit cache.
    mockGit.diff.mockClear();
    const result = await getWorktreeChangesWithStats(cwd, true);

    expect(mockGit.diff).not.toHaveBeenCalled();
    expect(result.totalInsertions).toBe(9);
    expect(result.totalDeletions).toBe(1);
  });

  it("only diffs cache-miss files when one of two changed", async () => {
    const cwd = "/per-file-cache-mix/" + Math.random();
    setupRevparse(cwd, "head-oid-mix");
    mockGit.status.mockResolvedValue({
      ...emptyStatus,
      modified: ["src/stable.ts", "src/dirty.ts"],
    });
    mockGit.diff.mockResolvedValue("3\t1\tsrc/stable.ts\n7\t2\tsrc/dirty.ts");
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 1500, size: 120 });

    // Prime cache for both files.
    await getWorktreeChangesWithStats(cwd, true);
    expect(mockGit.diff).toHaveBeenCalledTimes(1);

    // dirty.ts gets a new mtime; stable.ts unchanged.
    (fs.stat as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
      if (p.endsWith("dirty.ts")) return { mtimeMs: 9999, size: 130 };
      return { mtimeMs: 1500, size: 120 };
    });
    mockGit.diff.mockReset();
    mockGit.diff.mockResolvedValue("8\t3\tsrc/dirty.ts");

    const result = await getWorktreeChangesWithStats(cwd, true);

    expect(mockGit.diff).toHaveBeenCalledTimes(1);
    expect(mockGit.diff).toHaveBeenCalledWith([
      "--no-ext-diff",
      "--no-renames",
      "--numstat",
      "HEAD",
      "--",
      "src/dirty.ts",
    ]);
    // stable.ts comes from cache (3/1); dirty.ts from fresh diff (8/3).
    expect(result.totalInsertions).toBe(3 + 8);
    expect(result.totalDeletions).toBe(1 + 3);
  });

  it("invalidates cache when only the file size changes", async () => {
    const cwd = "/per-file-cache-sizeonly/" + Math.random();
    setupRevparse(cwd, "head-oid-sizeonly");
    mockGit.status.mockResolvedValue({
      ...emptyStatus,
      modified: ["src/grow.ts"],
    });
    mockGit.diff.mockResolvedValue("3\t1\tsrc/grow.ts");
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 7000, size: 100 });

    await getWorktreeChangesWithStats(cwd, true);
    expect(mockGit.diff).toHaveBeenCalledTimes(1);

    // Same mtime, same path, same HEAD — but size changed. Must miss cache.
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 7000, size: 200 });
    mockGit.diff.mockReset();
    mockGit.diff.mockResolvedValue("5\t2\tsrc/grow.ts");

    await getWorktreeChangesWithStats(cwd, true);
    expect(mockGit.diff).toHaveBeenCalledTimes(1);
    expect(mockGit.diff).toHaveBeenCalledWith([
      "--no-ext-diff",
      "--no-renames",
      "--numstat",
      "HEAD",
      "--",
      "src/grow.ts",
    ]);
  });

  it("invalidates cache when HEAD OID changes", async () => {
    const cwd = "/per-file-cache-headchange/" + Math.random();
    setupRevparse(cwd, "head-oid-old");
    mockGit.status.mockResolvedValue({
      ...emptyStatus,
      modified: ["src/file.ts"],
    });
    mockGit.diff.mockResolvedValue("2\t0\tsrc/file.ts");
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 4000, size: 200 });

    await getWorktreeChangesWithStats(cwd, true);
    expect(mockGit.diff).toHaveBeenCalledTimes(1);

    // Same path/mtime/size but a fresh HEAD OID — must miss the cache.
    setupRevparse(cwd, "head-oid-new");
    mockGit.diff.mockReset();
    mockGit.diff.mockResolvedValue("2\t0\tsrc/file.ts");

    await getWorktreeChangesWithStats(cwd, true);
    expect(mockGit.diff).toHaveBeenCalledTimes(1);
    expect(mockGit.diff).toHaveBeenCalledWith([
      "--no-ext-diff",
      "--no-renames",
      "--numstat",
      "HEAD",
      "--",
      "src/file.ts",
    ]);
  });

  it("does not cache stats when the diff command fails", async () => {
    const cwd = "/per-file-cache-difffail/" + Math.random();
    setupRevparse(cwd, "head-oid-fail");
    mockGit.status.mockResolvedValue({
      ...emptyStatus,
      modified: ["src/flaky.ts"],
    });
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 5000, size: 300 });
    mockGit.diff.mockRejectedValueOnce(new Error("transient git failure"));

    await getWorktreeChangesWithStats(cwd, true);
    expect(mockGit.diff).toHaveBeenCalledTimes(1);

    // Next call must rerun the diff because the prior failure was not cached.
    mockGit.diff.mockReset();
    mockGit.diff.mockResolvedValue("6\t4\tsrc/flaky.ts");
    const result = await getWorktreeChangesWithStats(cwd, true);

    expect(mockGit.diff).toHaveBeenCalledTimes(1);
    expect(result.totalInsertions).toBe(6);
    expect(result.totalDeletions).toBe(4);
  });
});

describe("getWorktreeChangesWithStats binary file handling", () => {
  const emptyStatus = {
    modified: [],
    created: [],
    deleted: [],
    renamed: [],
    staged: [],
    conflicted: [],
    not_added: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __clearPerFileDiffStatCacheForTesting();
    (fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 1000, size: 512 });
    readFileMock.mockResolvedValue(Buffer.from("line1\nline2\n"));
    mockGit.raw.mockResolvedValue("");
    mockGit.diff.mockResolvedValue("");
  });

  it("returns insertions: null for untracked binary files (null byte detected)", async () => {
    const cwd = "/binary-untracked/" + Math.random();
    mockGit.revparse.mockImplementation((args: string[]) => {
      if (Array.isArray(args) && args[0] === "HEAD") {
        return Promise.resolve("head-oid\n");
      }
      return Promise.resolve(`${cwd}\n`);
    });
    mockGit.status.mockResolvedValue({
      ...emptyStatus,
      not_added: ["blob.bin"],
    });
    readFileMock.mockResolvedValue(Buffer.from([0x00, 0xff, 0xfe, 0xfd]));

    const result = await getWorktreeChangesWithStats(cwd, true);

    expect(result.totalInsertions).toBe(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].insertions).toBeNull();
  });

  it("returns line count for untracked text files", async () => {
    const cwd = "/text-untracked/" + Math.random();
    mockGit.revparse.mockImplementation((args: string[]) => {
      if (Array.isArray(args) && args[0] === "HEAD") {
        return Promise.resolve("head-oid\n");
      }
      return Promise.resolve(`${cwd}\n`);
    });
    mockGit.status.mockResolvedValue({
      ...emptyStatus,
      not_added: ["readme.txt"],
    });
    readFileMock.mockResolvedValue(Buffer.from("line1\nline2\nline3\n"));

    const result = await getWorktreeChangesWithStats(cwd, true);

    expect(result.totalInsertions).toBe(3);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].insertions).toBe(3);
  });

  it("returns 0 insertions for an empty untracked file", async () => {
    const cwd = "/text-untracked-empty/" + Math.random();
    mockGit.revparse.mockImplementation((args: string[]) => {
      if (Array.isArray(args) && args[0] === "HEAD") {
        return Promise.resolve("head-oid\n");
      }
      return Promise.resolve(`${cwd}\n`);
    });
    mockGit.status.mockResolvedValue({
      ...emptyStatus,
      not_added: ["empty.txt"],
    });
    readFileMock.mockResolvedValue(Buffer.alloc(0));

    const result = await getWorktreeChangesWithStats(cwd, true);

    expect(result.changes[0].insertions).toBe(0);
  });

  it("counts a final line without a trailing newline", async () => {
    const cwd = "/text-untracked-no-eol/" + Math.random();
    mockGit.revparse.mockImplementation((args: string[]) => {
      if (Array.isArray(args) && args[0] === "HEAD") {
        return Promise.resolve("head-oid\n");
      }
      return Promise.resolve(`${cwd}\n`);
    });
    mockGit.status.mockResolvedValue({
      ...emptyStatus,
      not_added: ["notes.txt"],
    });
    readFileMock.mockResolvedValue(Buffer.from("line1\nline2"));

    const result = await getWorktreeChangesWithStats(cwd, true);

    expect(result.changes[0].insertions).toBe(2);
  });

  it("reuses the untracked line count across a HEAD change when mtime+size are unchanged", async () => {
    const cwd = "/text-untracked-commit/" + Math.random();
    let headOid = "head-oid-before";
    mockGit.revparse.mockImplementation((args: string[]) => {
      if (Array.isArray(args) && args[0] === "HEAD") {
        return Promise.resolve(`${headOid}\n`);
      }
      return Promise.resolve(`${cwd}\n`);
    });
    mockGit.status.mockResolvedValue({
      ...emptyStatus,
      not_added: ["readme.txt"],
    });
    readFileMock.mockResolvedValue(Buffer.from("line1\nline2\nline3\n"));

    const first = await getWorktreeChangesWithStats(cwd, true);
    expect(first.changes[0].insertions).toBe(3);

    headOid = "head-oid-after";
    readFileMock.mockClear();

    const second = await getWorktreeChangesWithStats(cwd, true);

    expect(second.changes[0].insertions).toBe(3);
    expect(readFileMock).not.toHaveBeenCalled();
  });
});

describe("listCommits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeLogOutput(
    commits: {
      hash: string;
      short: string;
      msg: string;
      body: string;
      name: string;
      email: string;
      date: string;
    }[]
  ): string {
    return commits
      .map(
        (c) =>
          `${c.hash}\x00${c.short}\x00${c.msg}\x00${c.body}\x00${c.name}\x00${c.email}\x00${c.date}\x00END`
      )
      .join("\n");
  }

  it("parses commits with pipe characters in body", async () => {
    mockGit.raw
      .mockResolvedValueOnce("5") // rev-list --count
      .mockResolvedValueOnce(
        makeLogOutput([
          {
            hash: "abc123def456",
            short: "abc123d",
            msg: "feat: add table",
            body: "| Col A | Col B |\n|-------|-------|",
            name: "Test Author",
            email: "test@test.com",
            date: "2024-01-15T12:00:00+00:00",
          },
        ])
      );

    const result = await listCommits({ cwd: "/test", branch: "main" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].hash).toBe("abc123def456");
    expect(result.items[0].message).toBe("feat: add table");
    expect(result.items[0].body).toBe("| Col A | Col B |\n|-------|-------|");
    expect(result.items[0].date).toBe("2024-01-15T12:00:00+00:00");
    expect(result.total).toBe(5);
  });

  it("parses multiple commits where one has pipe-heavy body", async () => {
    mockGit.raw.mockResolvedValueOnce("2").mockResolvedValueOnce(
      makeLogOutput([
        {
          hash: "aaa111",
          short: "aaa111",
          msg: "docs: add table",
          body: "| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |",
          name: "Alice",
          email: "alice@test.com",
          date: "2024-01-15T12:00:00+00:00",
        },
        {
          hash: "bbb222",
          short: "bbb222",
          msg: "fix: normal commit",
          body: "",
          name: "Bob",
          email: "bob@test.com",
          date: "2024-01-14T12:00:00+00:00",
        },
      ])
    );

    const result = await listCommits({ cwd: "/test", branch: "main" });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].body).toBe("| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |");
    expect(result.items[0].date).toBe("2024-01-15T12:00:00+00:00");
    expect(result.items[1].hash).toBe("bbb222");
    expect(result.items[1].body).toBeUndefined();
    expect(result.items[1].date).toBe("2024-01-14T12:00:00+00:00");
  });

  it("handles empty commit body", async () => {
    mockGit.raw.mockResolvedValueOnce("1").mockResolvedValueOnce(
      makeLogOutput([
        {
          hash: "def456",
          short: "def456",
          msg: "fix: typo",
          body: "",
          name: "Author",
          email: "a@b.com",
          date: "2024-01-15T12:00:00+00:00",
        },
      ])
    );

    const result = await listCommits({ cwd: "/test", branch: "main" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].body).toBeUndefined();
  });

  it("respects hasMore pagination", async () => {
    const commits = Array.from({ length: 3 }, (_, i) => ({
      hash: `hash${i}`,
      short: `h${i}`,
      msg: `msg ${i}`,
      body: "",
      name: "A",
      email: "a@b.com",
      date: "2024-01-15T12:00:00+00:00",
    }));

    mockGit.raw.mockResolvedValueOnce("10").mockResolvedValueOnce(makeLogOutput(commits));

    const result = await listCommits({ cwd: "/test", branch: "main", limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
  });

  it("passes --grep for a non-hex search string", async () => {
    mockGit.raw.mockResolvedValueOnce("0").mockResolvedValueOnce("");

    await listCommits({ cwd: "/test", branch: "main", search: "bugfix" });

    // "bugfix" is not hex (u, g, x), so no rev-parse pass: rev-list + log only.
    expect(mockGit.raw).toHaveBeenCalledTimes(2);
    const logCall = mockGit.raw.mock.calls[1][0] as string[];
    expect(logCall).toContain("--grep=bugfix");
    expect(logCall).toContain("-i");
  });

  it("resolves a hash prefix and prepends the matched commit on page 0", async () => {
    const fullHash = "abc1234def567890abc1234def567890abc12345";
    mockGit.raw
      .mockResolvedValueOnce("10") // rev-list --count
      .mockResolvedValueOnce(`${fullHash}\n`) // rev-parse --verify
      .mockResolvedValueOnce(
        makeLogOutput([
          {
            hash: fullHash,
            short: "abc1234",
            msg: "feat: the looked-up commit",
            body: "",
            name: "Author",
            email: "a@b.com",
            date: "2024-01-15T12:00:00+00:00",
          },
        ])
      ) // log -1 <fullHash>
      .mockResolvedValueOnce(
        makeLogOutput([
          {
            hash: "ffff999",
            short: "ffff999",
            msg: "chore: a message match",
            body: "",
            name: "Author",
            email: "a@b.com",
            date: "2024-01-14T12:00:00+00:00",
          },
        ])
      ); // log --grep

    const result = await listCommits({ cwd: "/test", branch: "main", search: "abc1234" });

    const revParseCall = mockGit.raw.mock.calls[1][0] as string[];
    expect(revParseCall).toEqual(["rev-parse", "--verify", "abc1234^{commit}"]);
    // The resolved full hash must be trimmed before it's handed to `log -1`.
    const logHashCall = mockGit.raw.mock.calls[2][0] as string[];
    expect(logHashCall).toEqual(["log", expect.stringContaining("--format="), "-1", fullHash]);
    // The grep pass must still carry the search term and branch.
    const grepCall = mockGit.raw.mock.calls[3][0] as string[];
    expect(grepCall).toContain("--grep=abc1234");
    expect(grepCall).toContain("-i");
    expect(grepCall).toContain("main");
    expect(result.items[0].hash).toBe(fullHash);
    expect(result.items).toHaveLength(2);
    expect(result.items[1].hash).toBe("ffff999");
  });

  it("keeps the hash match additive without dropping a full page of message results", async () => {
    const fullHash = "abc1234def567890abc1234def567890abc12345";
    const makeCommit = (h: string) => ({
      hash: h,
      short: h.slice(0, 7),
      msg: `msg ${h}`,
      body: "",
      name: "A",
      email: "a@b.com",
      date: "2024-01-15T12:00:00+00:00",
    });
    // limit=1, grep returns 2 distinct message commits (limit+1 = "more exists"),
    // hash match is not among them. The hash must be pinned AND no message result lost.
    mockGit.raw
      .mockResolvedValueOnce("10") // rev-list --count
      .mockResolvedValueOnce(`${fullHash}\n`) // rev-parse --verify
      .mockResolvedValueOnce(makeLogOutput([makeCommit(fullHash)])) // log -1 <fullHash>
      .mockResolvedValueOnce(makeLogOutput([makeCommit("aaa1111"), makeCommit("bbb2222")])); // log --grep

    const result = await listCommits({ cwd: "/test", branch: "main", search: "abc1234", limit: 1 });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].hash).toBe(fullHash);
    expect(result.items[1].hash).toBe("aaa1111");
    // bbb2222 was the limit+1 peek entry, so more message results remain.
    expect(result.hasMore).toBe(true);
  });

  it("deduplicates a hash prefix match already present in message results", async () => {
    const fullHash = "abc1234def567890abc1234def567890abc12345";
    const commit = {
      hash: fullHash,
      short: "abc1234",
      msg: "feat: shared commit",
      body: "",
      name: "Author",
      email: "a@b.com",
      date: "2024-01-15T12:00:00+00:00",
    };
    mockGit.raw
      .mockResolvedValueOnce("10") // rev-list --count
      .mockResolvedValueOnce(`${fullHash}\n`) // rev-parse --verify
      .mockResolvedValueOnce(makeLogOutput([commit])) // log -1 <fullHash>
      .mockResolvedValueOnce(makeLogOutput([commit])); // log --grep (same commit)

    const result = await listCommits({ cwd: "/test", branch: "main", search: "abc1234" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].hash).toBe(fullHash);
    // The only message result was the hash match itself, so nothing remains.
    expect(result.hasMore).toBe(false);
  });

  it("skips the rev-parse pass when paginating (skip > 0)", async () => {
    mockGit.raw.mockResolvedValueOnce("10").mockResolvedValueOnce("");

    await listCommits({ cwd: "/test", branch: "main", search: "abc1234", skip: 5 });

    // No rev-parse on paginated pages: rev-list + log only. The search term must
    // still reach the grep call so paginated pages stay filtered.
    expect(mockGit.raw).toHaveBeenCalledTimes(2);
    const logCall = mockGit.raw.mock.calls[1][0] as string[];
    expect(logCall[0]).toBe("log");
    expect(logCall).toContain("--grep=abc1234");
    expect(logCall).toContain("-i");
  });

  it("skips the rev-parse pass for sub-4-char and over-40-char hex strings", async () => {
    mockGit.raw.mockResolvedValue("");

    await listCommits({ cwd: "/test", branch: "main", search: "abc" }); // 3 chars
    expect(mockGit.raw).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    mockGit.raw.mockResolvedValue("");
    await listCommits({ cwd: "/test", branch: "main", search: "a".repeat(41) }); // 41 chars
    expect(mockGit.raw).toHaveBeenCalledTimes(2);
  });

  it("skips the log -1 call when rev-parse returns only whitespace", async () => {
    mockGit.raw
      .mockResolvedValueOnce("10") // rev-list --count
      .mockResolvedValueOnce("  \n ") // rev-parse --verify → whitespace, trims to ""
      .mockResolvedValueOnce(""); // log --grep

    const result = await listCommits({ cwd: "/test", branch: "main", search: "abc1234" });

    // rev-list + rev-parse + grep-log only — no log -1 pass.
    expect(mockGit.raw).toHaveBeenCalledTimes(3);
    expect(result.items).toEqual([]);
  });

  it("gracefully falls back to message search when the hash prefix matches no commit", async () => {
    mockGit.raw
      .mockResolvedValueOnce("10") // rev-list --count
      .mockRejectedValueOnce(new Error("fatal: Needed a single revision")) // rev-parse fails
      .mockResolvedValueOnce(
        makeLogOutput([
          {
            hash: "face123",
            short: "face123",
            msg: "fix: a face value",
            body: "",
            name: "Author",
            email: "a@b.com",
            date: "2024-01-15T12:00:00+00:00",
          },
        ])
      ); // log --grep

    const result = await listCommits({ cwd: "/test", branch: "main", search: "face" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].hash).toBe("face123");
    // Fallback must still pass the search term through to the grep pass.
    const grepCall = mockGit.raw.mock.calls[2][0] as string[];
    expect(grepCall).toContain("--grep=face");
    expect(grepCall).toContain("-i");
  });

  it("returns empty result on git error", async () => {
    mockGit.raw.mockRejectedValue(new Error("not a git repo"));

    const result = await listCommits({ cwd: "/invalid" });

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.total).toBe(0);
  });
});
