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

import { getLatestTrackedFileMtime, getWorktreeChangesWithStats } from "../git.js";
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
