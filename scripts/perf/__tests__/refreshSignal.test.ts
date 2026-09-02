import { describe, expect, it } from "vitest";
import { loadWorktreeStoreModule, makeBenchSnapshot } from "../lib/worktreeSidebarFixture";

/**
 * The File Browser's refresh signal, pinned at the store.
 *
 * #11334: a write into a gitignored folder leaves `worktreeChanges` content
 * identical, so its stamp never advances, so a browser watching only the git
 * tick never refreshes. The fix was to combine two signals, and the store keeps
 * them as two side maps whose OBJECT IDENTITY is preserved when nothing moved —
 * that identity is what a subscriber sees as a tick.
 *
 * PERF-142 measures the cost of maintaining them. This asserts the behaviour,
 * so the scenario's oracle is pinned by something other than itself: all four
 * of its terms would read 0 against a store that had stopped distinguishing the
 * two, if nothing here said what the distinction is.
 */
describe("File Browser refresh signal (#11334)", () => {
  async function seededStore(count = 8) {
    const { createWorktreeStore } = await loadWorktreeStoreModule();
    const store = createWorktreeStore();
    let seq = 1;
    store.getState().applySnapshot(
      Array.from({ length: count }, (_, i) => makeBenchSnapshot(i)),
      { epoch: "test", seq }
    );
    return {
      apply(options: Parameters<typeof makeBenchSnapshot>[1]) {
        const before = store.getState();
        const beforeFs = before.workingTreeChangedAtById;
        const beforeGit = before.statusCheckedAt;
        seq += 1;
        const snapshot = makeBenchSnapshot(0, options);
        store.getState().applyUpdate(snapshot, { epoch: "test", seq });
        const after = store.getState();
        return {
          fsMoved: after.workingTreeChangedAtById !== beforeFs,
          gitMoved: after.statusCheckedAt !== beforeGit,
          // Identity says a subscriber saw a tick. These say the map that
          // ticked holds what was fed in: a rebuild with the wrong stamps
          // changes identity and would pass every assertion otherwise.
          fsStamp: after.workingTreeChangedAtById.get(snapshot.id),
          gitStamp: after.statusCheckedAt.get(snapshot.id),
        };
      },
    };
  }

  it("moves the working-tree map alone for an ignored-only write", async () => {
    // The issue in one assertion. Before the fix a browser watching only the
    // git tick saw nothing here and never re-read the tree.
    const store = await seededStore();
    const moved = store.apply({ workingTreeChangedAt: 2_000_000 });
    expect(moved.fsMoved).toBe(true);
    expect(moved.gitMoved).toBe(false);
    // And the map that moved holds the stamp that moved it.
    expect(moved.fsStamp).toBe(2_000_000);
  });

  it("moves the status map alone for a poll that found nothing", async () => {
    // The mirror image, and the reason the two maps exist separately rather
    // than as one combined stamp.
    const store = await seededStore();
    store.apply({ workingTreeChangedAt: 2_000_000 });
    const moved = store.apply({ workingTreeChangedAt: 2_000_000, checkedAt: 2_000_000 });
    expect(moved.gitMoved).toBe(true);
    expect(moved.fsMoved).toBe(false);
  });

  it("moves both for an ordinary edit", async () => {
    const store = await seededStore();
    const moved = store.apply({
      workingTreeChangedAt: 3_000_000,
      checkedAt: 3_000_000,
      changedFileCount: 1,
      lastUpdated: 3_000_000,
    });
    expect(moved.fsMoved).toBe(true);
    expect(moved.gitMoved).toBe(true);
  });

  it("moves neither when the same snapshot is applied again", async () => {
    // A spurious tick makes the browser re-read the whole tree for nothing,
    // which is what the identity-preserving rebuild exists to avoid. This is
    // the "does too much" direction: a store that rebuilt unconditionally
    // would pass every assertion above and fail this one.
    const store = await seededStore();
    const options = {
      workingTreeChangedAt: 3_000_000,
      checkedAt: 3_000_000,
      changedFileCount: 1,
      lastUpdated: 3_000_000,
    };
    store.apply(options);
    const repeated = store.apply(options);
    expect(repeated.fsMoved).toBe(false);
    expect(repeated.gitMoved).toBe(false);
  });
});
