// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";
import type { DeletedWorktree } from "@/store/worktreeStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePanelStore } from "@/store/panelStore";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { getWorktreeSortDragId } from "@/components/DragDrop/SortableWorktreeCard";
import { useSidebarWorktreeModel } from "../useSidebarWorktreeModel";

// The live worktree-id set comes from the view's worktree store context; the
// model only reads it to spot orphaned panels, so a fixed set stands in.
const liveWorktreeIds = new Set<string>();
vi.mock("@/hooks/useTerminalSelectors", () => ({
  useWorktreeIds: () => liveWorktreeIds,
}));

function makeWorktree(id: string, overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name: id,
    branch: `feature/${id}`,
    isCurrent: false,
    isMainWorktree: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
    ...overrides,
  };
}

function snapshot(): WorktreeState[] {
  return [
    makeWorktree("main", { branch: "main", isMainWorktree: true }),
    makeWorktree("a"),
    makeWorktree("b"),
  ];
}

interface ModelProps {
  worktrees: WorktreeState[];
  activeWorktreeId: string | null;
  deletedWorktrees: Map<string, DeletedWorktree>;
  canPruneWorktreeIds: boolean;
}

function renderModel(props: Partial<ModelProps> = {}) {
  const initialProps: ModelProps = {
    worktrees: snapshot(),
    activeWorktreeId: null,
    deletedWorktrees: new Map(),
    canPruneWorktreeIds: true,
    ...props,
  };
  return renderHook((p: ModelProps) => useSidebarWorktreeModel(p), { initialProps });
}

beforeEach(() => {
  const store = useWorktreeFilterStore.getState();
  store.clearAll();
  store.setManualOrder([]);
  store.setOrderBy("manual");
  store.setGroupByType(false);
  store.setAlwaysShowActive(false);
  store.setAlwaysShowWaiting(false);
  for (const id of store.pinnedWorktrees) store.unpinWorktree(id);
  liveWorktreeIds.clear();
  for (const w of snapshot()) liveWorktreeIds.add(w.id);
});

describe("useSidebarWorktreeModel — stale preference pruning", () => {
  it("leaves pins and manual order alone until the list is one the host delivered", () => {
    const store = useWorktreeFilterStore.getState();
    store.pinWorktree("a");
    store.pinWorktree("gone");
    store.setManualOrder(["gone", "b", "a"]);

    const { rerender } = renderModel({ canPruneWorktreeIds: false });
    expect(useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["a", "gone"]);
    expect(useWorktreeFilterStore.getState().manualOrder).toEqual(["gone", "b", "a"]);

    rerender({
      worktrees: snapshot(),
      activeWorktreeId: null,
      deletedWorktrees: new Map(),
      canPruneWorktreeIds: true,
    });
    expect(useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["a"]);
    expect(useWorktreeFilterStore.getState().manualOrder).toEqual(["b", "a"]);
  });
});

describe("useSidebarWorktreeModel — rows", () => {
  it("keeps the drag order and sortable ids across a snapshot until the order changes", () => {
    const { result, rerender } = renderModel();
    const { dragStartOrder, sortableIds } = result.current;
    expect(dragStartOrder).toEqual(["a", "b"]);
    expect(sortableIds).toEqual(["a", "b"].map(getWorktreeSortDragId));

    rerender({
      worktrees: snapshot(),
      activeWorktreeId: null,
      deletedWorktrees: new Map(),
      canPruneWorktreeIds: true,
    });
    expect(result.current.dragStartOrder).toBe(dragStartOrder);
    expect(result.current.sortableIds).toBe(sortableIds);

    act(() => useWorktreeFilterStore.getState().setManualOrder(["b", "a"]));
    expect(result.current.dragStartOrder).toEqual(["b", "a"]);
    expect(result.current.dragStartOrder).not.toBe(dragStartOrder);
    expect(result.current.sortableIds).toEqual(["b", "a"].map(getWorktreeSortDragId));
    expect(result.current.sortableIds).not.toBe(sortableIds);
  });

  it("places a deleted worktree's row among the live ones and counts it", () => {
    const deleted: DeletedWorktree = {
      id: "gone",
      title: "gone",
      path: "/repo/gone",
      deletedAt: 1,
      expiresAt: null,
      holdReason: null,
      pinnedBeforeWorktreeId: "b",
    };
    const { result } = renderModel({ deletedWorktrees: new Map([["gone", deleted]]) });

    expect(result.current.sidebarItems.map((item) => item.id)).toEqual([
      "row-a",
      "deleted-gone",
      "row-b",
    ]);
    expect(result.current.ariaRowCount).toBe(4);
    expect(result.current.keyboardItems).toEqual([
      { kind: "row", worktreeId: "main", isPinned: true },
      { kind: "row", worktreeId: "a" },
      { kind: "header" },
      { kind: "row", worktreeId: "b" },
    ]);
  });

  it("pins the main worktree ahead of the virtualized rows in keyboard order", () => {
    const { result } = renderModel();

    expect(result.current.mainVisible).toBe(true);
    expect(result.current.mainRowIndex).toBe(1);
    expect(result.current.keyboardItems).toEqual([
      { kind: "row", worktreeId: "main", isPinned: true },
      { kind: "row", worktreeId: "a" },
      { kind: "row", worktreeId: "b" },
    ]);
    expect(result.current.ariaRowCount).toBe(3);
  });

  it("hides the main worktree for a query it fails, but never for the quick state", () => {
    const { result } = renderModel();

    act(() => useWorktreeFilterStore.getState().setQuickStateFilter("working"));
    expect(result.current.mainVisible).toBe(true);
    expect(result.current.filteredWorktrees).toEqual([]);

    act(() => useWorktreeFilterStore.getState().setLiveQuery("zzz"));
    expect(result.current.mainVisible).toBe(false);
    expect(result.current.mainRowIndex).toBe(0);
    expect(result.current.keyboardItems).toEqual([]);
  });

  it("follows the facet filters as the store changes", () => {
    const { result } = renderModel();
    expect(result.current.hasFacetFiltersActive).toBe(false);

    act(() => useWorktreeFilterStore.getState().toggleStatusFilter("dirty"));
    expect(result.current.hasFacetFiltersActive).toBe(true);

    act(() => useWorktreeFilterStore.getState().toggleStatusFilter("dirty"));
    expect(result.current.hasFacetFiltersActive).toBe(false);
  });

  it("reads a whitespace-only query as no query, until a facet filter applies", () => {
    const { result } = renderModel({ activeWorktreeId: "a" });
    act(() => {
      const store = useWorktreeFilterStore.getState();
      store.setAlwaysShowActive(true);
      store.setLiveQuery("   ");
    });
    expect(result.current.filteredWorktrees.map((w) => w.id)).toEqual(["a", "b"]);
    expect(result.current.mainVisible).toBe(true);

    act(() => useWorktreeFilterStore.getState().toggleStatusFilter("dirty"));
    expect(result.current.filteredWorktrees).toEqual([]);
  });
});

describe("useSidebarWorktreeModel — main card aggregate counts", () => {
  function pushFleet(runs: FleetRunRow[]): void {
    act(() =>
      useFleetSnapshotStore.getState().applySnapshot({
        runs,
        changedAt: 1,
        degraded: false,
        lastSuccessfulAt: null,
      })
    );
  }
  const run = (runId: string, overrides: Partial<FleetRunRow> = {}): FleetRunRow => ({
    runId,
    workspaceId: "p1",
    spawnedAt: 0,
    cwd: "/repo",
    ...overrides,
  });

  function seedAgentPanel(id: string, worktreeId: string): void {
    usePanelStore.setState({
      panelIds: [id],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only the fields the sidebar selectors read
      panelsById: {
        [id]: {
          id,
          kind: "terminal",
          title: id,
          worktreeId,
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      } as never,
      panelIdsByWorktreeId: { [worktreeId]: [id] },
    });
  }

  afterEach(() => {
    act(() => {
      useFleetSnapshotStore.setState({ snapshot: null });
      usePanelStore.setState({ panelIds: [], panelsById: {}, panelIdsByWorktreeId: {} });
    });
  });

  it("moves with each count and keeps its identity across pushes that move none", () => {
    // A fresh object here re-renders the main card through its memoized row.
    seedAgentPanel("agent-a", "a");
    pushFleet([run("agent-a", { agentState: "working" }), run("x", { agentState: "working" })]);
    const { result } = renderModel();
    const working = result.current.mainWorktreeAggregateCounts;
    expect(working).toEqual({ worktrees: 2, working: 1, waiting: 0, finished: 0 });

    pushFleet([run("agent-a", { agentState: "working" }), run("x", { agentState: "idle" })]);
    pushFleet([run("agent-a", { agentState: "working", title: "renamed" })]);
    expect(result.current.mainWorktreeAggregateCounts).toBe(working);

    pushFleet([run("agent-a", { agentState: "waiting", waitingReason: "approval" })]);
    const waiting = result.current.mainWorktreeAggregateCounts;
    expect(waiting).toEqual({ worktrees: 2, working: 0, waiting: 1, finished: 0 });

    pushFleet([
      run("agent-a", {
        agentState: "waiting",
        waitingReason: "prompt",
        handBack: { stoppedAt: 1 },
      }),
    ]);
    expect(result.current.mainWorktreeAggregateCounts).toEqual({
      worktrees: 2,
      working: 0,
      waiting: 0,
      finished: 1,
    });
  });

  it("follows the worktree count and drops out with only the main worktree", () => {
    pushFleet([]);
    const { result, rerender } = renderModel();
    expect(result.current.mainWorktreeAggregateCounts).toEqual({
      worktrees: 2,
      working: 0,
      waiting: 0,
      finished: 0,
    });

    const props = {
      activeWorktreeId: null,
      deletedWorktrees: new Map(),
      canPruneWorktreeIds: true,
    };
    rerender({ ...props, worktrees: [...snapshot(), makeWorktree("c")] });
    expect(result.current.mainWorktreeAggregateCounts).toMatchObject({ worktrees: 3 });

    rerender({ ...props, worktrees: snapshot().filter((w) => w.isMainWorktree) });
    expect(result.current.mainWorktreeAggregateCounts).toBeUndefined();
  });
});
