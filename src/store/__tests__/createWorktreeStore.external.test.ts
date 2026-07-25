import { describe, expect, it } from "vitest";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import { createWorktreeStore } from "@/store/createWorktreeStore";

// `snapshotsEqual` compares snapshot fields by hand, so a field it doesn't
// compare is a field whose changes never reach the renderer (#11434). These
// tests pin `isExternal` into that comparison.

const TEST_EPOCH = "test-epoch";
let _seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++_seq };
}

function makeSnapshot(id: string, extra: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    name: id,
    branch: "main",
    path: `/repo/${id}`,
    isCurrent: false,
    isMainWorktree: false,
    modifiedCount: 0,
    summary: "",
    gitDir: "",
    ...extra,
  };
}

describe("createWorktreeStore — external classification updates", () => {
  it("surfaces an update whose only change is isExternal", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: false }), nextV());
    const mapBefore = store.getState().worktrees;

    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: true }), nextV());

    expect(store.getState().worktrees).not.toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")?.isExternal).toBe(true);
  });

  it("distinguishes unknown classification from a confirmed internal one", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: undefined }), nextV());
    const mapBefore = store.getState().worktrees;

    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: false }), nextV());

    expect(store.getState().worktrees).not.toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")?.isExternal).toBe(false);
  });

  it("does not churn the map identity when classification is unchanged", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: true }), nextV());
    const mapBefore = store.getState().worktrees;

    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: true }), nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
  });
});
