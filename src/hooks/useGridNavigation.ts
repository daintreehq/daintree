import { useMemo, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { usePanelStore, useWorktreeSelectionStore } from "@/store";
import { getClosingIdsSnapshot } from "@/services/terminal/optimisticPanelClose";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { useShallow } from "zustand/react/shallow";
import { buildFleetPanels } from "@/components/Terminal/contentGridFleetPanels";
import {
  getGridLayoutSnapshot,
  subscribeGridLayoutSnapshot,
} from "@/components/Terminal/gridLayoutSnapshot";

export type NavigationDirection = "up" | "down" | "left" | "right";

interface GridPosition {
  terminalId: string;
  row: number;
  col: number;
}

export function useGridNavigation() {
  "use no memo";

  const { panelIds, panelsById, focusedId, tabGroups, getTabGroups } = usePanelStore(
    useShallow((state) => ({
      panelIds: state.panelIds,
      panelsById: state.panelsById,
      focusedId: state.focusedId,
      tabGroups: state.tabGroups,
      getTabGroups: state.getTabGroups,
    }))
  );

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const isFleetScopeActive = useWorktreeSelectionStore((state) => state.isFleetScopeActive);
  const fleetScopeMode = useFleetScopeFlagStore((state) => state.mode);
  const { armedIds, armOrder } = useFleetArmingStore(
    useShallow((state) => ({ armedIds: state.armedIds, armOrder: state.armOrder }))
  );

  const isFleetScopeEnabled = fleetScopeMode === "scoped" && isFleetScopeActive;

  // Optimistically-closing panels are excluded from navigation results, but
  // imperatively at keypress time (see findNearest/findByIndex) — NOT via a
  // reactive subscription. This hook runs at the App root, so a render-time
  // `closingIds` subscription would re-render the whole app on every close.
  const gridTerminals = useMemo(
    () =>
      panelIds
        .map((id) => panelsById[id])
        .filter(
          (t) =>
            t &&
            (t.location === "grid" || t.location === undefined) &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        ),
    [panelIds, panelsById, activeWorktreeId]
  );

  const dockTerminals = useMemo(
    () =>
      panelIds
        .map((id) => panelsById[id])
        .filter(
          (t) =>
            t &&
            t.location === "dock" &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        ),
    [panelIds, panelsById, activeWorktreeId]
  );

  // Fleet scope projection: must mirror ContentGrid's fleetPanels exactly so
  // the focus model lines up with what's rendered. Drift here was the cause
  // of #5989 (Cmd+Alt+Arrow no-op when fleet scope spanned worktrees).
  const fleetPanels = useMemo(() => {
    if (!isFleetScopeEnabled) return [];
    return buildFleetPanels(armOrder, armedIds, panelsById);
  }, [isFleetScopeEnabled, armOrder, armedIds, panelsById]);

  // Mirrors ContentGrid.isFleetScopeRender — when fleet scope is on but every
  // armed panel has been moved to dock/trash, ContentGrid falls through to
  // the normal active-worktree grid; the nav model has to match.
  const isFleetScopeRender = isFleetScopeEnabled && fleetPanels.length > 0;

  // Derive visual grid groups (one cell per tab group), matching ContentGrid.
  // getTabGroups reads tabGroups/panelIds/panelsById from the store via get();
  // reference them so exhaustive-deps treats them as real deps without a
  // suppression (which would force the React Compiler to bail out).
  //
  // No capacity cap — the scrollable grid (#8805) keeps every group in the
  // grid, and keyboard nav must reach scrolled-off cells just like the mouse.
  const gridGroups = useMemo(() => {
    void tabGroups;
    void panelIds;
    void panelsById;
    return getTabGroups("grid", activeWorktreeId ?? undefined);
  }, [getTabGroups, activeWorktreeId, tabGroups, panelIds, panelsById]);

  // Read the authoritative column counts from `useContentGridContext`'s
  // snapshot. Computing them independently here drifted from the rendered
  // grid whenever maximize/restore, drag placeholder, or hysteresis state
  // were in flight (#8857). `useSyncExternalStore` re-renders this hook on
  // every column change — including pure-resize changes that don't otherwise
  // touch subscribed store state.
  const snapshot = useSyncExternalStore(subscribeGridLayoutSnapshot, getGridLayoutSnapshot);
  const gridCols = isFleetScopeRender ? snapshot.fleetGridCols : snapshot.gridCols;

  // Compute grid layout from visual groups (no DOM measurement). Fleet branch
  // treats each armed panel as its own single-cell position, mirroring how
  // ContentGrid renders the flat fleet grid when scope is active.
  const gridLayout = useMemo(() => {
    if (isFleetScopeRender) {
      return fleetPanels.map((t, index) => ({
        terminalId: t.id,
        row: Math.floor(index / gridCols),
        col: index % gridCols,
      }));
    }

    if (gridGroups.length === 0) return [];

    return gridGroups
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
  }, [isFleetScopeRender, fleetPanels, gridGroups, gridCols]);

  const rowMajor = useMemo(() => {
    return [...gridLayout].sort((a, b) => {
      if (a.row !== b.row) return a.row - b.row;
      return a.col - b.col;
    });
  }, [gridLayout]);

  const positionById = useMemo(() => {
    const map = new Map<string, GridPosition>();
    for (const pos of gridLayout) map.set(pos.terminalId, pos);
    return map;
  }, [gridLayout]);

  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    rowMajor.forEach((pos, index) => {
      map.set(pos.terminalId, index);
    });
    return map;
  }, [rowMajor]);

  const columnBuckets = useMemo(() => {
    const buckets = new Map<number, GridPosition[]>();
    for (const pos of gridLayout) {
      const col = pos.col;
      if (!buckets.has(col)) {
        buckets.set(col, []);
      }
      buckets.get(col)!.push(pos);
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => a.row - b.row);
    }
    return buckets;
  }, [gridLayout]);

  // Tied structurally to gridLayout: the cache is reset synchronously when
  // the layout changes, so a fleet-scope toggle can never serve a stale
  // cached result on the next keypress. Held in a ref because the React
  // Compiler treats useMemo results as immutable and rejects in-place .set().
  const directionCacheRef = useRef<{
    source: unknown;
    map: Map<string, string | null>;
  }>({ source: null, map: new Map() });

  const findNearest = useCallback(
    (currentId: string, direction: NavigationDirection): string | null => {
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

      // Fast path: nothing closing — use the per-layout direction cache.
      const closing = getClosingIdsSnapshot();
      if (closing.size === 0) {
        if (directionCacheRef.current.source !== gridLayout) {
          directionCacheRef.current = { source: gridLayout, map: new Map() };
        }
        const cache = directionCacheRef.current.map;
        const cacheKey = `${currentId}:${direction}`;
        if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;
        const result = stepOnce(currentId);
        cache.set(cacheKey, result);
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
    [rowMajor, indexById, columnBuckets, positionById, gridLayout]
  );

  // Build a group-aware ordered list matching ContentGrid's visual order.
  // Uses getTabGroups for ordering (explicit groups first by terminal order, then virtual groups)
  // so Cmd+N indices are consistent with what the user sees on screen. In
  // fleet scope render, the visible order is armOrder, so Cmd+N maps to that.
  const groupRowMajor = useMemo(() => {
    void tabGroups;
    void panelIds;
    void panelsById;
    if (isFleetScopeRender) {
      return fleetPanels.map((t) => t.id);
    }
    // Scrollable grid (#8805): all groups participate in nav order; Cmd+N
    // reaches every grid cell, including scrolled-off ones.
    const orderedGroups = getTabGroups("grid", activeWorktreeId ?? undefined);
    return orderedGroups.flatMap((group) => {
      const resolvedId = group.panelIds.includes(group.activeTabId)
        ? group.activeTabId
        : group.panelIds[0];
      return resolvedId ? [resolvedId] : [];
    });
  }, [
    isFleetScopeRender,
    fleetPanels,
    getTabGroups,
    activeWorktreeId,
    tabGroups,
    panelIds,
    panelsById,
  ]);

  const findByIndex = useCallback(
    (index: number): string | null => {
      const closing = getClosingIdsSnapshot();
      const order =
        closing.size === 0 ? groupRowMajor : groupRowMajor.filter((id) => !closing.has(id));
      return order[index - 1] ?? null;
    },
    [groupRowMajor]
  );

  const findDockByIndex = useCallback(
    (currentId: string, direction: "left" | "right"): string | null => {
      if (dockTerminals.length === 0) return null;

      const currentIndex = dockTerminals.findIndex((t) => t!.id === currentId);
      if (currentIndex === -1) return null;

      if (direction === "left") {
        return currentIndex > 0 ? dockTerminals[currentIndex - 1]!.id : null;
      } else {
        return currentIndex < dockTerminals.length - 1 ? dockTerminals[currentIndex + 1]!.id : null;
      }
    },
    [dockTerminals]
  );

  const getCurrentLocation = useCallback((): "grid" | "dock" | null => {
    if (!focusedId) return null;
    const terminal = panelsById[focusedId];
    if (!terminal) return null;
    return terminal.location === "dock" ? "dock" : "grid";
  }, [focusedId, panelsById]);

  // Scrollable grid (#8805): when keyboard navigation lands focus on a panel
  // that's currently scrolled out of the viewport, bring it into view so the
  // user can see what they just focused. Cheap no-op for already-visible cells.
  //
  // `panelsById` is read non-reactively here. Including it in deps would
  // re-fire this effect on every agent-state tick (which mutates the
  // `panelsById` reference), snapping the user's scroll position back to the
  // focused panel and overriding any manual scroll they did to inspect
  // off-screen panels.
  useEffect(() => {
    if (!focusedId) return;
    const terminal = usePanelStore.getState().panelsById[focusedId];
    if (!terminal || terminal.location === "dock") return;
    const element = document.querySelector<HTMLElement>(`[data-panel-id="${focusedId}"]`);
    element?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [focusedId]);

  return {
    gridLayout,
    gridTerminals,
    dockTerminals,
    findNearest,
    findByIndex,
    findDockByIndex,
    getCurrentLocation,
  };
}
