import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync } from "fs";
import { join as pathJoin } from "path";
import {
  OPERATION_SENTINEL_NAMES,
  isRepoOperationInProgress,
  getRepoOperationStateSync,
} from "../gitRepoOperationState.js";

vi.mock("fs", () => ({
  readdirSync: vi.fn(),
}));

describe("gitRepoOperationState", () => {
  const gitDir = pathJoin("/repo", ".git");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes the expected sentinel names", () => {
    // index.lock and REBASE_HEAD must NOT be in the set — they're either too
    // transient (index.lock) or redundant (REBASE_HEAD is replaced by the
    // rebase-merge/rebase-apply directories).
    expect([...OPERATION_SENTINEL_NAMES]).toEqual([
      "MERGE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
    ]);
  });

  it("returns false when no sentinel files exist", () => {
    vi.mocked(readdirSync).mockReturnValue(["HEAD", "config", "refs"] as never);
    expect(isRepoOperationInProgress(gitDir)).toBe(false);
  });

  for (const sentinel of OPERATION_SENTINEL_NAMES) {
    it(`returns true when ${sentinel} exists`, () => {
      vi.mocked(readdirSync).mockReturnValue(["HEAD", sentinel] as never);
      expect(isRepoOperationInProgress(gitDir)).toBe(true);
    });
  }

  it("lists the directory exactly once per call", () => {
    // The whole point of the readdir approach: one syscall per poll, not one
    // existsSync per sentinel.
    vi.mocked(readdirSync).mockReturnValue(["HEAD", "MERGE_HEAD"] as never);
    expect(isRepoOperationInProgress(gitDir)).toBe(true);
    expect(vi.mocked(readdirSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readdirSync)).toHaveBeenCalledWith(gitDir);
  });

  it("fails open when readdirSync throws — treats sentinels as absent", () => {
    // EPERM or similar permission errors must not propagate; the caller
    // would otherwise stall every poll cycle for the worktree.
    vi.mocked(readdirSync).mockImplementation(() => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    expect(() => isRepoOperationInProgress(gitDir)).not.toThrow();
    expect(isRepoOperationInProgress(gitDir)).toBe(false);
    expect(getRepoOperationStateSync(gitDir)).toBeUndefined();
  });

  describe("getRepoOperationStateSync", () => {
    it("returns undefined when no sentinel files exist", () => {
      vi.mocked(readdirSync).mockReturnValue(["HEAD", "config"] as never);
      expect(getRepoOperationStateSync(gitDir)).toBeUndefined();
    });

    it.each([
      ["rebase-merge", "REBASING"],
      ["rebase-apply", "REBASING"],
      ["CHERRY_PICK_HEAD", "CHERRY_PICKING"],
      ["REVERT_HEAD", "REVERTING"],
      ["MERGE_HEAD", "MERGING"],
    ])("classifies %s as %s", (sentinel, expected) => {
      vi.mocked(readdirSync).mockReturnValue(["HEAD", sentinel] as never);
      expect(getRepoOperationStateSync(gitDir)).toBe(expected);
    });

    it("prioritizes rebase over merge when both sentinels are present", () => {
      // An interrupted rebase can leave MERGE_HEAD alongside rebase-merge;
      // classification order matches the async detectRepoOperationState.
      vi.mocked(readdirSync).mockReturnValue(["MERGE_HEAD", "rebase-merge"] as never);
      expect(getRepoOperationStateSync(gitDir)).toBe("REBASING");
    });
  });
});
