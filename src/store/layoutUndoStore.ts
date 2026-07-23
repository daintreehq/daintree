import { create } from "zustand";
import { usePanelStore } from "./panelStore";
import type { TabGroup, TabGroupLocation } from "@shared/types";
import type { PanelKind, PanelLocation } from "@shared/types/panel";
import {
  normalizeDockLocation,
  normalizeGroupDockLocation,
  panelKindIsDockable,
} from "@shared/config/panelKindRegistry";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { buildWorktreeIndex } from "@/store/slices/panelRegistry/worktreeIndex";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

const MAX_UNDO_HISTORY = 10;

interface TerminalLayoutEntry {
  id: string;
  // Type-linked to the shared union rather than re-listing the members: a
  // hand-copied literal union silently accepts a new `PanelLocation` value
  // instead of forcing a decision here.
  location: PanelLocation;
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
      // Ephemeral panels are excluded: a dialog panel captured here is gone the
      // moment the dialog closes, and `applySnapshot` rejects a whole snapshot
      // whose ids no longer resolve — one file peek would void the undo entry.
      .filter(
        (t): t is CarrierPanel =>
          Boolean(t) &&
          t!.location !== "trash" &&
          t!.location !== "dialog" &&
          t!.excludeFromPersistence !== true
      )
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
  const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;

  const snapshotIds = new Set(snapshot.terminals.map((t) => t.id));

  // Check all snapshot terminals still exist
  for (const id of snapshotIds) {
    if (!panelsById[id]) {
      return false;
    }
  }

  // Restore group metadata, but normalize any dock group whose live membership
  // is no longer fully dockable back to grid (#11375). A tab group is atomic —
  // it can't keep half its members in a dock the others can't render — so this
  // is all-or-nothing. Members read their effective location from the (possibly
  // rescued) group location below so a member and its group never disagree.
  const restoredGroups = structuredClone(snapshot.tabGroups);
  const groupLocationByPanelId = new Map<string, TabGroupLocation>();
  for (const [groupId, group] of restoredGroups) {
    const memberKinds: (PanelKind | undefined)[] = [];
    for (const pid of group.panelIds) {
      const member = panelsById[pid];
      if (member) memberKinds.push(member.kind);
    }
    const effectiveGroupLocation = normalizeGroupDockLocation(memberKinds, group.location);
    if (effectiveGroupLocation !== group.location) {
      restoredGroups.set(groupId, { ...group, location: effectiveGroupLocation });
    }
    for (const pid of group.panelIds) {
      groupLocationByPanelId.set(pid, effectiveGroupLocation);
    }
  }

  // Build combined entry list: snapshot entries first, then post-snapshot terminals.
  // Post-snapshot terminals go at the end so they're overflowed first by capacity clamping.
  const postSnapshotEntries: TerminalLayoutEntry[] = [];
  for (const tid of panelIds) {
    const t = panelsById[tid];
    if (
      t &&
      !snapshotIds.has(t.id) &&
      t.location !== "trash" &&
      t.location !== "dialog" &&
      t.excludeFromPersistence !== true
    ) {
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
    // A grouped panel follows its group's (normalized) location; an ungrouped
    // panel normalizes its own entry location. Either way a non-dockable kind
    // never lands back in the dock (#11375).
    const groupedLocation = groupLocationByPanelId.get(entry.id);
    const restoredLocation = groupedLocation ?? normalizeDockLocation(current.kind, entry.location);
    const restored: CarrierPanel = { ...current, location: restoredLocation };
    // A worktree-less panel rescued dock→grid adopts the active worktree, else
    // it strands in the global-only bucket while a worktree is active (#11290).
    const rescuedToGrid = restoredLocation === "grid" && entry.location === "dock";
    if (entry.worktreeId !== undefined) {
      restored.worktreeId = entry.worktreeId;
    } else if (rescuedToGrid && activeWorktreeId !== null) {
      restored.worktreeId = activeWorktreeId;
    } else {
      delete restored.worktreeId;
    }
    newTerminalsById[entry.id] = restored;
    newTerminalIds.push(entry.id);
  }

  // A snapshot `activeDockTerminalId` that no longer points at a panel currently
  // living (and renderable) in the dock would open the popover onto nothing —
  // clear it (#11375).
  const restoredActiveDock = snapshot.activeDockTerminalId;
  const activeDockPanel = restoredActiveDock ? newTerminalsById[restoredActiveDock] : undefined;
  const activeDockStillValid =
    !!activeDockPanel &&
    activeDockPanel.location === "dock" &&
    panelKindIsDockable(activeDockPanel.kind ?? "terminal");

  usePanelStore.setState({
    panelsById: newTerminalsById,
    panelIds: newTerminalIds,
    // Bulk restore can change panels' worktreeId, so rebuild the per-worktree
    // index — sidebar summaries and worktree cycling read it and would
    // otherwise see stale buckets after an undo of a cross-worktree move.
    panelIdsByWorktreeId: buildWorktreeIndex(newTerminalIds, newTerminalsById),
    tabGroups: restoredGroups,
    focusedId: snapshot.focusedId,
    maximizedId: snapshot.maximizedId,
    activeDockTerminalId: activeDockStillValid ? restoredActiveDock : null,
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
