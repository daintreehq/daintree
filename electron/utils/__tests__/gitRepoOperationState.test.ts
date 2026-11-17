import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readdirSync } from "fs";
import { access, readdir } from "fs/promises";
import { join as pathJoin } from "path";
import {
  OPERATION_SENTINEL_NAMES,
  isRepoOperationInProgress,
  getRepoOperationStateSync,
  getRepoOperationState,
} from "../gitRepoOperationState.js";

vi.mock("fs", () => ({
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readdir: vi.fn(),
  access: vi.fn(),
}));

describe("gitRepoOperationState", () => {
  const gitDir = pathJoin("/repo", ".git");
  const amMarker = pathJoin(gitDir, "rebase-apply", "applying");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(access).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
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

    it("classifies rebase-apply holding git am's applying marker as APPLYING_MAILBOX", () => {
      vi.mocked(readdirSync).mockReturnValue(["HEAD", "rebase-apply"] as never);
      vi.mocked(existsSync).mockImplementation((p) => p === amMarker);
      expect(getRepoOperationStateSync(gitDir)).toBe("APPLYING_MAILBOX");
    });

    it("probes for the am marker only when rebase-apply exists", () => {
      vi.mocked(readdirSync).mockReturnValue(["HEAD", "rebase-merge"] as never);
      expect(getRepoOperationStateSync(gitDir)).toBe("REBASING");
      expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
    });

    it("prioritizes rebase over merge when both sentinels are present", () => {
      // An interrupted rebase can leave MERGE_HEAD alongside rebase-merge;
      // classification order matches the async detectRepoOperationState.
      vi.mocked(readdirSync).mockReturnValue(["MERGE_HEAD", "rebase-merge"] as never);
      expect(getRepoOperationStateSync(gitDir)).toBe("REBASING");
    });
  });

  describe("getRepoOperationState", () => {
    it("classifies from an async listing without touching readdirSync", async () => {
      vi.mocked(readdir).mockResolvedValue(["HEAD", "MERGE_HEAD", "rebase-apply"] as never);
      await expect(getRepoOperationState(gitDir)).resolves.toBe("REBASING");
      expect(vi.mocked(readdir)).toHaveBeenCalledWith(gitDir);
      expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    });

    it("returns undefined when no sentinel files exist", async () => {
      vi.mocked(readdir).mockResolvedValue(["HEAD", "config"] as never);
      await expect(getRepoOperationState(gitDir)).resolves.toBeUndefined();
    });

    it("classifies rebase-apply holding git am's applying marker as APPLYING_MAILBOX", async () => {
      vi.mocked(readdir).mockResolvedValue(["HEAD", "rebase-apply"] as never);
      vi.mocked(access).mockImplementation((p) =>
        p === amMarker ? Promise.resolve() : Promise.reject(new Error("ENOENT"))
      );
      await expect(getRepoOperationState(gitDir)).resolves.toBe("APPLYING_MAILBOX");
    });

    it("keeps rebase-apply without the am marker as REBASING", async () => {
      vi.mocked(readdir).mockResolvedValue(["HEAD", "rebase-apply"] as never);
      await expect(getRepoOperationState(gitDir)).resolves.toBe("REBASING");
      expect(vi.mocked(access)).toHaveBeenCalledWith(amMarker);
    });

    it("probes for the am marker only when rebase-apply exists", async () => {
      vi.mocked(readdir).mockResolvedValue(["HEAD", "MERGE_HEAD"] as never);
      await expect(getRepoOperationState(gitDir)).resolves.toBe("MERGING");
      expect(vi.mocked(access)).not.toHaveBeenCalled();
    });

    it("joins an outstanding read instead of starting another", async () => {
      let resolveListing!: (names: string[]) => void;
      vi.mocked(readdir).mockReturnValue(
        new Promise((resolve) => (resolveListing = resolve)) as never
      );
      const first = getRepoOperationState(gitDir);
      const second = getRepoOperationState(gitDir);
      resolveListing(["HEAD", "REVERT_HEAD"]);

      await expect(first).resolves.toBe("REVERTING");
      await expect(second).resolves.toBe("REVERTING");
      expect(vi.mocked(readdir)).toHaveBeenCalledTimes(1);

      vi.mocked(readdir).mockResolvedValue(["HEAD"] as never);
      await expect(getRepoOperationState(gitDir)).resolves.toBeUndefined();
      expect(vi.mocked(readdir)).toHaveBeenCalledTimes(2);
    });

    it("fails open when the listing rejects", async () => {
      vi.mocked(readdir).mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" }));
      await expect(getRepoOperationState(gitDir)).resolves.toBeUndefined();
    });
  });
});
