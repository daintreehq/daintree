import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitError, WorktreeRemovedError } from "../errorTypes.js";

const mockGit = {
  raw: vi.fn(),
  status: vi.fn(),
  diff: vi.fn(),
  revparse: vi.fn(),
};

vi.mock("../hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockGit),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
    promises: {
      ...(actual as { promises: Record<string, unknown> }).promises,
      access: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtimeMs: 1000 }),
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
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 1000 });
  });

  it("passes --no-ext-diff in numstat diff call", async () => {
    await getWorktreeChangesWithStats("/test/path", true);

    expect(mockGit.diff).toHaveBeenCalledWith(
      expect.arrayContaining(["--no-ext-diff", "--numstat"])
    );
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

  it("passes --grep when search is provided", async () => {
    mockGit.raw.mockResolvedValueOnce("0").mockResolvedValueOnce("");

    await listCommits({ cwd: "/test", branch: "main", search: "bugfix" });

    const logCall = mockGit.raw.mock.calls[1][0] as string[];
    expect(logCall).toContain("--grep=bugfix");
    expect(logCall).toContain("-i");
  });

  it("returns empty result on git error", async () => {
    mockGit.raw.mockRejectedValue(new Error("not a git repo"));

    const result = await listCommits({ cwd: "/invalid" });

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.total).toBe(0);
  });
});
