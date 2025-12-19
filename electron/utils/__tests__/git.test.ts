import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGit = {
  raw: vi.fn(),
};

vi.mock("simple-git", () => {
  return {
    simpleGit: vi.fn(() => mockGit),
    default: vi.fn(() => mockGit),
  };
});

import { getLatestTrackedFileMtime } from "../git.js";
import { simpleGit } from "simple-git";

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
