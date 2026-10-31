import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setDiffStatCacheLimitsForTesting,
  beginDiffStatPass,
  clearWorktreeDiffStatCache,
  getWorktreeDiffStatCacheStats,
  releaseWorktreeDiffStats,
  type TrackedDiffIdentity,
} from "../worktreeDiffStatCache.js";

const id = (overrides: Partial<TrackedDiffIdentity> = {}): TrackedDiffIdentity => ({
  headOid: "head-a",
  statusCode: " M",
  mtimeMs: 1000,
  size: 50,
  ...overrides,
});

function publishTracked(root: string, paths: string[], identity = id()): void {
  const pass = beginDiffStatPass(root);
  paths.forEach((path, i) => pass.keepTracked(path, identity, { insertions: i, deletions: 1 }));
  pass.publish();
}

function retainedTracked(root: string, paths: string[], identity = id()): string[] {
  const pass = beginDiffStatPass(root);
  return paths.filter((path) => pass.lookupTracked(path, identity) !== undefined);
}

describe("worktreeDiffStatCache", () => {
  beforeEach(() => {
    clearWorktreeDiffStatCache();
    __setDiffStatCacheLimitsForTesting();
  });

  afterEach(() => {
    __setDiffStatCacheLimitsForTesting();
    clearWorktreeDiffStatCache();
  });

  it("answers a later pass only while every identity field still matches", () => {
    const pass = beginDiffStatPass("/repo");
    pass.keepTracked("/repo/a.ts", id(), { insertions: 4, deletions: 2 });
    pass.publish();

    const next = beginDiffStatPass("/repo");
    expect(next.lookupTracked("/repo/a.ts", id())).toEqual({ insertions: 4, deletions: 2 });
    expect(next.lookupTracked("/repo/a.ts", id({ headOid: "head-b" }))).toBeUndefined();
    expect(next.lookupTracked("/repo/a.ts", id({ statusCode: "D " }))).toBeUndefined();
    expect(next.lookupTracked("/repo/a.ts", id({ mtimeMs: 1001 }))).toBeUndefined();
    expect(next.lookupTracked("/repo/a.ts", id({ size: 51 }))).toBeUndefined();
    expect(next.lookupTracked("/repo/b.ts", id())).toBeUndefined();
  });

  it("retains nothing from a pass that never publishes", () => {
    publishTracked("/repo", ["/repo/a.ts"]);

    const abandoned = beginDiffStatPass("/repo");
    abandoned.keepTracked("/repo/b.ts", id(), { insertions: 1, deletions: 0 });

    expect(retainedTracked("/repo", ["/repo/a.ts", "/repo/b.ts"])).toEqual(["/repo/a.ts"]);
  });

  it("replaces the snapshot, dropping paths that left the dirty set and old identities", () => {
    publishTracked("/repo", ["/repo/a.ts", "/repo/b.ts"]);
    publishTracked("/repo", ["/repo/a.ts"], id({ mtimeMs: 2000 }));

    expect(retainedTracked("/repo", ["/repo/a.ts", "/repo/b.ts"])).toEqual([]);
    expect(retainedTracked("/repo", ["/repo/a.ts"], id({ mtimeMs: 2000 }))).toEqual(["/repo/a.ts"]);
    expect(getWorktreeDiffStatCacheStats().trackedEntries).toBe(1);
  });

  it("keeps a changeset far past the old 2,000-entry limit whole", () => {
    const paths = Array.from({ length: 5_000 }, (_, i) => `/repo/src/f${i}.ts`);
    publishTracked("/repo", paths);

    expect(retainedTracked("/repo", paths)).toHaveLength(5_000);
  });

  it("never lets one worktree's pass touch a sibling's entries", () => {
    const sibling = (root: string) => Array.from({ length: 1_000 }, (_, i) => `${root}/f${i}.ts`);
    for (const root of ["/wt-1", "/wt-2", "/wt-3", "/wt-4"]) publishTracked(root, sibling(root));

    for (const root of ["/wt-1", "/wt-2", "/wt-3", "/wt-4"]) {
      expect(retainedTracked(root, sibling(root))).toHaveLength(1_000);
    }
  });

  it("caps entries per worktree by keeping the same leading paths", () => {
    __setDiffStatCacheLimitsForTesting({ maxTrackedPerWorktree: 3 });
    const paths = ["/repo/a", "/repo/b", "/repo/c", "/repo/d", "/repo/e"];
    publishTracked("/repo", paths);
    publishTracked("/repo", paths);

    expect(retainedTracked("/repo", paths)).toEqual(["/repo/a", "/repo/b", "/repo/c"]);
  });

  it("caps estimated bytes per worktree", () => {
    const paths = Array.from({ length: 100 }, (_, i) => `/repo/${"x".repeat(200)}-${i}`);
    publishTracked("/repo", paths);
    const perEntry = getWorktreeDiffStatCacheStats().estimatedBytes / 100;

    clearWorktreeDiffStatCache();
    __setDiffStatCacheLimitsForTesting({ maxBytesPerWorktree: perEntry * 10 });
    publishTracked("/repo", paths);

    const kept = retainedTracked("/repo", paths);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(10);
    expect(kept).toEqual(paths.slice(0, kept.length));
    expect(getWorktreeDiffStatCacheStats().estimatedBytes).toBeLessThanOrEqual(perEntry * 10);
  });

  it("admits a newcomer only into free global capacity, leaving residents intact", () => {
    const paths = (root: string) => Array.from({ length: 50 }, (_, i) => `${root}/f${i}.ts`);
    publishTracked("/wt-a", paths("/wt-a"));
    const residentBytes = getWorktreeDiffStatCacheStats().estimatedBytes;
    __setDiffStatCacheLimitsForTesting({ maxTotalBytes: Math.floor(residentBytes * 1.5) });

    publishTracked("/wt-b", paths("/wt-b"));

    expect(retainedTracked("/wt-a", paths("/wt-a"))).toHaveLength(50);
    const newcomer = retainedTracked("/wt-b", paths("/wt-b"));
    expect(newcomer.length).toBeGreaterThan(0);
    expect(newcomer.length).toBeLessThan(50);
    expect(getWorktreeDiffStatCacheStats().estimatedBytes).toBeLessThanOrEqual(
      Math.floor(residentBytes * 1.5)
    );
  });

  it("refuses a partition past the worktree limit instead of evicting one, until a slot frees", () => {
    __setDiffStatCacheLimitsForTesting({ maxWorktrees: 2 });
    publishTracked("/wt-a", ["/wt-a/f"]);
    publishTracked("/wt-b", ["/wt-b/f"]);
    publishTracked("/wt-c", ["/wt-c/f"]);

    expect(retainedTracked("/wt-a", ["/wt-a/f"])).toHaveLength(1);
    expect(retainedTracked("/wt-b", ["/wt-b/f"])).toHaveLength(1);
    expect(retainedTracked("/wt-c", ["/wt-c/f"])).toHaveLength(0);

    // A clean pass gives its slot back.
    beginDiffStatPass("/wt-a").publish();
    publishTracked("/wt-c", ["/wt-c/f"]);
    expect(getWorktreeDiffStatCacheStats().worktrees).toBe(2);
    expect(retainedTracked("/wt-c", ["/wt-c/f"])).toHaveLength(1);
  });

  it("does not let an older pass that finishes late replace a newer snapshot", () => {
    const older = beginDiffStatPass("/repo");
    older.keepTracked("/repo/a.ts", id(), { insertions: 1, deletions: 0 });
    const newer = beginDiffStatPass("/repo");
    newer.keepTracked("/repo/a.ts", id({ mtimeMs: 2000 }), { insertions: 9, deletions: 0 });

    newer.publish();
    older.publish();

    const reader = beginDiffStatPass("/repo");
    expect(reader.lookupTracked("/repo/a.ts", id())).toBeUndefined();
    expect(reader.lookupTracked("/repo/a.ts", id({ mtimeMs: 2000 }))).toEqual({
      insertions: 9,
      deletions: 0,
    });
  });

  it("does not let an older pass restore entries a newer pass found clean", () => {
    publishTracked("/repo", ["/repo/a.ts"]);
    const older = beginDiffStatPass("/repo");
    older.keepTracked("/repo/a.ts", id(), { insertions: 1, deletions: 0 });
    beginDiffStatPass("/repo").publish();

    older.publish();

    expect(getWorktreeDiffStatCacheStats().worktrees).toBe(0);

    // The same holds when the worktree had no partition to delete.
    const olderStill = beginDiffStatPass("/clean");
    olderStill.keepTracked("/clean/a.ts", id(), { insertions: 1, deletions: 0 });
    beginDiffStatPass("/clean").publish();
    olderStill.publish();

    expect(getWorktreeDiffStatCacheStats().worktrees).toBe(0);
  });

  it("releases a partition by the symlinked path a pass was asked about", () => {
    const pass = beginDiffStatPass("/private/wt-a", "/link/wt-a");
    pass.keepTracked("/private/wt-a/f", id(), { insertions: 1, deletions: 0 });
    pass.publish();
    publishTracked("/wt-b", ["/wt-b/f"]);

    releaseWorktreeDiffStats("/link/wt-a");

    expect(retainedTracked("/private/wt-a", ["/private/wt-a/f"])).toEqual([]);
    expect(retainedTracked("/wt-b", ["/wt-b/f"])).toEqual(["/wt-b/f"]);
    expect(getWorktreeDiffStatCacheStats().worktrees).toBe(1);
  });

  it("releases every partition a retargeted symlink published into", () => {
    for (const root of ["/private/wt-a", "/private/wt-b"]) {
      const pass = beginDiffStatPass(root, "/link/wt");
      pass.keepTracked(`${root}/f`, id(), { insertions: 1, deletions: 0 });
      pass.publish();
    }

    releaseWorktreeDiffStats("/link/wt");

    expect(getWorktreeDiffStatCacheStats()).toMatchObject({ worktrees: 0, estimatedBytes: 0 });
  });

  it("keeps a released worktree released when a pass begun before the release completes", () => {
    publishTracked("/wt-a", ["/wt-a/f"]);
    const inFlight = beginDiffStatPass("/wt-a");
    inFlight.keepTracked("/wt-a/f", id(), { insertions: 1, deletions: 0 });

    releaseWorktreeDiffStats("/wt-a");
    inFlight.publish();
    expect(getWorktreeDiffStatCacheStats().worktrees).toBe(0);

    const beforeClear = beginDiffStatPass("/wt-b");
    beforeClear.keepTracked("/wt-b/f", id(), { insertions: 1, deletions: 0 });
    clearWorktreeDiffStatCache();
    beforeClear.publish();

    expect(getWorktreeDiffStatCacheStats()).toEqual({
      worktrees: 0,
      trackedEntries: 0,
      untrackedEntries: 0,
      estimatedBytes: 0,
    });
  });

  it("keys untracked counts on content identity alone and caps them separately", () => {
    __setDiffStatCacheLimitsForTesting({ maxUntrackedPerWorktree: 2 });
    const pass = beginDiffStatPass("/repo");
    pass.keepUntracked("/repo/n1.md", 10, 5, 3);
    pass.keepUntracked("/repo/n2.md", 10, 5, 4);
    pass.keepUntracked("/repo/n3.md", 10, 5, 5);
    pass.keepTracked("/repo/a.ts", id(), { insertions: 1, deletions: 0 });
    pass.publish();

    const next = beginDiffStatPass("/repo");
    expect(next.lookupUntracked("/repo/n1.md", 10, 5)).toBe(3);
    expect(next.lookupUntracked("/repo/n2.md", 10, 6)).toBeUndefined();
    expect(next.lookupUntracked("/repo/n2.md", 11, 5)).toBeUndefined();
    expect(next.lookupUntracked("/repo/n3.md", 10, 5)).toBeUndefined();
    expect(next.lookupTracked("/repo/a.ts", id())).toBeDefined();
    expect(getWorktreeDiffStatCacheStats()).toMatchObject({
      trackedEntries: 1,
      untrackedEntries: 2,
    });
  });

  it("accounts bytes back to zero as partitions leave", () => {
    publishTracked("/wt-a", ["/wt-a/f1", "/wt-a/f2"]);
    publishTracked("/wt-b", ["/wt-b/f1"]);
    expect(getWorktreeDiffStatCacheStats().estimatedBytes).toBeGreaterThan(0);

    publishTracked("/wt-a", ["/wt-a/f1"]);
    releaseWorktreeDiffStats("/wt-b");
    beginDiffStatPass("/wt-a").publish();

    expect(getWorktreeDiffStatCacheStats().estimatedBytes).toBe(0);
  });
});
