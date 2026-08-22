// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import {
  createWorktreeStore,
  setCurrentViewStore,
  cleanupOrphanedTerminals,
} from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore, createDeletedWorktreeRecord } from "@/store/worktreeStore";

// `cleanupOrphanedTerminals` is destructive — `removePanel` kills the PTY — so
// what it declines to touch is as load-bearing as what it removes. These pin
// the deleted-worktree exemption (#11911): a row's survivors are homed, not
// orphaned, and removing them would empty the row and destroy the very agent
// sessions #11232 exists to keep alive.

const TEST_EPOCH = "test-epoch";
let _seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++_seq };
}

function makeSnapshot(id: string): WorktreeSnapshot {
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
  };
}

function setPanels(entries: Array<{ id: string; worktreeId: string }>): void {
  const panelsById: Record<string, unknown> = {};
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  for (const entry of entries) {
    panelsById[entry.id] = {
      id: entry.id,
      kind: "terminal",
      title: entry.id,
      worktreeId: entry.worktreeId,
      location: "grid",
    };
    const bucket = panelIdsByWorktreeId[entry.worktreeId];
    if (bucket) bucket.push(entry.id);
    else panelIdsByWorktreeId[entry.worktreeId] = [entry.id];
  }
  usePanelStore.setState({
    panelIds: entries.map((e) => e.id),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    panelsById: panelsById as never,
    panelIdsByWorktreeId,
  });
}

function livePanelIds(): string[] {
  return usePanelStore.getState().panelIds;
}

function seedStore(liveWorktreeIds: string[]): void {
  const store = createWorktreeStore();
  store.getState().applySnapshot(liveWorktreeIds.map(makeSnapshot), nextV());
  setCurrentViewStore(store);
}

beforeEach(() => {
  _seq = 0;
  useWorktreeSelectionStore.getState().reset();
  setPanels([]);
  // `removePanel` reaches into terminal teardown the real store owns; the
  // question here is only which ids cleanup selects, so the removal itself is
  // reduced to dropping the id.
  usePanelStore.setState({
    removePanel: ((id: string) => {
      usePanelStore.setState((prev) => ({
        panelIds: prev.panelIds.filter((panelId) => panelId !== id),
      }));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    }) as never,
  });
});

afterEach(() => {
  useWorktreeSelectionStore.getState().reset();
  vi.restoreAllMocks();
});

describe("cleanupOrphanedTerminals — deleted-worktree exemption (#11911)", () => {
  it("removes a panel stranded on a worktree nothing accounts for", () => {
    seedStore(["wt-live"]);
    setPanels([{ id: "stale", worktreeId: "wt-gone" }]);

    cleanupOrphanedTerminals();

    expect(livePanelIds()).toEqual([]);
  });

  it("spares a panel whose dead worktree has a row holding it", () => {
    seedStore(["wt-live"]);
    setPanels([{ id: "survivor", worktreeId: "wt-gone" }]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(createDeletedWorktreeRecord("wt-gone"));

    cleanupOrphanedTerminals();

    // The row is this panel's home. Removing it would kill a live agent and
    // leave the row empty — the outcome #11232 ruled out.
    expect(livePanelIds()).toEqual(["survivor"]);
  });

  it("leaves panels on live worktrees alone", () => {
    seedStore(["wt-live"]);
    setPanels([{ id: "normal", worktreeId: "wt-live" }]);

    cleanupOrphanedTerminals();

    expect(livePanelIds()).toEqual(["normal"]);
  });

  it("exempts only the ghosted id, not every dead worktree", () => {
    // The narrowness is the contract: one row must not switch cleanup off for
    // unrelated stale ids, which would let genuinely abandoned panels pile up.
    seedStore(["wt-live"]);
    setPanels([
      { id: "survivor", worktreeId: "wt-ghosted" },
      { id: "stale", worktreeId: "wt-forgotten" },
      { id: "normal", worktreeId: "wt-live" },
    ]);
    useWorktreeSelectionStore
      .getState()
      .addDeletedWorktree(createDeletedWorktreeRecord("wt-ghosted"));

    cleanupOrphanedTerminals();

    expect(livePanelIds().sort()).toEqual(["normal", "survivor"]);
  });
});
