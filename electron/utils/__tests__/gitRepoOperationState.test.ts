import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "fs";
import { join as pathJoin } from "path";
import { OPERATION_SENTINEL_NAMES, isRepoOperationInProgress } from "../gitRepoOperationState.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
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
    vi.mocked(existsSync).mockReturnValue(false);
    expect(isRepoOperationInProgress(gitDir)).toBe(false);
  });

  for (const sentinel of OPERATION_SENTINEL_NAMES) {
    it(`returns true when ${sentinel} exists`, () => {
      const expected = pathJoin(gitDir, sentinel);
      vi.mocked(existsSync).mockImplementation((p) => p === expected);
      expect(isRepoOperationInProgress(gitDir)).toBe(true);
    });
  }

  it("short-circuits on the first sentinel match", () => {
    // MERGE_HEAD is checked first — once it returns true the function should
    // not stat the remaining sentinel paths.
    vi.mocked(existsSync).mockImplementation((p) => p === pathJoin(gitDir, "MERGE_HEAD"));
    expect(isRepoOperationInProgress(gitDir)).toBe(true);
    expect(vi.mocked(existsSync)).toHaveBeenCalledTimes(1);
  });

  it("fails open when existsSync throws — treats sentinel as absent", () => {
    // EPERM or similar permission errors must not propagate; the caller
    // would otherwise stall every poll cycle for the worktree.
    vi.mocked(existsSync).mockImplementation(() => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    expect(() => isRepoOperationInProgress(gitDir)).not.toThrow();
    expect(isRepoOperationInProgress(gitDir)).toBe(false);
  });
});
