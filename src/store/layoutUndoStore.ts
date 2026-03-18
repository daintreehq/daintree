import { create } from "zustand";
import { useTerminalStore } from "./terminalStore";
import type { TabGroup } from "@shared/types";

const MAX_UNDO_HISTORY = 10;

interface TerminalLayoutEntry {
  id: string;
  location: "grid" | "dock" | "trash" | "background";
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
  const state = useTerminalStore.getState();
  return {
    terminals: state.terminals
      .filter((t) => t.location !== "trash")
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

function applySnapshot(snapshot: LayoutSnapshot): void {
  const state = useTerminalStore.getState();
  const currentTerminals = state.terminals;

  const currentById = new Map(currentTerminals.map((t) => [t.id, t]));
  const snapshotIds = new Set(snapshot.terminals.map((t) => t.id));

  // Check all snapshot terminals still exist
  for (const id of snapshotIds) {
    if (!currentById.has(id)) {
      return;
    }
  }

  // Rebuild the terminals array preserving non-layout fields
  const restoredTerminals = snapshot.terminals
    .map((entry) => {
      const current = currentById.get(entry.id);
      if (!current) return null;
      return {
        ...current,
        location: entry.location,
        worktreeId: entry.worktreeId,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  // Append any terminals not in the snapshot (added after snapshot was taken)
  for (const t of currentTerminals) {
    if (!snapshotIds.has(t.id)) {
      restoredTerminals.push(t);
    }
  }

  useTerminalStore.setState({
    terminals: restoredTerminals,
    tabGroups: structuredClone(snapshot.tabGroups),
    focusedId: snapshot.focusedId,
    maximizedId: snapshot.maximizedId,
    activeDockTerminalId: snapshot.activeDockTerminalId,
  });
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
    const currentLayout = captureCurrentLayout();

    set((state) => {
      const newUndoStack = state.undoStack.slice(0, -1);
      return {
        undoStack: newUndoStack,
        redoStack: [...state.redoStack, currentLayout],
        canUndo: newUndoStack.length > 0,
        canRedo: true,
      };
    });

    applySnapshot(snapshot);
  },

  redo: () => {
    const { redoStack } = get();
    if (redoStack.length === 0) return;

    const snapshot = redoStack[redoStack.length - 1];
    const currentLayout = captureCurrentLayout();

    set((state) => {
      const newRedoStack = state.redoStack.slice(0, -1);
      return {
        undoStack: [...state.undoStack, currentLayout],
        redoStack: newRedoStack,
        canUndo: true,
        canRedo: newRedoStack.length > 0,
      };
    });

    applySnapshot(snapshot);
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
