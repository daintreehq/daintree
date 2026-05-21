import { describe, expect, it } from "vitest";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";

// Host-minted versions are now `(epoch, seq)` tuples (#8403). Tests mint a
// monotonic seq under a fixed epoch; each fresh store starts at epoch "" so
// the first non-empty epoch is always accepted as an epoch transition.
const TEST_EPOCH = "test-epoch";
let _seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++_seq };
}

function makeSnapshot(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
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
    ...overrides,
  } as unknown as WorktreeSnapshot;
}

describe("createWorktreeStore — manual issue associations (#8079)", () => {
  it("starts with an empty manualAssociations map", () => {
    const store = createWorktreeStore();
    expect(store.getState().manualAssociations.size).toBe(0);
  });

  it("applySnapshot merges associations over auto-detected issue (MANUAL_OVER_AUTO)", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [makeSnapshot("wt-1", { issueNumber: 11, issueTitle: "Auto detected" })],
        nextV(),
        { "wt-1": { issueNumber: 42, issueTitle: "Manual issue" } }
      );

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(42);
    expect(wt?.issueTitle).toBe("Manual issue");
    expect(store.getState().manualAssociations.get("wt-1")?.issueNumber).toBe(42);
  });

  it("applyUpdate preserves a manual association the snapshot omits", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    // A worktree-update with no issue fields must NOT clobber the manual assoc.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "feature/x" }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(42);
    expect(wt?.issueTitle).toBe("Manual issue");
    expect(wt?.branch).toBe("feature/x");
  });

  it("setManualAssociation re-merges the existing snapshot immediately", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().setManualAssociation("wt-1", { issueNumber: 99, issueTitle: "Attached" });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(99);
    expect(wt?.issueTitle).toBe("Attached");
  });

  it("clearManualAssociation stops resurrecting the issue on the next update", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    store.getState().clearManualAssociation("wt-1");
    store.getState().applyUpdate(makeSnapshot("wt-1", { issueNumber: undefined }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBeUndefined();
    expect(store.getState().manualAssociations.has("wt-1")).toBe(false);
  });

  it("preserves the previous title when the issue number is unchanged", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [makeSnapshot("wt-1", { issueNumber: 7, issueTitle: "Loaded title" })],
        nextV()
      );

    // Poll re-fetch drops the title but keeps the same issue number.
    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { issueNumber: 7, issueTitle: undefined }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.issueTitle).toBe("Loaded title");
  });

  it("clears the title when the issue number changes", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { issueNumber: 7, issueTitle: "Old title" })], nextV());

    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { issueNumber: 8, issueTitle: undefined }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(8);
    expect(wt?.issueTitle).toBeUndefined();
  });

  it("applySnapshot without associations preserves the cached map", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    // A later refresh whose association IPC failed passes `undefined`.
    store.getState().applySnapshot([makeSnapshot("wt-1", { branch: "feature/x" })], nextV());

    expect(store.getState().manualAssociations.get("wt-1")?.issueNumber).toBe(42);
    expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(42);
    expect(store.getState().worktrees.get("wt-1")?.branch).toBe("feature/x");
  });

  it("a stale-version applySnapshot does not revert a newer applyUpdate", () => {
    const store = createWorktreeStore();
    // Version minted while the snapshot data was "fresh".
    const snapshotVersion = nextV();
    // A worktree-update races ahead during the association fetch.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "feature/new" }), nextV());

    // The now-stale snapshot tries to apply with the older version.
    store.getState().applySnapshot([makeSnapshot("wt-1", { branch: "old" })], snapshotVersion);

    expect(store.getState().worktrees.get("wt-1")?.branch).toBe("feature/new");
  });

  it("manual association overrides an issue-detected-style update (MANUAL_OVER_AUTO)", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
    store.getState().setManualAssociation("wt-1", { issueNumber: 42, issueTitle: "Manual" });

    // issue-detected builds a snapshot with a different (auto) issue.
    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { issueNumber: 99, issueTitle: "Auto detected" }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(42);
    expect(wt?.issueTitle).toBe("Manual");
  });

  it("setFatalError drops cached manual associations", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    store.getState().setFatalError("host crashed");

    expect(store.getState().manualAssociations.size).toBe(0);
    expect(store.getState().isInitialized).toBe(false);
  });
});
