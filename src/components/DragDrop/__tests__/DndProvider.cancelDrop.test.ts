// Contract test for cancelDrop predicates added to DndProvider.
// Mirrors the exact branch logic so we can assert rejection conditions
// route to onDragCancel instead of onDragEnd. Following the same harness
// pattern as DndProvider.trashDrop.test.ts.
import { describe, expect, it } from "vitest";

import type { DragData } from "../DndProvider";
import { isNonDockableDockDrop, type OverDropData } from "../dropResolution";

// ── Helpers ──────────────────────────────────────────────

/** Matches DraggableDragData discriminated union in SortableTerminal */
type ActiveDragData = DragData & {
  groupId?: string;
  groupPanelIds?: string[];
};

function hasOver(overData: OverDropData | undefined | null): boolean {
  return overData != null;
}

function hasDraggedId(data: ActiveDragData | undefined, activeId?: string): boolean {
  const draggedId = data?.terminal?.id ?? activeId ?? null;
  return draggedId != null;
}

function isGroupDrag(data: ActiveDragData): boolean {
  return !!(data.groupId && data.groupPanelIds && data.groupPanelIds.length > 1);
}

function isWorktreeDrop(overData: OverDropData | undefined): boolean {
  return overData?.type === "worktree" && !!overData.worktreeId;
}

function isDockToGridFull(
  sourceLocation: string | undefined,
  targetContainer: "grid" | "dock" | null,
  gridIsFull: boolean
): boolean {
  return sourceLocation === "dock" && targetContainer === "grid" && gridIsFull;
}

// ── Predicate replicas (mirrors cancelDrop in DndProvider.tsx) ──

type CancelDropResult = { cancel: true } | { cancel: false };

/**
 * Full cancelDrop logic extracted for contract testing.
 * Mirrors the in-component callback exactly.
 */
function runCancelDrop(params: {
  overData: OverDropData | undefined | null;
  activeData: ActiveDragData | undefined;
  sourceLocation: "grid" | "dock" | undefined;
  targetContainer: "grid" | "dock" | null;
  gridIsFull: boolean;
  isWorktreeSort: boolean;
}): CancelDropResult {
  const { overData, activeData, sourceLocation, targetContainer, gridIsFull, isWorktreeSort } =
    params;

  // Predicate 1: No over target
  if (!hasOver(overData)) {
    return { cancel: true };
  }

  // Worktree-sort handles its own rejection in handleDragEnd
  if (isWorktreeSort) {
    return { cancel: false };
  }

  if (!activeData || !hasDraggedId(activeData)) {
    return { cancel: true };
  }

  // Predicate 2: Multi-panel group on worktree
  if (isGroupDrag(activeData) && isWorktreeDrop(overData!)) {
    return { cancel: true };
  }

  // Predicate 3: Dock drop of a kind the dock can't render (#11054). Calls the
  // real helper so this stays a genuine test of production logic, not a copy.
  if (isNonDockableDockDrop(targetContainer, activeData.terminal.kind)) {
    return { cancel: true };
  }

  // Predicate 4: Dock-to-grid when grid is full
  if (isDockToGridFull(sourceLocation, targetContainer, gridIsFull)) {
    return { cancel: true };
  }

  return { cancel: false };
}

// ── Test data factories ─────────────────────────────────

function makeDragData(overrides: Partial<ActiveDragData> = {}): ActiveDragData {
  return {
    terminal: {
      id: "panel-1",
      title: "Test Panel",
      kind: "terminal",
      location: "grid",
      worktreeId: null,
      agentState: "idle",
      visibility: true,
      cwd: "/tmp",
      columns: 80,
      rows: 24,
      workspaceId: null,
    } as unknown as DragData["terminal"],
    sourceLocation: "grid",
    sourceIndex: 0,
    ...overrides,
  };
}

/** Drag data for a panel of a specific kind (for the #11054 dockability guard). */
function makeDragDataOfKind(kind: string, overrides: Partial<ActiveDragData> = {}): ActiveDragData {
  const base = makeDragData(overrides);
  return { ...base, terminal: { ...base.terminal, kind } as DragData["terminal"] };
}

// ── Tests ────────────────────────────────────────────────

describe("cancelDrop predicates", () => {
  describe("no over target", () => {
    it("cancels when overData is null", () => {
      const result = runCancelDrop({
        overData: null,
        activeData: makeDragData(),
        sourceLocation: "grid",
        targetContainer: null,
        gridIsFull: false,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: true });
    });

    it("cancels when activeData is undefined", () => {
      const result = runCancelDrop({
        overData: { container: "grid" },
        activeData: undefined,
        sourceLocation: "grid",
        targetContainer: "grid",
        gridIsFull: false,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: true });
    });
  });

  describe("valid drops pass through", () => {
    it("does not cancel a normal grid-to-grid drop", () => {
      const result = runCancelDrop({
        overData: { container: "grid", sortable: { index: 1 } },
        activeData: makeDragData(),
        sourceLocation: "grid",
        targetContainer: "grid",
        gridIsFull: false,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: false });
    });

    it("does not cancel a dock-to-dock drop", () => {
      const result = runCancelDrop({
        overData: { container: "dock" },
        activeData: makeDragData({ sourceLocation: "dock" }),
        sourceLocation: "dock",
        targetContainer: "dock",
        gridIsFull: false,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: false });
    });
  });

  describe("non-dockable dock drop (#11054)", () => {
    it("cancels a review panel dropped on the dock (direct container)", () => {
      const result = runCancelDrop({
        overData: { container: "dock" },
        activeData: makeDragDataOfKind("review"),
        sourceLocation: "grid",
        targetContainer: "dock",
        gridIsFull: false,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: true });
    });

    it("cancels a dev-preview panel dropped on a dock chip (sortable container)", () => {
      const result = runCancelDrop({
        overData: { sortable: { containerId: "dock-container", index: 0 } },
        activeData: makeDragDataOfKind("dev-preview"),
        sourceLocation: "grid",
        targetContainer: "dock",
        gridIsFull: false,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: true });
    });

    it("does not cancel a dockable non-PTY (file) panel dropped on the dock", () => {
      const result = runCancelDrop({
        overData: { container: "dock" },
        activeData: makeDragDataOfKind("file"),
        sourceLocation: "grid",
        targetContainer: "dock",
        gridIsFull: false,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: false });
    });

    it("does not cancel a dev-preview panel dropped on the grid (dock guard is target-scoped)", () => {
      const result = runCancelDrop({
        overData: { container: "grid" },
        activeData: makeDragDataOfKind("dev-preview"),
        sourceLocation: "grid",
        targetContainer: "grid",
        gridIsFull: false,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: false });
    });
  });

  describe("multi-panel group on worktree", () => {
    const groupData = makeDragData({
      groupId: "group-1",
      groupPanelIds: ["panel-1", "panel-2"],
    });

    it("cancels a multi-panel group dropped on a worktree", () => {
      const result = runCancelDrop({
        overData: { type: "worktree", worktreeId: "wt-1" },
        activeData: groupData,
        sourceLocation: "grid",
        targetContainer: null,
        gridIsFull: false,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: true });
    });

    it("does not cancel a single panel dropped on a worktree", () => {
      const result = runCancelDrop({
        overData: { type: "worktree", worktreeId: "wt-1" },
        activeData: makeDragData(),
        sourceLocation: "grid",
        targetContainer: null,
        gridIsFull: false,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: false });
    });

    it("isGroupDrag returns false when groupPanelIds has only one entry", () => {
      const singleEntryGroup = makeDragData({
        groupId: "group-1",
        groupPanelIds: ["panel-1"],
      });
      expect(isGroupDrag(singleEntryGroup)).toBe(false);
    });
  });

  describe("grid full from dock", () => {
    it("cancels dock-to-grid when grid is full", () => {
      const result = runCancelDrop({
        overData: { container: "grid" },
        activeData: makeDragData({ sourceLocation: "dock" }),
        sourceLocation: "dock",
        targetContainer: "grid",
        gridIsFull: true,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: true });
    });

    it("does not cancel dock-to-grid when grid has space", () => {
      const result = runCancelDrop({
        overData: { container: "grid" },
        activeData: makeDragData({ sourceLocation: "dock" }),
        sourceLocation: "dock",
        targetContainer: "grid",
        gridIsFull: false,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: false });
    });

    it("does not cancel grid-to-grid when grid is full (same container reorder)", () => {
      const result = runCancelDrop({
        overData: { container: "grid" },
        activeData: makeDragData({ sourceLocation: "grid" }),
        sourceLocation: "grid",
        targetContainer: "grid",
        gridIsFull: true,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: false });
    });
  });

  describe("trash droppable guard", () => {
    it("extracted predicate cancels dock→trash when grid is full — real guard blocks this", () => {
      // Trash droppable has no container type, so detectTargetContainer
      // falls back to the tracked overContainer state. If the user
      // dragged across the grid on the way to trash, overContainer
      // could be "grid" and the grid-full predicate would erroneously
      // fire. The component-level guard `overId !== TRASH_DROPPABLE_ID`
      // prevents this. This test confirms the guard is load-bearing:
      // without it, this scenario would cancel.
      const result = runCancelDrop({
        overData: {},
        activeData: makeDragData({ sourceLocation: "dock" }),
        sourceLocation: "dock",
        targetContainer: "grid",
        gridIsFull: true,
        isWorktreeSort: false,
      });
      expect(result).toEqual({ cancel: true });
    });
  });

  describe("worktree-sort drags", () => {
    it("does not cancel worktree-sort with a valid over target", () => {
      const result = runCancelDrop({
        overData: { type: "worktree", worktreeId: "wt-2" },
        activeData: makeDragData({ sourceLocation: "dock" }),
        sourceLocation: "dock",
        targetContainer: null,
        gridIsFull: false,
        isWorktreeSort: true,
      });
      expect(result).toEqual({ cancel: false });
    });

    it("cancels worktree-sort with no over target (no-over predicate fires first)", () => {
      const result = runCancelDrop({
        overData: null,
        activeData: makeDragData(),
        sourceLocation: "dock",
        targetContainer: null,
        gridIsFull: false,
        isWorktreeSort: true,
      });
      expect(result).toEqual({ cancel: true });
    });
  });
});
