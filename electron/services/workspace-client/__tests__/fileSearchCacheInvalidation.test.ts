import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { FileSearchCacheInvalidator } from "../fileSearchCacheInvalidation.js";

const invalidateUnder = vi.hoisted(() => vi.fn<(root: string) => void>());

vi.mock("../../FileSearchService.js", () => ({
  fileSearchService: { invalidateUnder },
}));

const WORKTREE = path.resolve("/projects/app/worktrees/feature");
const SIBLING = path.resolve("/projects/app/worktrees/other");

function makeInvalidator(): FileSearchCacheInvalidator {
  return new FileSearchCacheInvalidator();
}

describe("FileSearchCacheInvalidator", () => {
  beforeEach(() => {
    invalidateUnder.mockClear();
  });

  describe("handleWorktreeUpdate", () => {
    it("drops the index when the watcher reports a change", () => {
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 1_000 });

      expect(invalidateUnder).toHaveBeenCalledTimes(1);
      expect(invalidateUnder).toHaveBeenCalledWith(WORKTREE);
    });

    it("ignores a snapshot repeating the previous timestamp", () => {
      // `worktree-update` also carries branch, PR-state and rate-limit changes.
      // Those repeat the last stamp, and invalidating on them would defeat the
      // cache on churn that never touched a file.
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 1_000 });
      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 1_000 });
      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 1_000 });

      expect(invalidateUnder).toHaveBeenCalledTimes(1);
    });

    it("drops again on the next advance", () => {
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 1_000 });
      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 1_001 });

      expect(invalidateUnder).toHaveBeenCalledTimes(2);
    });

    it("ignores the monitor's initial zero and an absent timestamp", () => {
      // Zero is "the recursive watcher has never fired here" — a background
      // worktree on the git-only watch reports it forever. Treating it as a
      // change would drop that worktree's index on every unrelated snapshot.
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 0 });
      invalidator.handleWorktreeUpdate({ path: WORKTREE });

      expect(invalidateUnder).not.toHaveBeenCalled();
    });

    it("ignores a snapshot with no path", () => {
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate({ path: "", workingTreeChangedAt: 1_000 });

      expect(invalidateUnder).not.toHaveBeenCalled();
    });

    it("tracks each worktree separately", () => {
      // One shared "last seen" value would let a busy worktree's stamp suppress
      // a quiet one's first real change.
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 5_000 });
      invalidator.handleWorktreeUpdate({ path: SIBLING, workingTreeChangedAt: 5_000 });

      expect(invalidateUnder.mock.calls.map(([root]) => root)).toEqual([WORKTREE, SIBLING]);
    });

    it("drops when a restarted monitor re-stamps below the last value", () => {
      // The stamp is `Math.max(Date.now(), prev + 1)` per monitor, so a fresh
      // monitor behind a backwards clock step can report a lower number. An
      // advance-only test would strand that worktree's index indefinitely.
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 9_000 });
      invalidateUnder.mockClear();

      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 4_000 });

      expect(invalidateUnder).toHaveBeenCalledWith(WORKTREE);
    });

    it("resolves the path before invalidating", () => {
      const invalidator = makeInvalidator();
      const unresolved = `${WORKTREE}${path.sep}nested${path.sep}..`;

      invalidator.handleWorktreeUpdate({ path: unresolved, workingTreeChangedAt: 1_000 });

      expect(invalidateUnder).toHaveBeenCalledWith(WORKTREE);
    });
  });

  describe("handleWorktreeRemoved", () => {
    it("drops the removed worktree's index", () => {
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeRemoved(WORKTREE);

      expect(invalidateUnder).toHaveBeenCalledWith(WORKTREE);
    });

    it("forgets the timestamp so a re-added worktree invalidates again", () => {
      // A worktree removed and recreated at the same path gets a fresh monitor.
      // A retained stamp could equal the new one and suppress the first real
      // change after the re-add.
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 7_000 });
      invalidator.handleWorktreeRemoved(WORKTREE);
      invalidateUnder.mockClear();

      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 7_000 });

      expect(invalidateUnder).toHaveBeenCalledWith(WORKTREE);
    });
  });

  describe("handleProjectClosed", () => {
    it("drops the project tree's indexes", () => {
      const invalidator = makeInvalidator();
      const project = path.resolve("/projects/app");

      invalidator.handleProjectClosed(project);

      expect(invalidateUnder).toHaveBeenCalledWith(project);
    });

    it("forgets bookkeeping inside the project but not outside it", () => {
      const invalidator = makeInvalidator();
      const project = path.resolve("/projects/app");
      const outside = path.resolve("/projects/app-worktrees/feature");

      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 3_000 });
      invalidator.handleWorktreeUpdate({ path: outside, workingTreeChangedAt: 3_000 });
      invalidator.handleProjectClosed(project);
      invalidateUnder.mockClear();

      // Inside the closed project: bookkeeping cleared, so the repeated stamp
      // reads as new. Outside it: still remembered, so the repeat is ignored.
      invalidator.handleWorktreeUpdate({ path: WORKTREE, workingTreeChangedAt: 3_000 });
      invalidator.handleWorktreeUpdate({ path: outside, workingTreeChangedAt: 3_000 });

      expect(invalidateUnder.mock.calls.map(([root]) => root)).toEqual([WORKTREE]);
    });

    it("ignores an empty project path", () => {
      const invalidator = makeInvalidator();

      invalidator.handleProjectClosed("");

      expect(invalidateUnder).not.toHaveBeenCalled();
    });
  });
});
