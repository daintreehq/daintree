import { describe, expect, it } from "vitest";

import { loadWorktreeStoreModule, makeBenchSnapshot } from "../lib/worktreeSidebarFixture";

/**
 * PERF-140/141 benchmark the real createWorktreeStore through an esbuild
 * bundle that stubs four renderer-only leaves. esbuild links every static
 * import regardless of reachability, so adding an import to
 * createWorktreeStore.ts breaks that bundle even though nothing in the
 * measured path calls it.
 *
 * That happened in 40352d377 and went unnoticed for months: the bundle is
 * only built by the scheduled Performance workflow, which gates nothing.
 * These tests link and exercise the bundle in normal PR CI so the next
 * missing stub export fails immediately, where someone will see it.
 */
describe("worktree store perf bundle", () => {
  it("links against the renderer stubs and drives the real store", async () => {
    const { createWorktreeStore } = await loadWorktreeStoreModule();
    const store = createWorktreeStore();

    const seed = Array.from({ length: 5 }, (_, i) => makeBenchSnapshot(i));
    store.getState().applySnapshot(seed, { epoch: "test", seq: 1 });

    const worktrees = store.getState().worktrees;
    expect(worktrees.size).toBe(seed.length);
    expect(worktrees.get("/bench/worktrees/wt-3")?.branch).toBe("bench-3");
  }, 60_000);

  it("commits a new Map only when an update actually changes the row", async () => {
    const { createWorktreeStore } = await loadWorktreeStoreModule();
    const store = createWorktreeStore();

    store.getState().applySnapshot([makeBenchSnapshot(0)], { epoch: "test", seq: 1 });
    const afterSeed = store.getState().worktrees;

    // Byte-identical re-apply: worktreeChangesEqual's fast path should keep
    // the existing Map, so downstream selectors don't re-render.
    store.getState().applyUpdate(makeBenchSnapshot(0), { epoch: "test", seq: 2 });
    expect(store.getState().worktrees).toBe(afterSeed);

    // A real change has to commit a new Map.
    store
      .getState()
      .applyUpdate(makeBenchSnapshot(0, { changedFileCount: 7, lastUpdated: 1_000_001 }), {
        epoch: "test",
        seq: 3,
      });
    const afterChange = store.getState().worktrees;
    expect(afterChange).not.toBe(afterSeed);
    expect(afterChange.get("/bench/worktrees/wt-0")?.modifiedCount).toBe(7);
  }, 60_000);
});
