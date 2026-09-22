import { describe, expect, it } from "vitest";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import { createWorktreeStore } from "@/store/createWorktreeStore";

// `snapshotsEqual` compares fields by hand. An update whose only change is the
// approval flag is exactly the one the host sends after the user approves, so
// dropping it would leave the card asking for an approval already given.

const TEST_EPOCH = "test-epoch";
let seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++seq };
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

describe("createWorktreeStore — command approval flag", () => {
  it("surfaces an update whose only change is lifecycleCommandsNeedApproval", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { lifecycleCommandsNeedApproval: true }), nextV());
    const mapBefore = store.getState().worktrees;

    store.getState().applyUpdate(makeSnapshot("wt-1"), nextV());

    expect(store.getState().worktrees).not.toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")?.lifecycleCommandsNeedApproval).toBeUndefined();
  });

  it("does not churn the map identity when the flag is unchanged", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { lifecycleCommandsNeedApproval: true }), nextV());
    const mapBefore = store.getState().worktrees;

    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { lifecycleCommandsNeedApproval: true }), nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
  });
});
