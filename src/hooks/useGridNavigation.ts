import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { usePanelStore, useLayoutConfigStore, useWorktreeSelectionStore } from "@/store";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { useShallow } from "zustand/react/shallow";
import { computeGridColumns } from "@/lib/terminalLayout";
import { buildFleetPanels } from "@/components/Terminal/contentGridFleetPanels";

export type NavigationDirection = "up" | "down" | "left" | "right";

interface GridPosition {
  terminalId: string;
  row: number;
  col: number;
}

interface UseGridNavigationOptions {
  containerSelector?: string;
}

export function useGridNavigation(options: UseGridNavigationOptions = {}) {
  "use no memo";
  const { containerSelector = "#panel-grid" } = options;

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
  const layoutConfig = useLayoutConfigStore((state) => state.layoutConfig);

  const isFleetScopeEnabled = fleetScopeMode === "scoped" && isFleetScopeActive;

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

  // Track container width for responsive layout (mirrors ContentGrid)
  const [gridWidth, setGridWidth] = useState<number | null>(null);

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

  useEffect(() => {
    const findAndObserve = () => {
      const container = document.querySelector(containerSelector);
      if (!container) return null;

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          const newWidth = entry.contentRect.width;
          setGridWidth((prev) => (prev === newWidth ? prev : newWidth));
        }
      });

      observer.observe(container);
      setGridWidth(container.clientWidth);

      return observer;
    };

    const observer = findAndObserve();
    if (!observer) {
      const retryTimer = setTimeout(findAndObserve, 100);
      return () => clearTimeout(retryTimer);
    }

    return () => observer.disconnect();
    // isFleetScopeRender is a dep because ContentGrid swaps the rendered tree
    // (different React key) when fleet scope toggles, which detaches the old
    // #panel-grid node. Re-running the effect re-binds the observer to the
    // new node so gridCols continues to track resizes.
  }, [containerSelector, isFleetScopeRender]);

  // Derive visual grid groups (one cell per tab group), matching ContentGrid.
  // getTabGroups reads tabGroups/panelIds/panelsById from the store via get();
  // reference them so exhaustive-deps treats them as real deps without a
  // suppression (which would force the React Compiler to bail out).
  const gridGroups = useMemo(() => {
    void tabGroups;
    void panelIds;
    void panelsById;
    return getTabGroups("grid", activeWorktreeId ?? undefined);
  }, [getTabGroups, activeWorktreeId, tabGroups, panelIds, panelsById]);

  // Hysteresis input mirroring ContentGrid: keyboard-nav column count must
  // track the visual grid through the same sticky boundaries, otherwise arrow
  // navigation maps to wrong cells when count drops into the buffer zone.
  // Two refs (normal vs fleet) mirror ContentGrid's split so a normal-grid
  // history doesn't bleed into a fleet-scope render.
  const hysteresisNavGridColsRef = useRef<number | undefined>(undefined);
  const hysteresisNavFleetColsRef = useRef<number | undefined>(undefined);

  // Compute gridCols using visual group count, matching ContentGrid's gridItemCount.
  // In fleet scope render, count is fleet panels (matches ContentGrid.fleetGridCols).
  const gridCols = useMemo(() => {
    const { strategy, value } = layoutConfig;
    const count = isFleetScopeRender ? Math.max(fleetPanels.length, 1) : gridGroups.length;
    return computeGridColumns(
      count,
      gridWidth,
      strategy,
      value,
      isFleetScopeRender ? hysteresisNavFleetColsRef.current : hysteresisNavGridColsRef.current
    );
  }, [isFleetScopeRender, fleetPanels.length, gridGroups.length, layoutConfig, gridWidth]);

  useEffect(() => {
    // Only retain hysteresis state for the automatic strategy. Fixed strategies
    // produce user-chosen counts that must not bias a later auto computation.
    const value = layoutConfig.strategy === "automatic" ? gridCols : undefined;
    if (isFleetScopeRender) {
      hysteresisNavFleetColsRef.current = value;
    } else {
      hysteresisNavGridColsRef.current = value;
    }
  }, [gridCols, isFleetScopeRender, layoutConfig.strategy]);

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
      if (directionCacheRef.current.source !== gridLayout) {
        directionCacheRef.current = { source: gridLayout, map: new Map() };
      }
      const directionCache = directionCacheRef.current.map;

      const cacheKey = `${currentId}:${direction}`;
      if (directionCache.has(cacheKey)) {
        return directionCache.get(cacheKey) ?? null;
      }

      if (rowMajor.length === 0) return null;

      const current = positionById.get(currentId);
      if (!current) return null;

      let result: string | null = null;

      switch (direction) {
        case "left":
        case "right": {
          const currentIndex = indexById.get(currentId);
          if (currentIndex === undefined) break;

          if (direction === "right") {
            const nextIndex = (currentIndex + 1) % rowMajor.length;
            result = rowMajor[nextIndex]!.terminalId;
          } else {
            const prevIndex = (currentIndex - 1 + rowMajor.length) % rowMajor.length;
            result = rowMajor[prevIndex]!.terminalId;
          }
          break;
        }

        case "up":
        case "down": {
          const colBucket = columnBuckets.get(current.col);
          if (!colBucket || colBucket.length === 0) break;

          const currentColIndex = colBucket.findIndex((p) => p.terminalId === currentId);
          if (currentColIndex === -1) break;

          if (direction === "down") {
            const nextIndex = (currentColIndex + 1) % colBucket.length;
            result = colBucket[nextIndex]!.terminalId;
          } else {
            const prevIndex = (currentColIndex - 1 + colBucket.length) % colBucket.length;
            result = colBucket[prevIndex]!.terminalId;
          }
          break;
        }
      }

      directionCache.set(cacheKey, result);
      return result;
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
      return groupRowMajor[index - 1] ?? null;
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
