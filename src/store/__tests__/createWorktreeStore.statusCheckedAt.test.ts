import { describe, expect, it } from "vitest";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import { createWorktreeStore } from "@/store/createWorktreeStore";

// Freshness (lastGitStatusCheckedAt) advances on EVERY completed host poll —
// including polls where nothing user-visible changed. It is tracked in the
// statusCheckedAt side map so a quiet poll can't churn the worktrees Map
// identity and fan out to every whole-map subscriber.

const TEST_EPOCH = "test-epoch";
let _seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++_seq };
}

function makeSnapshot(id: string, extra: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
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
    ...extra,
  } as unknown as WorktreeSnapshot;
}

describe("createWorktreeStore — statusCheckedAt freshness side map", () => {
  it("a freshness-only update advances statusCheckedAt without a new worktrees Map identity", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }), nextV());
    const mapBefore = store.getState().worktrees;
    const snapshotBefore = store.getState().worktrees.get("wt-1");

    // Same content, newer freshness stamp — the quiet-poll shape.
    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 2_000 }), nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")).toBe(snapshotBefore);
    expect(store.getState().statusCheckedAt.get("wt-1")).toBe(2_000);
  });

  it("a content change still produces a new Map identity and records freshness", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }), nextV());
    const mapBefore = store.getState().worktrees;

    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { modifiedCount: 3, lastGitStatusCheckedAt: 2_000 }),
        nextV()
      );

    expect(store.getState().worktrees).not.toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")?.modifiedCount).toBe(3);
    expect(store.getState().statusCheckedAt.get("wt-1")).toBe(2_000);
  });

  it("an identical freshness stamp keeps the statusCheckedAt identity stable", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }), nextV());
    const freshnessBefore = store.getState().statusCheckedAt;

    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }), nextV());

    expect(store.getState().statusCheckedAt).toBe(freshnessBefore);
  });

  it("applySnapshot rebuilds freshness for all worktrees and prunes removed ids", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [
          makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }),
          makeSnapshot("wt-2", { lastGitStatusCheckedAt: 1_500 }),
        ],
        nextV()
      );
    expect(store.getState().statusCheckedAt.get("wt-1")).toBe(1_000);
    expect(store.getState().statusCheckedAt.get("wt-2")).toBe(1_500);

    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { lastGitStatusCheckedAt: 2_000 })], nextV());
    expect(store.getState().statusCheckedAt.get("wt-1")).toBe(2_000);
    expect(store.getState().statusCheckedAt.has("wt-2")).toBe(false);
  });

  it("a value-equal snapshot with fresher stamps updates freshness but not the worktrees identity", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 })], nextV());
    const mapBefore = store.getState().worktrees;

    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { lastGitStatusCheckedAt: 2_000 })], nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
    expect(store.getState().statusCheckedAt.get("wt-1")).toBe(2_000);
  });

  it("applyRemove drops the worktree's freshness entry", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }), nextV());
    expect(store.getState().statusCheckedAt.has("wt-1")).toBe(true);

    store.getState().applyRemove("wt-1", nextV());

    expect(store.getState().statusCheckedAt.has("wt-1")).toBe(false);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });
});
