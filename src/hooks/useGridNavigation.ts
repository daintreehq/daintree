import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import { useTerminalStore, useLayoutConfigStore, useWorktreeSelectionStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { getAutoGridCols } from "@/lib/terminalLayout";

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
  const { containerSelector = "#terminal-grid" } = options;

  const { terminals, focusedId } = useTerminalStore(
    useShallow((state) => ({
      terminals: state.terminals,
      focusedId: state.focusedId,
    }))
  );

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const layoutConfig = useLayoutConfigStore((state) => state.layoutConfig);

  const gridTerminals = useMemo(
    () =>
      terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      ),
    [terminals, activeWorktreeId]
  );

  const dockTerminals = useMemo(
    () =>
      terminals.filter(
        (t) =>
          t.location === "dock" && (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      ),
    [terminals, activeWorktreeId]
  );

  const directionCache = useRef(new Map<string, string | null>());

  // Track container width for responsive layout (mirrors TerminalGrid)
  const [gridWidth, setGridWidth] = useState<number | null>(null);

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
  }, [containerSelector]);

  // Compute gridCols using the same logic as TerminalGrid
  const gridCols = useMemo(() => {
    const count = gridTerminals.length;
    if (count === 0) return 1;

    const { strategy, value } = layoutConfig;

    if (strategy === "fixed-columns") {
      return Math.max(1, Math.min(value, 10));
    }

    if (strategy === "fixed-rows") {
      const rows = Math.max(1, Math.min(value, 10));
      return Math.ceil(count / rows);
    }

    return getAutoGridCols(count, gridWidth);
  }, [gridTerminals.length, layoutConfig, gridWidth]);

  // Compute grid layout from indices (no DOM measurement)
  const gridLayout = useMemo(() => {
    if (gridTerminals.length === 0) return [];

    return gridTerminals.map((terminal, index) => ({
      terminalId: terminal.id,
      row: Math.floor(index / gridCols),
      col: index % gridCols,
    }));
  }, [gridTerminals, gridCols]);

  // Clear cache when grid layout changes
  useEffect(() => {
    directionCache.current.clear();
  }, [gridLayout]);

  const findNearest = useCallback(
    (currentId: string, direction: NavigationDirection): string | null => {
      const cacheKey = `${currentId}:${direction}`;
      if (directionCache.current.has(cacheKey)) {
        return directionCache.current.get(cacheKey) ?? null;
      }

      const current = gridLayout.find((p) => p.terminalId === currentId);
      if (!current) return null;

      let candidates: GridPosition[];

      switch (direction) {
        case "up":
          // Same column, lower row index
          candidates = gridLayout.filter((p) => p.col === current.col && p.row < current.row);
          // Get closest (max row index)
          candidates.sort((a, b) => b.row - a.row);
          // Fallback: if no exact column match, find nearest by column distance
          if (candidates.length === 0) {
            candidates = gridLayout.filter((p) => p.row < current.row);
            candidates.sort(
              (a, b) =>
                b.row - a.row || Math.abs(a.col - current.col) - Math.abs(b.col - current.col)
            );
          }
          break;

        case "down":
          // Same column, higher row index
          candidates = gridLayout.filter((p) => p.col === current.col && p.row > current.row);
          // Get closest (min row index)
          candidates.sort((a, b) => a.row - b.row);
          // Fallback: if no exact column match, find nearest by column distance
          if (candidates.length === 0) {
            candidates = gridLayout.filter((p) => p.row > current.row);
            candidates.sort(
              (a, b) =>
                a.row - b.row || Math.abs(a.col - current.col) - Math.abs(b.col - current.col)
            );
          }
          break;

        case "left":
          // Same row, lower col index
          candidates = gridLayout.filter((p) => p.row === current.row && p.col < current.col);
          // Get closest (max col index)
          candidates.sort((a, b) => b.col - a.col);
          break;

        case "right":
          // Same row, higher col index
          candidates = gridLayout.filter((p) => p.row === current.row && p.col > current.col);
          // Get closest (min col index)
          candidates.sort((a, b) => a.col - b.col);
          break;
      }

      let result = candidates[0]?.terminalId ?? null;

      // If we hit an edge, fall back to linear reading order (row-major)
      if (!result) {
        const sortedPositions = [...gridLayout].sort((a, b) => {
          if (a.row !== b.row) return a.row - b.row;
          return a.col - b.col;
        });

        const currentIndex = sortedPositions.findIndex((p) => p.terminalId === currentId);
        if (currentIndex !== -1) {
          if (direction === "right" || direction === "down") {
            const nextIndex = (currentIndex + 1) % sortedPositions.length;
            result = sortedPositions[nextIndex].terminalId;
          } else {
            const prevIndex = (currentIndex - 1 + sortedPositions.length) % sortedPositions.length;
            result = sortedPositions[prevIndex].terminalId;
          }
        }
      }

      directionCache.current.set(cacheKey, result);
      return result;
    },
    [gridLayout]
  );

  const findByIndex = useCallback(
    (index: number): string | null => {
      // Use visual order (sorted by row, then col)
      const sortedPositions = [...gridLayout].sort((a, b) => {
        if (a.row !== b.row) return a.row - b.row;
        return a.col - b.col;
      });

      // Index is 1-based for user convenience (Cmd+1 = first terminal)
      const position = sortedPositions[index - 1];
      return position?.terminalId ?? null;
    },
    [gridLayout]
  );

  const findDockByIndex = useCallback(
    (currentId: string, direction: "left" | "right"): string | null => {
      if (dockTerminals.length === 0) return null;

      const currentIndex = dockTerminals.findIndex((t) => t.id === currentId);
      if (currentIndex === -1) return null;

      if (direction === "left") {
        return currentIndex > 0 ? dockTerminals[currentIndex - 1].id : null;
      } else {
        return currentIndex < dockTerminals.length - 1 ? dockTerminals[currentIndex + 1].id : null;
      }
    },
    [dockTerminals]
  );

  const getCurrentLocation = useCallback((): "grid" | "dock" | null => {
    if (!focusedId) return null;
    const terminal = terminals.find((t) => t.id === focusedId);
    if (!terminal) return null;
    return terminal.location === "dock" ? "dock" : "grid";
  }, [focusedId, terminals]);

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
