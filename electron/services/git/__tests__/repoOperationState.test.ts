import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import { detectRepoOperationState } from "../repoOperationState.js";

const accessMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  default: {
    promises: {
      access: accessMock,
      readFile: readFileMock,
    },
  },
  promises: {
    access: accessMock,
    readFile: readFileMock,
  },
}));

describe("detectRepoOperationState", () => {
  const gitDir = path.join("/repo", ".git");

  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(new Error("ENOENT"));
  });

  it("returns CLEAN when no sentinels exist and hasUnmerged is false", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const result = await detectRepoOperationState(gitDir, false);
    expect(result).toEqual({
      state: "CLEAN",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });
  });

  it("returns DIRTY when no sentinels exist but hasUnmerged is true", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const result = await detectRepoOperationState(gitDir, true);
    expect(result).toEqual({
      state: "DIRTY",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });
  });

  it("detects MERGING when MERGE_HEAD exists", async () => {
    accessMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "MERGE_HEAD")) return Promise.resolve();
      return Promise.reject(new Error("ENOENT"));
    });
    const result = await detectRepoOperationState(gitDir, false);
    expect(result).toEqual({
      state: "MERGING",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });
  });

  it("detects CHERRY_PICKING when CHERRY_PICK_HEAD exists", async () => {
    accessMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "CHERRY_PICK_HEAD")) return Promise.resolve();
      return Promise.reject(new Error("ENOENT"));
    });
    const result = await detectRepoOperationState(gitDir, false);
    expect(result).toEqual({
      state: "CHERRY_PICKING",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });
  });

  it("detects REVERTING when REVERT_HEAD exists", async () => {
    accessMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "REVERT_HEAD")) return Promise.resolve();
      return Promise.reject(new Error("ENOENT"));
    });
    const result = await detectRepoOperationState(gitDir, false);
    expect(result).toEqual({
      state: "REVERTING",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });
  });

  it("detects REBASING when rebase-merge exists with progress", async () => {
    accessMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "rebase-merge")) return Promise.resolve();
      return Promise.reject(new Error("ENOENT"));
    });
    readFileMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "rebase-merge", "msgnum")) return Promise.resolve("3\n");
      if (p === path.join(gitDir, "rebase-merge", "end")) return Promise.resolve("7\n");
      return Promise.reject(new Error("ENOENT"));
    });
    const result = await detectRepoOperationState(gitDir, false);
    expect(result).toEqual({
      state: "REBASING",
      rebaseStep: 3,
      rebaseTotalSteps: 7,
      rebaseSequence: null,
    });
  });

  it("detects REBASING when rebase-apply exists with progress", async () => {
    accessMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "rebase-apply")) return Promise.resolve();
      return Promise.reject(new Error("ENOENT"));
    });
    readFileMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "rebase-apply", "next")) return Promise.resolve("2\n");
      if (p === path.join(gitDir, "rebase-apply", "last")) return Promise.resolve("5\n");
      return Promise.reject(new Error("ENOENT"));
    });
    const result = await detectRepoOperationState(gitDir, false);
    expect(result).toEqual({
      state: "REBASING",
      rebaseStep: 2,
      rebaseTotalSteps: 5,
      rebaseSequence: null,
    });
  });

  it("rebasing takes precedence over merging when both sentinels exist", async () => {
    accessMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "rebase-merge") || p === path.join(gitDir, "MERGE_HEAD"))
        return Promise.resolve();
      return Promise.reject(new Error("ENOENT"));
    });
    readFileMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "rebase-merge", "msgnum")) return Promise.resolve("1\n");
      if (p === path.join(gitDir, "rebase-merge", "end")) return Promise.resolve("4\n");
      return Promise.reject(new Error("ENOENT"));
    });
    const result = await detectRepoOperationState(gitDir, false);
    expect(result.state).toBe("REBASING");
  });

  it("returns null step/total when progress files are missing", async () => {
    accessMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "rebase-merge")) return Promise.resolve();
      return Promise.reject(new Error("ENOENT"));
    });
    const result = await detectRepoOperationState(gitDir, false);
    expect(result.state).toBe("REBASING");
    expect(result.rebaseStep).toBeNull();
    expect(result.rebaseTotalSteps).toBeNull();
  });

  it("returns null for non-finite progress values", async () => {
    accessMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "rebase-merge")) return Promise.resolve();
      return Promise.reject(new Error("ENOENT"));
    });
    readFileMock.mockImplementation((p: string) => {
      if (p === path.join(gitDir, "rebase-merge", "msgnum")) return Promise.resolve("abc\n");
      if (p === path.join(gitDir, "rebase-merge", "end")) return Promise.resolve("xyz\n");
      return Promise.reject(new Error("ENOENT"));
    });
    const result = await detectRepoOperationState(gitDir, false);
    expect(result.rebaseStep).toBeNull();
    expect(result.rebaseTotalSteps).toBeNull();
  });
});
