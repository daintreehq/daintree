import { create } from "zustand";
import { usePanelStore } from "./panelStore";
import type { TabGroup, TabGroupLocation } from "@shared/types";
import { isGridPanelLocation, type PanelKind, type PanelLocation } from "@shared/types/panel";
import {
  normalizeDockLocation,
  normalizeGroupDockLocation,
  panelKindHasPty,
  panelKindIsDockable,
} from "@shared/config/panelKindRegistry";
import { exitProjectHome, getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { buildWorktreeIndex } from "@/store/slices/panelRegistry/worktreeIndex";
import {
  removePanelIdsFromTabGroups,
  syncWorktreeAttributionToHost,
} from "@/store/slices/panelRegistry/helpers";
import { reconcileMovedPanel } from "@/services/terminal/crossWorktreeMove";
import type { MaximizeTarget } from "@/store/slices/terminalFocusSlice";

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
  /**
   * Whether `maximizedId` fills the grid alone or with its tab group. Restored
   * with it: an undo that unmaximizes must not leave the old target behind,
   * or the next maximize click on that panel reads as an unmaximize.
   */
  maximizeTarget: MaximizeTarget;
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
  /** Drops entries with no surviving panel left to restore. */
  pruneHistory: () => void;
  clearHistory: () => void;
}

// Ephemeral panels sit outside layout history: a dialog panel is gone the moment
// the dialog closes, so a snapshot of it would restore nothing. Outside history
// means untouched by it, so apply carries them verbatim.
function isExcludedFromLayout(panel: CarrierPanel): boolean {
  return (
    panel.location === "trash" ||
    panel.location === "dialog" ||
    panel.excludeFromPersistence === true
  );
}

/**
 * The panels a snapshot can still restore: live and inside layout history. Read
 * from `panelsById` rather than `panelIds`, the same lookup `applySnapshot`
 * restores through.
 */
export function selectLayoutPanelIds(state: {
  panelsById: Record<string, CarrierPanel | undefined>;
}): Set<string> {
  const ids = new Set<string>();
  for (const id in state.panelsById) {
    const panel = state.panelsById[id];
    if (panel && !isExcludedFromLayout(panel)) ids.add(id);
  }
  return ids;
}

// A snapshot with even one surviving panel is still worth applying: the rest of
// its layout restores around the gaps (#14969). One with none restores nothing.
function isRestorable(snapshot: LayoutSnapshot, layoutPanelIds: ReadonlySet<string>): boolean {
  return snapshot.terminals.some((entry) => layoutPanelIds.has(entry.id));
}

type LayoutHistory = Pick<LayoutUndoState, "undoStack" | "redoStack" | "canUndo" | "canRedo">;

function restorableHistory(
  undoStack: LayoutSnapshot[],
  redoStack: LayoutSnapshot[],
  layoutPanelIds: ReadonlySet<string>
): LayoutHistory {
  const nextUndo = undoStack.filter((s) => isRestorable(s, layoutPanelIds));
  const nextRedo = redoStack.filter((s) => isRestorable(s, layoutPanelIds));
  return {
    undoStack: nextUndo,
    redoStack: nextRedo,
    canUndo: nextUndo.length > 0,
    canRedo: nextRedo.length > 0,
  };
}

function captureCurrentLayout(): LayoutSnapshot {
  const state = usePanelStore.getState();
  return {
    terminals: state.panelIds
      .map((id) => state.panelsById[id])
      .filter((t): t is CarrierPanel => Boolean(t) && !isExcludedFromLayout(t!))
      .map((t) => ({
        id: t.id,
        location: t.location,
        worktreeId: t.worktreeId,
      })),
    tabGroups: structuredClone(state.tabGroups),
    focusedId: state.focusedId,
    maximizedId: state.maximizedId,
    maximizeTarget: state.maximizeTarget,
    activeDockTerminalId: state.activeDockTerminalId,
  };
}

// Scrollable panel grid (#8805) removed the screen-fit cap that previously
// forced overflow panels onto the dock during undo/redo. Snapshots now restore
// every grid panel as-is; the grid scrolls if it exceeds the visible fit.

// Entries for panels that no longer exist are skipped; callers only pass a
// snapshot `isRestorable` accepted, so something always lands.
function applySnapshot(snapshot: LayoutSnapshot): void {
  const state = usePanelStore.getState();
  const { panelsById, panelIds } = state;
  const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;

  const snapshotIds = new Set(snapshot.terminals.map((t) => t.id));

  // A panel trashed, moved into a dialog or closed since the snapshot left its
  // group then; restoring that membership would hand a tab strip a panel it
  // can't render, and a group needs two members to exist at all.
  const goneFromLayout = new Set<string>();
  for (const group of snapshot.tabGroups.values()) {
    for (const pid of group.panelIds) {
      const live = panelsById[pid];
      if (!live || isExcludedFromLayout(live)) goneFromLayout.add(pid);
    }
  }
  const restoredGroups = removePanelIdsFromTabGroups(
    structuredClone(snapshot.tabGroups),
    goneFromLayout
  ).tabGroups;

  // Restore group metadata, but normalize any dock group whose live membership
  // is no longer fully dockable back to grid (#11375). A tab group is atomic —
  // it can't keep half its members in a dock the others can't render — so this
  // is all-or-nothing. Members read their effective location from the (possibly
  // rescued) group location below so a member and its group never disagree.
  const groupOverrideByPanelId = new Map<
    string,
    { location: TabGroupLocation; worktreeId?: string }
  >();
  for (const [groupId, group] of restoredGroups) {
    const memberKinds: (PanelKind | undefined)[] = [];
    for (const pid of group.panelIds) {
      const member = panelsById[pid];
      if (member) memberKinds.push(member.kind);
    }
    const effectiveGroupLocation = normalizeGroupDockLocation(memberKinds, group.location);
    // A worktree-less group rescued dock→grid adopts the active worktree — the
    // group RECORD and every member together — so `getTabGroups` (which filters
    // the group by worktree) and `getPanelGroup` never disagree (split-brain).
    const rescuedToGrid = effectiveGroupLocation === "grid" && group.location === "dock";
    const adoptedWorktreeId =
      rescuedToGrid && group.worktreeId == null && activeWorktreeId !== null
        ? activeWorktreeId
        : null;
    if (effectiveGroupLocation !== group.location || adoptedWorktreeId !== null) {
      restoredGroups.set(groupId, {
        ...group,
        location: effectiveGroupLocation,
        ...(adoptedWorktreeId !== null && { worktreeId: adoptedWorktreeId }),
      });
    }
    for (const pid of group.panelIds) {
      groupOverrideByPanelId.set(pid, {
        location: effectiveGroupLocation,
        ...(adoptedWorktreeId !== null && { worktreeId: adoptedWorktreeId }),
      });
    }
  }

  // Build combined entry list: snapshot entries first, then post-snapshot panels.
  // The rebuild below replaces the whole registry, so every live panel must be
  // listed here — including the ones excluded from history (#13560).
  const postSnapshotEntries: TerminalLayoutEntry[] = [];
  for (const tid of panelIds) {
    const t = panelsById[tid];
    if (t && !snapshotIds.has(t.id)) {
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
    // An excluded panel keeps its live lifecycle — a snapshot entry from before
    // it was trashed must not drag it back out of the trash.
    if (isExcludedFromLayout(current)) {
      newTerminalsById[entry.id] = current;
      newTerminalIds.push(entry.id);
      continue;
    }
    // A grouped panel follows its group's (normalized) location and adopted
    // worktree; an ungrouped panel normalizes its own entry location. Either way
    // a non-dockable kind never lands back in the dock (#11375).
    const groupOverride = groupOverrideByPanelId.get(entry.id);
    const restoredLocation =
      groupOverride?.location ?? normalizeDockLocation(current.kind, entry.location);
    const restored: CarrierPanel = { ...current, location: restoredLocation };
    // A worktree-less ungrouped panel rescued dock→grid adopts the active
    // worktree, else it strands in the global-only bucket while a worktree is
    // active (#11290). Grouped members take the group's adopted worktree.
    const rescuedToGrid = restoredLocation === "grid" && entry.location === "dock";
    if (groupOverride?.worktreeId !== undefined) {
      restored.worktreeId = groupOverride.worktreeId;
    } else if (entry.worktreeId !== undefined) {
      restored.worktreeId = entry.worktreeId;
    } else if (!groupOverride && rescuedToGrid && activeWorktreeId !== null) {
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

  // Focus and maximize must not land on a panel that is gone or has since moved
  // to the trash or a dialog — none of those render in the restored layout.
  const layoutPointer = (id: string | null): string | null => {
    const target = id ? newTerminalsById[id] : undefined;
    return target && target.location !== "trash" && target.location !== "dialog" ? id : null;
  };
  const restoredMaximizedId = layoutPointer(snapshot.maximizedId);
  // A group target whose group no longer holds the maximized panel — dissolved,
  // or pruned of it above — maximizes the panel alone, the way `toggleMaximize`
  // treats a panel with no group.
  const restoredMaximizeTarget: MaximizeTarget =
    restoredMaximizedId === null
      ? null
      : snapshot.maximizeTarget?.type === "group" &&
          !restoredGroups.get(snapshot.maximizeTarget.id)?.panelIds.includes(restoredMaximizedId)
        ? { type: "panel", id: restoredMaximizedId }
        : snapshot.maximizeTarget;

  const worktreeBefore = new Map<string, string | undefined>();
  for (const id of newTerminalIds) worktreeBefore.set(id, panelsById[id]?.worktreeId);

  usePanelStore.setState({
    panelsById: newTerminalsById,
    panelIds: newTerminalIds,
    // Bulk restore can change panels' worktreeId, so rebuild the per-worktree
    // index — sidebar summaries and worktree cycling read it and would
    // otherwise see stale buckets after an undo of a cross-worktree move.
    panelIdsByWorktreeId: buildWorktreeIndex(newTerminalIds, newTerminalsById),
    tabGroups: restoredGroups,
    focusedId: layoutPointer(snapshot.focusedId),
    maximizedId: restoredMaximizedId,
    maximizeTarget: restoredMaximizeTarget,
    // Rejecting the snapshot's maximized panel clears the pre-maximize layout
    // too. Any other restore leaves it alone: it deliberately outlives an
    // unmaximize.
    ...(snapshot.maximizedId !== null &&
      restoredMaximizedId === null && { preMaximizeLayout: null }),
    activeDockTerminalId: activeDockStillValid ? restoredActiveDock : null,
  });

  // An undo that hands focus back to a grid panel is a restore the user asked
  // for, so it has to be on screen rather than behind the project's Home.
  const restoredFocusId = layoutPointer(snapshot.focusedId);
  if (
    restoredFocusId !== null &&
    isGridPanelLocation(newTerminalsById[restoredFocusId]?.location)
  ) {
    exitProjectHome();
  }

  // A bulk restore rewrites `worktreeId` with a raw `setState`, so it bypasses
  // the move choke point entirely. Without this pass an undone cross-worktree
  // move would leave the pane filed back where it started while still carrying
  // the banner — and its queued instruction — for the destination it just left,
  // so "Tell the agent" would send it somewhere the user has undone (#11853).
  for (const [id, before] of worktreeBefore) {
    const restoredPanel = newTerminalsById[id];
    if (!restoredPanel) continue;
    const after = restoredPanel.worktreeId;
    if (before === after) continue;

    // The pty-host record is re-filed for both directions, including the undo
    // that takes an adopted worktree back off a global dock pane. That clear is
    // sent explicitly as `null` rather than skipped: leaving the old id behind
    // would keep the fleet palette grouping the run under a worktree the user
    // has just undone it out of (#12060).
    if (panelKindHasPty(restoredPanel.kind ?? "terminal")) {
      syncWorktreeAttributionToHost(id, after ?? null);
    }

    if (after === undefined) continue;
    reconcileMovedPanel(id, after);
  }
}

export const useLayoutUndoStore = create<LayoutUndoState>()((set, get) => ({
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,

  pushLayoutSnapshot: () => {
    const snapshot = captureCurrentLayout();
    set((state) => {
      // A capture with no layout panels has nothing to put back; it still ends
      // the redo branch, since a layout change is starting.
      const undoStack =
        snapshot.terminals.length > 0
          ? [...state.undoStack, snapshot].slice(-MAX_UNDO_HISTORY)
          : state.undoStack;
      return {
        undoStack,
        redoStack: [],
        canUndo: undoStack.length > 0,
        canRedo: false,
      };
    });
  },

  // Entries with nothing left to restore are dropped on the way to the newest
  // one that has, so a dead entry never parks on top of the stack.
  undo: () => {
    const { undoStack: undoEntries, redoStack: redoEntries } = get();
    if (undoEntries.length === 0) return;
    const history = restorableHistory(
      undoEntries,
      redoEntries,
      selectLayoutPanelIds(usePanelStore.getState())
    );
    const snapshot = history.undoStack[history.undoStack.length - 1];
    if (!snapshot) {
      set(history);
      return;
    }
    const currentLayout = captureCurrentLayout();
    applySnapshot(snapshot);

    const undoStack = history.undoStack.slice(0, -1);
    set({
      undoStack,
      redoStack: [...history.redoStack, currentLayout],
      canUndo: undoStack.length > 0,
      canRedo: true,
    });
  },

  redo: () => {
    const { undoStack: undoEntries, redoStack: redoEntries } = get();
    if (redoEntries.length === 0) return;
    const history = restorableHistory(
      undoEntries,
      redoEntries,
      selectLayoutPanelIds(usePanelStore.getState())
    );
    const snapshot = history.redoStack[history.redoStack.length - 1];
    if (!snapshot) {
      set(history);
      return;
    }
    const currentLayout = captureCurrentLayout();
    applySnapshot(snapshot);

    const redoStack = history.redoStack.slice(0, -1);
    set({
      undoStack: [...history.undoStack, currentLayout],
      redoStack,
      canUndo: true,
      canRedo: redoStack.length > 0,
    });
  },

  pruneHistory: () => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0 && redoStack.length === 0) return;
    const history = restorableHistory(
      undoStack,
      redoStack,
      selectLayoutPanelIds(usePanelStore.getState())
    );
    if (
      history.undoStack.length === undoStack.length &&
      history.redoStack.length === redoStack.length
    ) {
      return;
    }
    set(history);
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
