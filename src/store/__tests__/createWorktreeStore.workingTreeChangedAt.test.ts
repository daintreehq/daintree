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

// The affected-directory side map (#12244) rides the same stamp: it lets the
// file browser re-list only what a burst touched. Its `previousAt` chain is the
// only thing standing between "scoped refresh" and "silently dropped a burst",
// so these assert the chain, not just the payload.
describe("createWorktreeStore — workingTreeChangedDirs side map", () => {
  it("records the burst's directories alongside the stamp they belong to", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")).toMatchObject({
      at: 1_000,
      previousAt: null,
      dirs: ["src"],
    });
  });

  it("chains previousAt across consecutive updates so a consumer can prove continuity", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 2_000, workingTreeChangedDirs: ["electron"] }),
        nextV()
      );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")).toMatchObject({
      at: 2_000,
      previousAt: 1_000,
      dirs: ["electron"],
    });
  });

  it("never carries a previous burst's directories forward onto a new stamp", () => {
    // The absent field means "this host described no burst for this stamp",
    // which is not the same as "the same directories again" — inheriting would
    // scope a refresh to directories that had nothing to do with the change.
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 2_000 }), nextV());

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")).toMatchObject({
      at: 2_000,
      previousAt: 1_000,
      dirs: null,
    });
  });

  it("keeps a known-empty burst distinct from an undescribed one", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: [] }),
        nextV()
      );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")?.dirs).toEqual([]);
  });

  it("holds the map identity when a snapshot repeats the stamp it already recorded", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    const before = store.getState().workingTreeChangedDirsById;

    // A git-status pass re-emits the same stamp; nothing new happened.
    store.getState().applyUpdate(
      makeSnapshot("wt-1", {
        workingTreeChangedAt: 1_000,
        workingTreeChangedDirs: ["src"],
        modifiedCount: 3,
      }),
      nextV()
    );

    expect(store.getState().workingTreeChangedDirsById).toBe(before);
  });

  it("refuses to claim continuity on the authoritative snapshot path", () => {
    // A full snapshot is the host's whole state and can jump across flushes the
    // store never saw one by one, so the record it writes must say so — the
    // consumer then takes one full re-read rather than scoping to a set that
    // may be missing a burst.
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    store.getState().applySnapshot(
      [
        makeSnapshot("wt-1", {
          workingTreeChangedAt: 3_000,
          workingTreeChangedDirs: ["electron"],
        }),
      ],
      nextV()
    );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")).toMatchObject({
      at: 3_000,
      previousAt: null,
      dirs: ["electron"],
    });
  });

  it("carries an unchanged record through the authoritative snapshot path untouched", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    const record = store.getState().workingTreeChangedDirsById.get("wt-1");

    store
      .getState()
      .applySnapshot(
        [makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] })],
        nextV()
      );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")).toBe(record);
  });

  it("breaks the chain when the worktree is re-created at the same path", () => {
    // Same epoch, new incarnation: the stamp keeps climbing (it is clock-based)
    // so nothing about the number says the old tree died, but its record
    // describes a different timeline.
    const store = createWorktreeStore();
    store.getState().applyUpdate(
      makeSnapshot("wt-1", {
        generation: 1,
        workingTreeChangedAt: 1_000,
        workingTreeChangedDirs: ["src"],
      }),
      nextV()
    );
    store.getState().applyUpdate(
      makeSnapshot("wt-1", {
        generation: 2,
        workingTreeChangedAt: 2_000,
        workingTreeChangedDirs: ["electron"],
      }),
      nextV()
    );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")?.previousAt).toBeNull();
  });

  it("does not chain a later new-epoch event back onto the dead run", () => {
    // Only the FIRST event of a new epoch sees the transition, so a guard that
    // tests the incoming event rather than the record lets the second one
    // reconnect. Here the first new-epoch update carries no fs stamp at all.
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        { epoch: "epoch-a", seq: 1 }
      );
    store.getState().applyUpdate(makeSnapshot("wt-1"), { epoch: "epoch-b", seq: 1 });
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 2_000, workingTreeChangedDirs: ["b"] }),
        { epoch: "epoch-b", seq: 2 }
      );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")?.previousAt).toBeNull();
  });

  it("prunes the record when its worktree is removed", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    store.getState().applyRemove("wt-1", nextV());

    expect(store.getState().workingTreeChangedDirsById.has("wt-1")).toBe(false);
  });
});
