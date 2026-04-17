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
