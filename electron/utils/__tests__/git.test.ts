import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorktreeRemovedError } from "../errorTypes.js";

const mockGit = {
  raw: vi.fn(),
  status: vi.fn(),
  diff: vi.fn(),
  revparse: vi.fn(),
};

vi.mock("simple-git", () => {
  return {
    simpleGit: vi.fn(() => mockGit),
    default: vi.fn(() => mockGit),
  };
});

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

import { getLatestTrackedFileMtime, getWorktreeChangesWithStats, listCommits } from "../git.js";
import { simpleGit } from "simple-git";
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
    expect(simpleGit).toHaveBeenCalledWith("/test/path");
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
