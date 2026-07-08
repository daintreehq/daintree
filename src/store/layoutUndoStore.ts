import { create } from "zustand";
import { usePanelStore } from "./panelStore";
import type { TabGroup } from "@shared/types";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { buildWorktreeIndex } from "@/store/slices/panelRegistry/worktreeIndex";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

const MAX_UNDO_HISTORY = 10;

interface TerminalLayoutEntry {
  id: string;
  location: "grid" | "dock" | "overlay" | "trash" | "background";
  worktreeId?: string;
}

export interface LayoutSnapshot {
  terminals: TerminalLayoutEntry[];
  tabGroups: Map<string, TabGroup>;
  focusedId: string | null;
  maximizedId: string | null;
  activeDockTerminalId: string | null;
}

interface LayoutUndoState {
  undoStack: LayoutSnapshot[];
  redoStack: LayoutSnapshot[];
  canUndo: boolean;
  canRedo: boolean;
  pushLayoutSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  clearHistory: () => void;
}

function captureCurrentLayout(): LayoutSnapshot {
  const state = usePanelStore.getState();
  return {
    terminals: state.panelIds
      .map((id) => state.panelsById[id])
      .filter((t): t is CarrierPanel => Boolean(t) && t!.location !== "trash")
      .map((t) => ({
        id: t.id,
        location: t.location,
        worktreeId: t.worktreeId,
      })),
    tabGroups: structuredClone(state.tabGroups),
    focusedId: state.focusedId,
    maximizedId: state.maximizedId,
    activeDockTerminalId: state.activeDockTerminalId,
  };
}

// Scrollable panel grid (#8805) removed the screen-fit cap that previously
// forced overflow panels onto the dock during undo/redo. Snapshots now restore
// every grid panel as-is; the grid scrolls if it exceeds the visible fit.

function applySnapshot(snapshot: LayoutSnapshot): boolean {
  const state = usePanelStore.getState();
  const { panelsById, panelIds } = state;

  const snapshotIds = new Set(snapshot.terminals.map((t) => t.id));

  // Check all snapshot terminals still exist
  for (const id of snapshotIds) {
    if (!panelsById[id]) {
      return false;
    }
  }

  // Build combined entry list: snapshot entries first, then post-snapshot terminals.
  // Post-snapshot terminals go at the end so they're overflowed first by capacity clamping.
  const postSnapshotEntries: TerminalLayoutEntry[] = [];
  for (const tid of panelIds) {
    const t = panelsById[tid];
    if (t && !snapshotIds.has(t.id) && t.location !== "trash") {
      postSnapshotEntries.push({ id: t.id, location: t.location, worktreeId: t.worktreeId });
    }
  }
  const allEntries = [...snapshot.terminals, ...postSnapshotEntries];

  // Rebuild the normalized store preserving non-layout fields. No grid-capacity
  // clamp is applied (#8805) — the scrollable grid absorbs every entry.
  const newTerminalsById: Record<string, CarrierPanel> = {};
  const newTerminalIds: string[] = [];
  for (const entry of allEntries) {
    const current = panelsById[entry.id];
    if (!current) continue;
    const restored: CarrierPanel = { ...current, location: entry.location };
    if (entry.worktreeId !== undefined) {
      restored.worktreeId = entry.worktreeId;
    } else {
      delete restored.worktreeId;
    }
    newTerminalsById[entry.id] = restored;
    newTerminalIds.push(entry.id);
  }

  usePanelStore.setState({
    panelsById: newTerminalsById,
    panelIds: newTerminalIds,
    // Bulk restore can change panels' worktreeId, so rebuild the per-worktree
    // index — sidebar summaries and worktree cycling read it and would
    // otherwise see stale buckets after an undo of a cross-worktree move.
    panelIdsByWorktreeId: buildWorktreeIndex(newTerminalIds, newTerminalsById),
    tabGroups: structuredClone(snapshot.tabGroups),
    focusedId: snapshot.focusedId,
    maximizedId: snapshot.maximizedId,
    activeDockTerminalId: snapshot.activeDockTerminalId,
  });

  return true;
}

export const useLayoutUndoStore = create<LayoutUndoState>()((set, get) => ({
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,

  pushLayoutSnapshot: () => {
    const snapshot = captureCurrentLayout();
    set((state) => {
      const newStack = [...state.undoStack, snapshot];
      if (newStack.length > MAX_UNDO_HISTORY) {
        newStack.shift();
      }
      return {
        undoStack: newStack,
        redoStack: [],
        canUndo: true,
        canRedo: false,
      };
    });
  },

  undo: () => {
    const { undoStack } = get();
    if (undoStack.length === 0) return;

    const snapshot = undoStack[undoStack.length - 1];
    if (!snapshot) return;
    const currentLayout = captureCurrentLayout();

    if (!applySnapshot(snapshot)) return;

    set((state) => {
      const newUndoStack = state.undoStack.slice(0, -1);
      return {
        undoStack: newUndoStack,
        redoStack: [...state.redoStack, currentLayout],
        canUndo: newUndoStack.length > 0,
        canRedo: true,
      };
    });
  },

  redo: () => {
    const { redoStack } = get();
    if (redoStack.length === 0) return;

    const snapshot = redoStack[redoStack.length - 1];
    if (!snapshot) return;
    const currentLayout = captureCurrentLayout();

    if (!applySnapshot(snapshot)) return;

    set((state) => {
      const newRedoStack = state.redoStack.slice(0, -1);
      return {
        undoStack: [...state.undoStack, currentLayout],
        redoStack: newRedoStack,
        canUndo: true,
        canRedo: newRedoStack.length > 0,
      };
    });
  },

  clearHistory: () => {
    set({
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });
  },
}));
