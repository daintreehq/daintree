// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";
import type { DeletedWorktree } from "@/store/worktreeStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
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
  it("keeps the drag order and sortable ids when a snapshot carries the same order", () => {
    const { result, rerender } = renderModel();
    const { dragStartOrder, sortableIds } = result.current;
    expect(dragStartOrder).toEqual(["a", "b"]);

    rerender({
      worktrees: snapshot(),
      activeWorktreeId: null,
      deletedWorktrees: new Map(),
      canPruneWorktreeIds: true,
    });

    expect(result.current.dragStartOrder).toBe(dragStartOrder);
    expect(result.current.sortableIds).toBe(sortableIds);
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
});
