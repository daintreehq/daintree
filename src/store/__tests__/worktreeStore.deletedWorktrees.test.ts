import { describe, it, expect, beforeEach, vi } from "vitest";

const panelState = {
  panelIdsByWorktreeId: {} as Record<string, string[]>,
  panelsById: {} as Record<string, { id: string; location: string }>,
};

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => panelState },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    applyRendererPolicy: vi.fn(),
    getInstance: vi.fn(),
  },
}));

import {
  useWorktreeSelectionStore,
  getDeletedWorktreeTerminalIds,
  getPinnedDeletedWorktreeIndex,
  recordSidebarWorktreeOrder,
  type DeletedWorktree,
} from "@/store/worktreeStore";

function makeDeleted(overrides: Partial<DeletedWorktree> = {}): DeletedWorktree {
  return {
    id: "wt-1",
    title: "feature/x",
    path: "/repo/wt-1",
    deletedAt: 1000,
    expiresAt: null,
    pinnedIndex: 0,
    ...overrides,
  };
}

function setPanels(entries: Array<{ id: string; worktreeId: string; location?: string }>): void {
  panelState.panelIdsByWorktreeId = {};
  panelState.panelsById = {};
  for (const entry of entries) {
    const location = entry.location ?? "grid";
    panelState.panelsById[entry.id] = { id: entry.id, location };
    const bucket = panelState.panelIdsByWorktreeId[entry.worktreeId];
    if (bucket) bucket.push(entry.id);
    else panelState.panelIdsByWorktreeId[entry.worktreeId] = [entry.id];
  }
}

beforeEach(() => {
  setPanels([]);
  recordSidebarWorktreeOrder([]);
  useWorktreeSelectionStore.getState().reset();
});

describe("getDeletedWorktreeTerminalIds", () => {
  it("returns only panels that dismissing would actually close", () => {
    setPanels([
      { id: "live", worktreeId: "wt-1" },
      { id: "docked", worktreeId: "wt-1", location: "dock" },
      { id: "trashed", worktreeId: "wt-1", location: "trash" },
      { id: "assistant", worktreeId: "wt-1", location: "overlay" },
      { id: "dialog", worktreeId: "wt-1", location: "dialog" },
      { id: "elsewhere", worktreeId: "wt-2" },
    ]);

    // Must mirror bulkTrashByWorktree's filter so the confirm's count matches
    // what confirming closes.
    expect(getDeletedWorktreeTerminalIds("wt-1")).toEqual(["live", "docked"]);
  });

  it("returns empty for a worktree with no panels", () => {
    setPanels([{ id: "a", worktreeId: "other" }]);
    expect(getDeletedWorktreeTerminalIds("wt-1")).toEqual([]);
  });
});

describe("pinned index", () => {
  it("reports the slot a worktree occupied in the last recorded sidebar order", () => {
    recordSidebarWorktreeOrder(["a", "b", "c"]);
    expect(getPinnedDeletedWorktreeIndex("b")).toBe(1);
  });

  it("reports -1 for a worktree that was not visible", () => {
    recordSidebarWorktreeOrder(["a", "b"]);
    expect(getPinnedDeletedWorktreeIndex("hidden")).toBe(-1);
  });
});

describe("addDeletedWorktree", () => {
  it("records the worktree keyed by its former id", () => {
    useWorktreeSelectionStore.getState().addDeletedWorktree(makeDeleted());
    const stored = useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1");
    expect(stored).toMatchObject({ title: "feature/x", path: "/repo/wt-1" });
  });

  it("keeps the first record when the same id is added twice", () => {
    const store = useWorktreeSelectionStore.getState();
    store.addDeletedWorktree(makeDeleted({ deletedAt: 1000, pinnedIndex: 2 }));
    store.addDeletedWorktree(makeDeleted({ deletedAt: 9999, pinnedIndex: 7 }));

    const stored = useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1");
    expect(stored?.deletedAt).toBe(1000);
    expect(stored?.pinnedIndex).toBe(2);
  });
});

describe("dismissDeletedWorktree", () => {
  it("removes the row", () => {
    const store = useWorktreeSelectionStore.getState();
    store.addDeletedWorktree(makeDeleted());
    store.dismissDeletedWorktree("wt-1");
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(false);
  });

  it("leaves state untouched for an unknown id", () => {
    const store = useWorktreeSelectionStore.getState();
    store.addDeletedWorktree(makeDeleted());
    const before = useWorktreeSelectionStore.getState().deletedWorktrees;
    store.dismissDeletedWorktree("nope");
    expect(useWorktreeSelectionStore.getState().deletedWorktrees).toBe(before);
  });
});

describe("pruneDeletedWorktrees", () => {
  it("drops a row once its last terminal is gone", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(makeDeleted());

    useWorktreeSelectionStore.getState().pruneDeletedWorktrees(new Set());
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(true);

    setPanels([]);
    useWorktreeSelectionStore.getState().pruneDeletedWorktrees(new Set());
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(false);
  });

  it("treats a terminal moved to another worktree as gone", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(makeDeleted());

    setPanels([{ id: "t1", worktreeId: "wt-live" }]);
    useWorktreeSelectionStore.getState().pruneDeletedWorktrees(new Set(["wt-live"]));

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(false);
  });

  it("treats trashing the last terminal as gone", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(makeDeleted());

    setPanels([{ id: "t1", worktreeId: "wt-1", location: "trash" }]);
    useWorktreeSelectionStore.getState().pruneDeletedWorktrees(new Set());

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(false);
  });

  it("drops a row whose id a live worktree reclaimed", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(makeDeleted());

    // A workspace-host restart re-hydrates the worktree we had already
    // recorded as deleted; the real row owns the id from here on.
    useWorktreeSelectionStore.getState().pruneDeletedWorktrees(new Set(["wt-1"]));

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(false);
  });

  it("keeps rows that still hold terminals", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
    ]);
    const store = useWorktreeSelectionStore.getState();
    store.addDeletedWorktree(makeDeleted({ id: "wt-1" }));
    store.addDeletedWorktree(makeDeleted({ id: "wt-2" }));

    setPanels([{ id: "t2", worktreeId: "wt-2" }]);
    useWorktreeSelectionStore.getState().pruneDeletedWorktrees(new Set());

    const remaining = useWorktreeSelectionStore.getState().deletedWorktrees;
    expect(remaining.has("wt-1")).toBe(false);
    expect(remaining.has("wt-2")).toBe(true);
  });

  it("returns the same state object when nothing is stale", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(makeDeleted());
    const before = useWorktreeSelectionStore.getState().deletedWorktrees;

    useWorktreeSelectionStore.getState().pruneDeletedWorktrees(new Set());

    expect(useWorktreeSelectionStore.getState().deletedWorktrees).toBe(before);
  });
});

describe("reset", () => {
  it("clears deleted worktrees", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(makeDeleted());
    useWorktreeSelectionStore.getState().reset();
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.size).toBe(0);
  });
});

describe("clearRestoreTarget", () => {
  it("demotes a matching durable restore target without touching the active selection", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", restoreWorktreeId: "wt-1" });
    useWorktreeSelectionStore.getState().clearRestoreTarget("wt-1");

    expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBeNull();
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
  });

  it("no-ops when a different worktree is the restore target", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", restoreWorktreeId: "wt-2" });
    useWorktreeSelectionStore.getState().clearRestoreTarget("wt-1");

    expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBe("wt-2");
  });

  it("scrubs a matching fleet-parked restore snapshot so scope exit can't resurrect it", () => {
    useWorktreeSelectionStore.setState({ _previousRestoreWorktreeId: "wt-1" });
    useWorktreeSelectionStore.getState().clearRestoreTarget("wt-1");

    expect(useWorktreeSelectionStore.getState()._previousRestoreWorktreeId).toBeNull();
  });
});
