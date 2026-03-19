import { create } from "zustand";
import { useTerminalStore } from "./terminalStore";
import { useLayoutConfigStore } from "./layoutConfigStore";
import type { TabGroup, TerminalInstance } from "@shared/types";

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

function clampToGridCapacity(
  entries: TerminalLayoutEntry[],
  tabGroups: Map<string, TabGroup>
): { entries: TerminalLayoutEntry[]; tabGroups: Map<string, TabGroup> } {
  const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();

  // Build set of panel IDs that belong to grid tab groups, keyed by worktreeId
  const gridGroupsByWorktree = new Map<string | null, TabGroup[]>();
  const panelsInGridGroups = new Set<string>();
  for (const group of tabGroups.values()) {
    if (group.location !== "grid") continue;
    const wKey = group.worktreeId ?? null;
    if (!gridGroupsByWorktree.has(wKey)) gridGroupsByWorktree.set(wKey, []);
    gridGroupsByWorktree.get(wKey)!.push(group);
    for (const pid of group.panelIds) panelsInGridGroups.add(pid);
  }

  // Build ordered slot list per worktree: each slot is either a group or an ungrouped terminal
  // Slots are ordered by first appearance in the entries array
  type Slot = { type: "group"; group: TabGroup } | { type: "panel"; id: string };
  const slotsByWorktree = new Map<string | null, Slot[]>();
  const seenGroups = new Set<string>();

  for (const entry of entries) {
    if (entry.location !== "grid") continue;
    const wKey = entry.worktreeId ?? null;
    if (!slotsByWorktree.has(wKey)) slotsByWorktree.set(wKey, []);
    const slots = slotsByWorktree.get(wKey)!;

    if (panelsInGridGroups.has(entry.id)) {
      // Find which group this panel belongs to
      const groups = gridGroupsByWorktree.get(wKey) ?? [];
      const group = groups.find((g) => g.panelIds.includes(entry.id));
      if (group && !seenGroups.has(group.id)) {
        seenGroups.add(group.id);
        slots.push({ type: "group", group });
      }
    } else {
      slots.push({ type: "panel", id: entry.id });
    }
  }

  // Determine which panel IDs need to be docked (overflow from end)
  const dockIds = new Set<string>();
  const dockGroupIds = new Set<string>();
  for (const [, slots] of slotsByWorktree) {
    if (slots.length <= maxCapacity) continue;
    const overflow = slots.slice(maxCapacity);
    for (const slot of overflow) {
      if (slot.type === "group") {
        dockGroupIds.add(slot.group.id);
        for (const pid of slot.group.panelIds) dockIds.add(pid);
      } else {
        dockIds.add(slot.id);
      }
    }
  }

  if (dockIds.size === 0) return { entries, tabGroups };

  // Clone entries with overflowed panels moved to dock
  const clampedEntries = entries.map((e) =>
    dockIds.has(e.id) ? { ...e, location: "dock" as const } : e
  );

  // Clone tabGroups with overflowed groups moved to dock
  const clampedGroups = new Map(tabGroups);
  for (const groupId of dockGroupIds) {
    const group = clampedGroups.get(groupId);
    if (group) {
      clampedGroups.set(groupId, { ...group, location: "dock" });
    }
  }

  return { entries: clampedEntries, tabGroups: clampedGroups };
}

function applySnapshot(snapshot: LayoutSnapshot): boolean {
  const state = useTerminalStore.getState();
  const currentTerminals = state.terminals;

  const currentById = new Map(currentTerminals.map((t) => [t.id, t]));
  const snapshotIds = new Set(snapshot.terminals.map((t) => t.id));

  // Check all snapshot terminals still exist
  for (const id of snapshotIds) {
    if (!currentById.has(id)) {
      return false;
    }
  }

  // Clamp grid panels to current capacity, overflowing excess to dock
  const { entries: clampedEntries, tabGroups: clampedTabGroups } = clampToGridCapacity(
    snapshot.terminals,
    snapshot.tabGroups
  );

  // Rebuild the terminals array preserving non-layout fields
  const restoredTerminals: TerminalInstance[] = [];
  for (const entry of clampedEntries) {
    const current = currentById.get(entry.id);
    if (!current) continue;
    const restored: TerminalInstance = { ...current, location: entry.location };
    if (entry.worktreeId !== undefined) {
      restored.worktreeId = entry.worktreeId;
    } else {
      delete restored.worktreeId;
    }
    restoredTerminals.push(restored);
  }

  // Append any terminals not in the snapshot (added after snapshot was taken)
  for (const t of currentTerminals) {
    if (!snapshotIds.has(t.id)) {
      restoredTerminals.push(t);
    }
  }

  useTerminalStore.setState({
    terminals: restoredTerminals,
    tabGroups: structuredClone(clampedTabGroups),
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
