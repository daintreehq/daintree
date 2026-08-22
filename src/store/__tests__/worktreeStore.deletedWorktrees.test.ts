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
  getPinnedDeletedWorktreeAnchorId,
  recordSidebarWorktreeOrder,
  createDeletedWorktreeRecord,
  type DeletedWorktree,
} from "@/store/worktreeStore";

function makeDeleted(overrides: Partial<DeletedWorktree> = {}): DeletedWorktree {
  return {
    id: "wt-1",
    title: "feature/x",
    path: "/repo/wt-1",
    deletedAt: 1000,
    expiresAt: null,
    holdReason: null,
    pinnedBeforeWorktreeId: null,
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

describe("placement anchor", () => {
  it("reports the successor a worktree sat before in the last recorded sidebar order", () => {
    recordSidebarWorktreeOrder(["a", "b", "c"]);
    expect(getPinnedDeletedWorktreeAnchorId("b")).toBe("c");
  });

  it("reports null for the last worktree in the order (no successor)", () => {
    recordSidebarWorktreeOrder(["a", "b", "c"]);
    expect(getPinnedDeletedWorktreeAnchorId("c")).toBeNull();
  });

  it("reports null for a worktree that was not visible", () => {
    recordSidebarWorktreeOrder(["a", "b"]);
    expect(getPinnedDeletedWorktreeAnchorId("hidden")).toBeNull();
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
    store.addDeletedWorktree(makeDeleted({ deletedAt: 1000, pinnedBeforeWorktreeId: "first" }));
    store.addDeletedWorktree(makeDeleted({ deletedAt: 9999, pinnedBeforeWorktreeId: "second" }));

    const stored = useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1");
    expect(stored?.deletedAt).toBe(1000);
    expect(stored?.pinnedBeforeWorktreeId).toBe("first");
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

describe("setDeletedWorktreeCleanupState", () => {
  it("moves the deadline and the hold reason in a single update", () => {
    const store = useWorktreeSelectionStore.getState();
    store.addDeletedWorktree(makeDeleted());

    const seen: Array<{ expiresAt: number | null; holdReason: string | null }> = [];
    const unsubscribe = useWorktreeSelectionStore.subscribe((state) => {
      const row = state.deletedWorktrees.get("wt-1");
      if (row) seen.push({ expiresAt: row.expiresAt, holdReason: row.holdReason });
    });
    store.setDeletedWorktreeCleanupState("wt-1", { expiresAt: 5_000, holdReason: "drag" });
    unsubscribe();

    // One emission carrying both fields — two sequential writes would publish a
    // torn frame (new deadline, stale reason) to every sidebar subscriber.
    expect(seen).toEqual([{ expiresAt: 5_000, holdReason: "drag" }]);
  });

  it("returns the same state when neither field changes", () => {
    const store = useWorktreeSelectionStore.getState();
    store.addDeletedWorktree(makeDeleted({ expiresAt: 5_000, holdReason: "agent" }));
    const before = useWorktreeSelectionStore.getState().deletedWorktrees;
    store.setDeletedWorktreeCleanupState("wt-1", { expiresAt: 5_000, holdReason: "agent" });

    // The sweep calls this every second; an unconditional clone would re-render
    // the whole sidebar at 1 Hz.
    expect(useWorktreeSelectionStore.getState().deletedWorktrees).toBe(before);
  });

  it("writes when only the hold reason changes", () => {
    const store = useWorktreeSelectionStore.getState();
    store.addDeletedWorktree(makeDeleted({ expiresAt: 5_000, holdReason: "drag" }));
    store.setDeletedWorktreeCleanupState("wt-1", { expiresAt: 5_000, holdReason: null });

    expect(
      useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1")?.holdReason
    ).toBeNull();
  });

  it("leaves state untouched for an unknown id", () => {
    const store = useWorktreeSelectionStore.getState();
    store.addDeletedWorktree(makeDeleted());
    const before = useWorktreeSelectionStore.getState().deletedWorktrees;
    store.setDeletedWorktreeCleanupState("nope", { expiresAt: 1, holdReason: null });
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

describe("deleted-worktree group expansion (#11260)", () => {
  function addRows(count: number): void {
    setPanels(Array.from({ length: count }, (_, i) => ({ id: `t${i}`, worktreeId: `wt-${i}` })));
    for (let i = 0; i < count; i++) {
      useWorktreeSelectionStore
        .getState()
        .addDeletedWorktree(makeDeleted({ id: `wt-${i}`, title: `feature/${i}` }));
    }
  }

  it("starts collapsed so a burst never opens to a wall of cards", () => {
    addRows(3);

    expect(useWorktreeSelectionStore.getState().deletedWorktreeGroupExpanded).toBe(false);
  });

  it("toggles expansion", () => {
    addRows(3);
    useWorktreeSelectionStore.getState().toggleDeletedWorktreeGroupExpanded();

    expect(useWorktreeSelectionStore.getState().deletedWorktreeGroupExpanded).toBe(true);
  });

  it("latches shut once dismissals drop the cohort below the threshold", () => {
    addRows(3);
    useWorktreeSelectionStore.getState().toggleDeletedWorktreeGroupExpanded();

    useWorktreeSelectionStore.getState().dismissDeletedWorktree("wt-0");
    // Two rows still form a group, so the expansion the user chose survives.
    expect(useWorktreeSelectionStore.getState().deletedWorktreeGroupExpanded).toBe(true);

    useWorktreeSelectionStore.getState().dismissDeletedWorktree("wt-1");
    expect(useWorktreeSelectionStore.getState().deletedWorktreeGroupExpanded).toBe(false);
  });

  it("latches shut when pruning empties the cohort", () => {
    addRows(3);
    useWorktreeSelectionStore.getState().toggleDeletedWorktreeGroupExpanded();
    setPanels([{ id: "t0", worktreeId: "wt-0" }]);
    useWorktreeSelectionStore.getState().pruneDeletedWorktrees(new Set());

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.size).toBe(1);
    expect(useWorktreeSelectionStore.getState().deletedWorktreeGroupExpanded).toBe(false);
  });

  it("does not inherit a stale expansion into the next burst", () => {
    addRows(3);
    useWorktreeSelectionStore.getState().toggleDeletedWorktreeGroupExpanded();
    for (let i = 0; i < 3; i++) {
      useWorktreeSelectionStore.getState().dismissDeletedWorktree(`wt-${i}`);
    }
    addRows(3);

    expect(useWorktreeSelectionStore.getState().deletedWorktreeGroupExpanded).toBe(false);
  });
});

describe("createDeletedWorktreeRecord", () => {
  beforeEach(() => {
    recordSidebarWorktreeOrder([]);
  });

  it("names the row after the branch when one is known", () => {
    const record = createDeletedWorktreeRecord("/repo/wt-1", {
      title: "feature/x",
      path: "/repo/wt-1",
    });
    expect(record.title).toBe("feature/x");
    expect(record.path).toBe("/repo/wt-1");
  });

  it("falls back to the folder name for a detached-HEAD worktree", () => {
    const record = createDeletedWorktreeRecord("/repo/wt-1", { path: "/repo/wt-1" });
    expect(record.title).toBe("wt-1");
  });

  it("derives both path and title from the id when nothing else survives", () => {
    // A worktree id IS its path, so a reconstructed row still has a
    // recognisable name after git has forgotten the worktree entirely.
    const record = createDeletedWorktreeRecord("/repo/feature-x");
    expect(record.path).toBe("/repo/feature-x");
    expect(record.title).toBe("feature-x");
  });

  it("reads the last segment of a Windows-style path", () => {
    const record = createDeletedWorktreeRecord("C:\\repo\\feature-x");
    expect(record.title).toBe("feature-x");
  });

  it("survives a path that is nothing but separators", () => {
    const record = createDeletedWorktreeRecord("///");
    expect(record.title).toBe("Unknown");
  });

  it("records the row unarmed so the cleanup sweep owns the countdown", () => {
    const record = createDeletedWorktreeRecord("/repo/wt-1");
    expect(record.expiresAt).toBeNull();
    expect(record.holdReason).toBeNull();
  });

  it("stamps deletedAt from the clock at construction", () => {
    const before = Date.now();
    const record = createDeletedWorktreeRecord("/repo/wt-1");
    expect(record.deletedAt).toBeGreaterThanOrEqual(before);
    expect(record.deletedAt).toBeLessThanOrEqual(Date.now());
  });

  it("anchors the row to the neighbour it sat above in the sidebar", () => {
    recordSidebarWorktreeOrder(["wt-a", "wt-b", "wt-c"]);
    expect(createDeletedWorktreeRecord("wt-b").pinnedBeforeWorktreeId).toBe("wt-c");
    expect(createDeletedWorktreeRecord("wt-c").pinnedBeforeWorktreeId).toBeNull();
  });
});
