import { describe, expect, it } from "vitest";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";

function makeSnapshot(id: string): WorktreeSnapshot {
  return {
    id,
    name: id,
    branch: "main",
    path: `/repo/${id}`,
    isCurrent: false,
    isMainWorktree: false,
    modifiedCount: 0,
    changes: [],
    summary: "",
    mood: null,
    gitDir: "",
  } as unknown as WorktreeSnapshot;
}

describe("createWorktreeStore — reconnecting state", () => {
  it("starts with isReconnecting=false", () => {
    const store = createWorktreeStore();
    expect(store.getState().isReconnecting).toBe(false);
  });

  it("setReconnecting(true) flips the flag", () => {
    const store = createWorktreeStore();
    store.getState().setReconnecting(true);
    expect(store.getState().isReconnecting).toBe(true);
  });

  it("applySnapshot clears isReconnecting after successful hydration", () => {
    const store = createWorktreeStore();
    store.getState().setReconnecting(true);
    expect(store.getState().isReconnecting).toBe(true);

    const version = store.getState().nextVersion();
    store.getState().applySnapshot([makeSnapshot("wt-1")], version);

    expect(store.getState().isReconnecting).toBe(false);
    expect(store.getState().isInitialized).toBe(true);
    expect(store.getState().worktrees.size).toBe(1);
  });

  it("applySnapshot with stale version does NOT clear isReconnecting", () => {
    const store = createWorktreeStore();

    // Advance version by applying a first snapshot
    const v1 = store.getState().nextVersion();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);

    // Start reconnecting, then deliver a stale snapshot (lower/equal version)
    store.getState().setReconnecting(true);
    store.getState().applySnapshot([makeSnapshot("wt-stale")], v1);

    expect(store.getState().isReconnecting).toBe(true);
  });

  it("applyUpdate does NOT clear isReconnecting (only applySnapshot does)", () => {
    const store = createWorktreeStore();

    // Seed with a worktree so applyUpdate can modify it
    const v1 = store.getState().nextVersion();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);

    store.getState().setReconnecting(true);
    const v2 = store.getState().nextVersion();
    store.getState().applyUpdate(makeSnapshot("wt-1"), v2);

    expect(store.getState().isReconnecting).toBe(true);
  });

  it("setReconnecting(false) clears the flag independently", () => {
    const store = createWorktreeStore();
    store.getState().setReconnecting(true);
    store.getState().setReconnecting(false);
    expect(store.getState().isReconnecting).toBe(false);
  });
});

describe("createWorktreeStore — fatal error state", () => {
  it("setFatalError sets error, clears isReconnecting, and resets isInitialized", () => {
    const store = createWorktreeStore();

    // Simulate a fully-hydrated store before the host crashes
    const v1 = store.getState().nextVersion();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);
    store.getState().setReconnecting(true);
    expect(store.getState().isInitialized).toBe(true);

    store.getState().setFatalError("host crashed");

    expect(store.getState().error).toBe("host crashed");
    expect(store.getState().isReconnecting).toBe(false);
    // isInitialized must be reset so the next fetch is treated as a cold
    // start, not a silent wake refresh (which swallows fetch errors).
    expect(store.getState().isInitialized).toBe(false);
  });

  it("setFatalError clears isLoading so the error UI surfaces before first hydration", () => {
    // If the host exhausts its restart budget before the first snapshot
    // ever arrives, `isLoading` is still `true` and `worktrees` is empty.
    // `SidebarContent` checks `isLoading && worktrees.length === 0` BEFORE
    // the error branch — so without clearing `isLoading`, the Restart
    // Service button would never appear.
    const store = createWorktreeStore();
    expect(store.getState().isLoading).toBe(true);
    expect(store.getState().worktrees.size).toBe(0);

    store.getState().setFatalError("host crashed before first fetch");

    expect(store.getState().isLoading).toBe(false);
    expect(store.getState().error).toBe("host crashed before first fetch");
  });

  it("applySnapshot after setFatalError clears error and restores isInitialized", () => {
    const store = createWorktreeStore();
    store.getState().setFatalError("host crashed");
    expect(store.getState().error).toBe("host crashed");
    expect(store.getState().isInitialized).toBe(false);

    const version = store.getState().nextVersion();
    store.getState().applySnapshot([makeSnapshot("wt-1")], version);

    expect(store.getState().error).toBeNull();
    expect(store.getState().isInitialized).toBe(true);
    expect(store.getState().worktrees.size).toBe(1);
  });
});
