import { useCallback, useEffect, useRef } from "react";
import { usePanelStore, useWorktreeSelectionStore } from "@/store";
import { getClosingIdsSnapshot } from "@/services/terminal/optimisticPanelClose";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { buildFleetPanels } from "@/components/Terminal/contentGridFleetPanels";
import { getGridLayoutSnapshot } from "@/components/Terminal/gridLayoutSnapshot";

export type NavigationDirection = "up" | "down" | "left" | "right";

interface GridPosition {
  terminalId: string;
  row: number;
  col: number;
}

interface NavModel {
  gridLayout: GridPosition[];
  rowMajor: GridPosition[];
  positionById: Map<string, GridPosition>;
  indexById: Map<string, number>;
  columnBuckets: Map<number, GridPosition[]>;
  groupRowMajor: string[];
  dockIds: string[];
  directionCache: Map<string, string | null>;
}

// Everything the model derives from; a keypress rebuilds only when one of
// these references changed since the previous keypress.
interface NavInputs {
  tabGroups: unknown;
  panelIds: unknown;
  panelsById: unknown;
  trashedTerminals: unknown;
  panelIdsByWorktreeId: unknown;
  activeWorktreeId: string | null | undefined;
  isFleetScopeEnabled: boolean;
  armOrder: unknown;
  armedIds: unknown;
  gridCols: number;
  fleetGridCols: number;
}

function inputsEqual(a: NavInputs, b: NavInputs): boolean {
  return (
    a.tabGroups === b.tabGroups &&
    a.panelIds === b.panelIds &&
    a.panelsById === b.panelsById &&
    a.trashedTerminals === b.trashedTerminals &&
    a.panelIdsByWorktreeId === b.panelIdsByWorktreeId &&
    a.activeWorktreeId === b.activeWorktreeId &&
    a.isFleetScopeEnabled === b.isFleetScopeEnabled &&
    a.armOrder === b.armOrder &&
    a.armedIds === b.armedIds &&
    a.gridCols === b.gridCols &&
    a.fleetGridCols === b.fleetGridCols
  );
}

function readInputs(): NavInputs {
  const panel = usePanelStore.getState();
  const selection = useWorktreeSelectionStore.getState();
  const fleet = useFleetArmingStore.getState();
  const snapshot = getGridLayoutSnapshot();
  return {
    tabGroups: panel.tabGroups,
    panelIds: panel.panelIds,
    panelsById: panel.panelsById,
    trashedTerminals: panel.trashedTerminals,
    panelIdsByWorktreeId: panel.panelIdsByWorktreeId,
    activeWorktreeId: selection.activeWorktreeId,
    isFleetScopeEnabled:
      useFleetScopeFlagStore.getState().mode === "scoped" && selection.isFleetScopeActive,
    armOrder: fleet.armOrder,
    armedIds: fleet.armedIds,
    gridCols: snapshot.gridCols,
    fleetGridCols: snapshot.fleetGridCols,
  };
}

function buildModel(): NavModel {
  const panel = usePanelStore.getState();
  const { panelIds, panelsById } = panel;
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
  const isFleetScopeEnabled =
    useFleetScopeFlagStore.getState().mode === "scoped" &&
    useWorktreeSelectionStore.getState().isFleetScopeActive;
  const { armedIds, armOrder } = useFleetArmingStore.getState();

  const dockIds: string[] = [];
  for (const id of panelIds) {
    const t = panelsById[id];
    if (
      t &&
      t.location === "dock" &&
      (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
    ) {
      dockIds.push(id);
    }
  }

  // Fleet scope projection: must mirror ContentGrid's fleetPanels exactly so
  // the focus model lines up with what's rendered. Drift here was the cause
  // of #5989 (Cmd+Alt+Arrow no-op when fleet scope spanned worktrees).
  const fleetPanels = isFleetScopeEnabled ? buildFleetPanels(armOrder, armedIds, panelsById) : [];

  // Mirrors ContentGrid.isFleetScopeRender — when fleet scope is on but every
  // armed panel has been moved to dock/trash, ContentGrid falls through to
  // the normal active-worktree grid; the nav model has to match.
  const isFleetScopeRender = isFleetScopeEnabled && fleetPanels.length > 0;

  // The authoritative column counts come from `useContentGridContext`'s
  // snapshot. Computing them independently drifted from the rendered grid
  // whenever maximize/restore, drag placeholder, or hysteresis state were in
  // flight (#8857).
  const snapshot = getGridLayoutSnapshot();
  const gridCols = isFleetScopeRender ? snapshot.fleetGridCols : snapshot.gridCols;

  // No capacity cap — the scrollable grid (#8805) keeps every group in the
  // grid, and keyboard nav must reach scrolled-off cells just like the mouse.
  const gridGroups = isFleetScopeRender
    ? []
    : panel.getTabGroups("grid", activeWorktreeId ?? undefined);

  // Fleet branch treats each armed panel as its own single-cell position,
  // mirroring how ContentGrid renders the flat fleet grid when scope is active.
  let gridLayout: GridPosition[];
  if (isFleetScopeRender) {
    gridLayout = fleetPanels.map((t, index) => ({
      terminalId: t.id,
      row: Math.floor(index / gridCols),
      col: index % gridCols,
    }));
  } else {
    gridLayout = gridGroups
      .map((group, index) => {
        const resolvedId = group.panelIds.includes(group.activeTabId)
          ? group.activeTabId
          : group.panelIds[0];
        return resolvedId
          ? {
              terminalId: resolvedId,
              row: Math.floor(index / gridCols),
              col: index % gridCols,
            }
          : null;
      })
      .filter((pos): pos is GridPosition => pos !== null);
  }

  const rowMajor = [...gridLayout].sort((a, b) => {
    if (a.row !== b.row) return a.row - b.row;
    return a.col - b.col;
  });

  const positionById = new Map<string, GridPosition>();
  for (const pos of gridLayout) positionById.set(pos.terminalId, pos);

  const indexById = new Map<string, number>();
  rowMajor.forEach((pos, index) => indexById.set(pos.terminalId, index));

  const columnBuckets = new Map<number, GridPosition[]>();
  for (const pos of gridLayout) {
    let bucket = columnBuckets.get(pos.col);
    if (!bucket) {
      bucket = [];
      columnBuckets.set(pos.col, bucket);
    }
    bucket.push(pos);
  }
  for (const bucket of columnBuckets.values()) bucket.sort((a, b) => a.row - b.row);

  // Group-aware ordered list matching ContentGrid's visual order, so Cmd+N
  // indices are consistent with what the user sees. In fleet scope render the
  // visible order is armOrder, so Cmd+N maps to that. All groups participate
  // (#8805): Cmd+N reaches scrolled-off cells too.
  const groupRowMajor = isFleetScopeRender
    ? fleetPanels.map((t) => t.id)
    : gridLayout.map((pos) => pos.terminalId);

  return {
    gridLayout,
    rowMajor,
    positionById,
    indexById,
    columnBuckets,
    groupRowMajor,
    dockIds,
    directionCache: new Map(),
  };
}

export function useGridNavigation() {
  // Navigation data is read at keypress time, not subscribed to: this hook
  // runs at the App root, and panelsById changes on every panel activity
  // flush (up to once per frame while an agent streams), which would
  // re-render the whole app just to keep this model fresh. The model is
  // rebuilt lazily when the store references it derives from have changed.
  const cacheRef = useRef<{ inputs: NavInputs; model: NavModel } | null>(null);

  const getModel = useCallback((): NavModel => {
    const inputs = readInputs();
    const cached = cacheRef.current;
    if (cached && inputsEqual(cached.inputs, inputs)) return cached.model;
    const model = buildModel();
    cacheRef.current = { inputs, model };
    return model;
  }, []);

  const focusedId = usePanelStore((state) => state.focusedId);

  const findNearest = useCallback(
    (currentId: string, direction: NavigationDirection): string | null => {
      const { rowMajor, positionById, indexById, columnBuckets, directionCache } = getModel();
      if (rowMajor.length === 0) return null;

      // One navigation step in `direction` from `fromId`, ignoring closing state.
      const stepOnce = (fromId: string): string | null => {
        const current = positionById.get(fromId);
        if (!current) return null;

        switch (direction) {
          case "left":
          case "right": {
            const currentIndex = indexById.get(fromId);
            if (currentIndex === undefined) return null;
            const nextIndex =
              direction === "right"
                ? (currentIndex + 1) % rowMajor.length
                : (currentIndex - 1 + rowMajor.length) % rowMajor.length;
            return rowMajor[nextIndex]!.terminalId;
          }
          case "up":
          case "down": {
            const colBucket = columnBuckets.get(current.col);
            if (!colBucket || colBucket.length === 0) return null;
            const colIndex = colBucket.findIndex((p) => p.terminalId === fromId);
            if (colIndex === -1) return null;
            const nextIndex =
              direction === "down"
                ? (colIndex + 1) % colBucket.length
                : (colIndex - 1 + colBucket.length) % colBucket.length;
            return colBucket[nextIndex]!.terminalId;
          }
        }
        return null;
      };

      // Optimistically-closing panels are excluded from navigation results,
      // read imperatively here rather than via a reactive subscription.
      const closing = getClosingIdsSnapshot();
      if (closing.size === 0) {
        const cacheKey = `${currentId}:${direction}`;
        if (directionCache.has(cacheKey)) return directionCache.get(cacheKey) ?? null;
        const result = stepOnce(currentId);
        directionCache.set(cacheKey, result);
        return result;
      }

      // Optimistic close in flight: step past any panel that's hiding. The
      // direction cache is keyed on layout identity only, so bypass it here.
      let result = stepOnce(currentId);
      let guard = rowMajor.length;
      while (result !== null && closing.has(result) && guard-- > 0) {
        result = stepOnce(result);
      }
      return result !== null && closing.has(result) ? null : result;
    },
    [getModel]
  );

  const findByIndex = useCallback(
    (index: number): string | null => {
      const { groupRowMajor } = getModel();
      const closing = getClosingIdsSnapshot();
      const order =
        closing.size === 0 ? groupRowMajor : groupRowMajor.filter((id) => !closing.has(id));
      return order[index - 1] ?? null;
    },
    [getModel]
  );

  const findDockByIndex = useCallback(
    (currentId: string, direction: "left" | "right"): string | null => {
      const { dockIds } = getModel();
      if (dockIds.length === 0) return null;

      const currentIndex = dockIds.indexOf(currentId);
      if (currentIndex === -1) return null;

      if (direction === "left") {
        return currentIndex > 0 ? dockIds[currentIndex - 1]! : null;
      } else {
        return currentIndex < dockIds.length - 1 ? dockIds[currentIndex + 1]! : null;
      }
    },
    [getModel]
  );

  const getCurrentLocation = useCallback((): "grid" | "dock" | null => {
    const state = usePanelStore.getState();
    if (!state.focusedId) return null;
    const terminal = state.panelsById[state.focusedId];
    if (!terminal) return null;
    return terminal.location === "dock" ? "dock" : "grid";
  }, []);

  // Scrollable grid (#8805): when keyboard navigation lands focus on a panel
  // that's currently scrolled out of the viewport, bring it into view so the
  // user can see what they just focused. Cheap no-op for already-visible cells.
  //
  // `panelsById` is read non-reactively here so agent-state ticks can't snap
  // the user's scroll position back to the focused panel.
  useEffect(() => {
    if (!focusedId) return;
    const terminal = usePanelStore.getState().panelsById[focusedId];
    if (!terminal || terminal.location === "dock") return;
    const element = document.querySelector<HTMLElement>(`[data-panel-id="${focusedId}"]`);
    element?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [focusedId]);

  return { findNearest, findByIndex, findDockByIndex, getCurrentLocation };
}
