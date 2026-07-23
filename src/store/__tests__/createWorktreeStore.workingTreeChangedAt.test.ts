import { describe, expect, it } from "vitest";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import { createWorktreeStore } from "@/store/createWorktreeStore";

// workingTreeChangedAt is the raw filesystem-write stamp (#11330). Like
// lastGitStatusCheckedAt it advances on events that change nothing else in the
// snapshot, so it lives in the workingTreeChangedAtById side map to keep the
// worktrees Map identity stable on a timestamp-only bump. Unlike freshness, it
// is independent of git status — a write into a gitignored path advances it
// without moving worktreeChanges.

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

describe("createWorktreeStore — workingTreeChangedAt side map", () => {
  it("a timestamp-only update advances the side map without a new worktrees Map identity", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());
    const mapBefore = store.getState().worktrees;
    const snapshotBefore = store.getState().worktrees.get("wt-1");

    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 2_000 }), nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")).toBe(snapshotBefore);
    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(2_000);
  });

  it("advances independently of git status — no lastGitStatusCheckedAt, no content change", () => {
    // This is the issue's core: a write into a gitignored folder moves the fs
    // stamp while git-status content (and freshness) stays put.
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());
    const freshnessBefore = store.getState().statusCheckedAt;
    const mapBefore = store.getState().worktrees;

    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 2_000 }), nextV());

    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(2_000);
    // Neither the worktrees identity nor the freshness map moved.
    expect(store.getState().worktrees).toBe(mapBefore);
    expect(store.getState().statusCheckedAt).toBe(freshnessBefore);
  });

  it("a content change produces a new Map identity and records the fs stamp", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());
    const mapBefore = store.getState().worktrees;

    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { modifiedCount: 3, workingTreeChangedAt: 2_000 }),
        nextV()
      );

    expect(store.getState().worktrees).not.toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")?.modifiedCount).toBe(3);
    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(2_000);
  });

  it("an identical fs stamp keeps the side-map identity stable", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());
    const before = store.getState().workingTreeChangedAtById;

    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());

    expect(store.getState().workingTreeChangedAtById).toBe(before);
  });

  it("applySnapshot rebuilds the side map for all worktrees and prunes removed ids", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [
          makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }),
          makeSnapshot("wt-2", { workingTreeChangedAt: 1_500 }),
        ],
        nextV()
      );
    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(1_000);
    expect(store.getState().workingTreeChangedAtById.get("wt-2")).toBe(1_500);

    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { workingTreeChangedAt: 2_000 })], nextV());
    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(2_000);
    expect(store.getState().workingTreeChangedAtById.has("wt-2")).toBe(false);
  });

  it("a value-equal snapshot with a fresher fs stamp updates the side map, not worktrees identity", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 })], nextV());
    const mapBefore = store.getState().worktrees;

    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { workingTreeChangedAt: 2_000 })], nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(2_000);
  });

  it("applyRemove drops the worktree's fs stamp entry", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());
    expect(store.getState().workingTreeChangedAtById.has("wt-1")).toBe(true);

    store.getState().applyRemove("wt-1", nextV());

    expect(store.getState().workingTreeChangedAtById.has("wt-1")).toBe(false);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });
});
