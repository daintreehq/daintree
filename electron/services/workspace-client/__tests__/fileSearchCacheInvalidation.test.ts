import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import {
  FileSearchCacheInvalidator,
  type FileSearchInvalidationSnapshot,
  type FileSearchInvalidationSource,
} from "../fileSearchCacheInvalidation.js";

const invalidateUnder = vi.hoisted(() => vi.fn<(root: string) => void>());

vi.mock("../../FileSearchService.js", () => ({
  fileSearchService: { invalidateUnder },
}));

const PROJECT = path.resolve("/projects/app");
const OTHER_PROJECT = path.resolve("/projects/other");
const WORKTREE = path.resolve("/projects/app/worktrees/feature");
const SIBLING_TREE = path.resolve("/projects/app-worktrees/feature");
const EPOCH = "epoch-1";

function makeInvalidator(): FileSearchCacheInvalidator {
  return new FileSearchCacheInvalidator();
}

/** A snapshot from a settled, watched, currently-selected worktree. */
function snapshot(
  overrides: Partial<FileSearchInvalidationSnapshot> = {}
): FileSearchInvalidationSnapshot {
  return {
    path: WORKTREE,
    workingTreeChangedAt: 1_000,
    generation: 1,
    isCurrent: true,
    ...overrides,
  };
}

function source(
  overrides: Partial<FileSearchInvalidationSource> = {}
): FileSearchInvalidationSource {
  return { projectPath: PROJECT, hostEpoch: EPOCH, ...overrides };
}

/** Establish a baseline record so the next call is a transition, not a first sighting. */
function seed(
  invalidator: FileSearchCacheInvalidator,
  overrides: Partial<FileSearchInvalidationSnapshot> = {},
  sourceOverrides: Partial<FileSearchInvalidationSource> = {}
): void {
  invalidator.handleWorktreeUpdate(snapshot(overrides), source(sourceOverrides));
  invalidateUnder.mockClear();
}

describe("FileSearchCacheInvalidator", () => {
  beforeEach(() => {
    invalidateUnder.mockClear();
  });

  describe("watcher flushes", () => {
    it("drops the index on the first reported change", () => {
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate(snapshot(), source());

      expect(invalidateUnder).toHaveBeenCalledExactlyOnceWith(WORKTREE);
    });

    it("ignores a snapshot repeating the previous timestamp", () => {
      // `worktree-update` also carries branch, PR-state and rate-limit changes.
      // Those repeat the last stamp, and invalidating on them would defeat the
      // cache on churn that never touched a file.
      const invalidator = makeInvalidator();
      seed(invalidator);

      invalidator.handleWorktreeUpdate(snapshot(), source());
      invalidator.handleWorktreeUpdate(snapshot(), source());

      expect(invalidateUnder).not.toHaveBeenCalled();
    });

    it("drops again on the next flush", () => {
      const invalidator = makeInvalidator();
      seed(invalidator);

      invalidator.handleWorktreeUpdate(snapshot({ workingTreeChangedAt: 1_001 }), source());

      expect(invalidateUnder).toHaveBeenCalledExactlyOnceWith(WORKTREE);
    });

    it("drops when a restarted monitor re-stamps below the last value", () => {
      // The stamp is `Math.max(Date.now(), prev + 1)` per monitor, so a fresh
      // monitor behind a backwards clock step reports a lower number. An
      // advance-only test would strand that worktree's index.
      const invalidator = makeInvalidator();
      seed(invalidator, { workingTreeChangedAt: 9_000 });

      invalidator.handleWorktreeUpdate(snapshot({ workingTreeChangedAt: 4_000 }), source());

      expect(invalidateUnder).toHaveBeenCalledWith(WORKTREE);
    });

    it("stays quiet on a first sighting that reports no flush", () => {
      // Zero is "the recursive watcher has never fired here" — a background
      // worktree on the git-only watch reports it forever. Dropping on it would
      // wipe every index a project rebuild just warmed.
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate(snapshot({ workingTreeChangedAt: 0 }), source());
      invalidator.handleWorktreeUpdate(snapshot({ workingTreeChangedAt: undefined }), source());

      expect(invalidateUnder).not.toHaveBeenCalled();
    });

    it("ignores a snapshot with no path or no owning project", () => {
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate(snapshot({ path: "" }), source());
      invalidator.handleWorktreeUpdate(snapshot(), source({ projectPath: "" }));

      expect(invalidateUnder).not.toHaveBeenCalled();
    });

    it("resolves the path before invalidating", () => {
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeUpdate(
        snapshot({ path: `${WORKTREE}${path.sep}nested${path.sep}..` }),
        source()
      );

      expect(invalidateUnder).toHaveBeenCalledWith(WORKTREE);
    });
  });

  describe("gaps in watcher coverage", () => {
    it("drops when the host restarts", () => {
      // A new epoch means the workspace host went down. Its fresh monitor's
      // stamp starts from zero, so nothing written during the downtime is ever
      // reported — without this the cache serves a pre-crash listing.
      const invalidator = makeInvalidator();
      seed(invalidator);

      invalidator.handleWorktreeUpdate(snapshot(), source({ hostEpoch: "epoch-2" }));

      expect(invalidateUnder).toHaveBeenCalledExactlyOnceWith(WORKTREE);
    });

    it("drops when the monitor is rebuilt at the same path", () => {
      const invalidator = makeInvalidator();
      seed(invalidator);

      invalidator.handleWorktreeUpdate(snapshot({ generation: 2 }), source());

      expect(invalidateUnder).toHaveBeenCalledExactlyOnceWith(WORKTREE);
    });

    it("drops when a background worktree becomes current again", () => {
      // The recursive watch is armed for elevated worktrees only. While this one
      // sat in the background an external write could land with no flush to
      // report it, and selecting it back is both when that gap closes and when
      // the user is about to search it.
      const invalidator = makeInvalidator();
      seed(invalidator, { isCurrent: false });

      invalidator.handleWorktreeUpdate(snapshot({ isCurrent: true }), source());

      expect(invalidateUnder).toHaveBeenCalledExactlyOnceWith(WORKTREE);
    });

    it("does not drop when a worktree merely stops being current", () => {
      // Leaving a worktree costs nothing — we were watching it right up to the
      // moment we stopped, so what is cached is still accurate.
      const invalidator = makeInvalidator();
      seed(invalidator, { isCurrent: true });

      invalidator.handleWorktreeUpdate(snapshot({ isCurrent: false }), source());

      expect(invalidateUnder).not.toHaveBeenCalled();
    });

    it("does not drop while a worktree stays current", () => {
      const invalidator = makeInvalidator();
      seed(invalidator, { isCurrent: true });

      invalidator.handleWorktreeUpdate(snapshot({ isCurrent: true }), source());

      expect(invalidateUnder).not.toHaveBeenCalled();
    });
  });

  describe("multiple producers for one path", () => {
    it("does not let two hosts' timestamps alternate into constant invalidation", () => {
      // Opening a repository and one of its linked worktrees as separate
      // projects gives the pool two hosts, and both enumerate the same worktree.
      // Under a single per-path record their independent stamps alternate and
      // every unrelated snapshot reads as a change.
      const invalidator = makeInvalidator();
      const hostA = source({ projectPath: PROJECT });
      const hostB = source({ projectPath: OTHER_PROJECT });

      invalidator.handleWorktreeUpdate(snapshot({ workingTreeChangedAt: 1_000 }), hostA);
      invalidator.handleWorktreeUpdate(snapshot({ workingTreeChangedAt: 1_001 }), hostB);
      invalidateUnder.mockClear();

      for (let i = 0; i < 5; i += 1) {
        invalidator.handleWorktreeUpdate(snapshot({ workingTreeChangedAt: 1_000 }), hostA);
        invalidator.handleWorktreeUpdate(snapshot({ workingTreeChangedAt: 1_001 }), hostB);
      }

      expect(invalidateUnder).not.toHaveBeenCalled();
    });

    it("still drops when either producer reports a real change", () => {
      const invalidator = makeInvalidator();
      const hostB = source({ projectPath: OTHER_PROJECT });
      seed(invalidator, { workingTreeChangedAt: 1_001 }, { projectPath: OTHER_PROJECT });

      invalidator.handleWorktreeUpdate(snapshot({ workingTreeChangedAt: 1_002 }), hostB);

      expect(invalidateUnder).toHaveBeenCalledWith(WORKTREE);
    });
  });

  describe("handleWorktreeRemoved", () => {
    it("drops the removed worktree's index", () => {
      const invalidator = makeInvalidator();

      invalidator.handleWorktreeRemoved(WORKTREE);

      expect(invalidateUnder).toHaveBeenCalledWith(WORKTREE);
    });

    it("forgets the path under every producer, so a recreation is not a continuation", () => {
      const invalidator = makeInvalidator();
      seed(invalidator, { workingTreeChangedAt: 7_000 });
      seed(invalidator, { workingTreeChangedAt: 7_000 }, { projectPath: OTHER_PROJECT });

      invalidator.handleWorktreeRemoved(WORKTREE);
      invalidateUnder.mockClear();

      // A worktree recreated at the same location gets a fresh monitor. With a
      // retained record its stamp could equal the old one and suppress the first
      // real change after the re-add.
      invalidator.handleWorktreeUpdate(snapshot({ workingTreeChangedAt: 7_000 }), source());

      expect(invalidateUnder).toHaveBeenCalledWith(WORKTREE);
    });
  });

  describe("handleProjectClosed", () => {
    it("drops every worktree the project owns, including ones outside its directory", () => {
      // Daintree's own worktrees live in a sibling `-worktrees` folder, so an
      // ancestry test would leave exactly the trees the user works in behind.
      const invalidator = makeInvalidator();
      seed(invalidator, { path: WORKTREE });
      seed(invalidator, { path: SIBLING_TREE, workingTreeChangedAt: 2_000 });

      invalidator.handleProjectClosed(PROJECT);

      expect(invalidateUnder.mock.calls.map(([root]) => root)).toEqual(
        expect.arrayContaining([WORKTREE, SIBLING_TREE, PROJECT])
      );
    });

    it("leaves another project's worktrees alone", () => {
      const invalidator = makeInvalidator();
      const foreignTree = path.resolve("/projects/other/worktrees/x");
      seed(invalidator, { path: foreignTree }, { projectPath: OTHER_PROJECT });

      invalidator.handleProjectClosed(PROJECT);

      expect(invalidateUnder).not.toHaveBeenCalledWith(foreignTree);
    });

    it("forgets the closed project's bookkeeping but keeps the other project's", () => {
      const invalidator = makeInvalidator();
      seed(invalidator, { path: WORKTREE });
      seed(invalidator, { path: WORKTREE }, { projectPath: OTHER_PROJECT });

      invalidator.handleProjectClosed(PROJECT);
      invalidateUnder.mockClear();

      // The closed project's record is gone, so the repeated stamp reads as a
      // first sighting and drops. The other project still remembers it.
      invalidator.handleWorktreeUpdate(snapshot(), source());
      const afterReopen = invalidateUnder.mock.calls.length;
      invalidator.handleWorktreeUpdate(snapshot(), source({ projectPath: OTHER_PROJECT }));

      expect(afterReopen).toBe(1);
      expect(invalidateUnder).toHaveBeenCalledTimes(1);
    });

    it("drops the project root even when no worktree ever reported it", () => {
      // A search can be rooted at the project directory itself.
      const invalidator = makeInvalidator();

      invalidator.handleProjectClosed(PROJECT);

      expect(invalidateUnder).toHaveBeenCalledWith(PROJECT);
    });

    it("ignores an empty project path", () => {
      const invalidator = makeInvalidator();

      invalidator.handleProjectClosed("");

      expect(invalidateUnder).not.toHaveBeenCalled();
    });
  });
});
