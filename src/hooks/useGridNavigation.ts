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

  useEffect(() => {
    directionCache.current.clear();
  }, [gridLayout, rowMajor, columnBuckets]);

  const findNearest = useCallback(
    (currentId: string, direction: NavigationDirection): string | null => {
      const cacheKey = `${currentId}:${direction}`;
      if (directionCache.current.has(cacheKey)) {
        return directionCache.current.get(cacheKey) ?? null;
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
            result = rowMajor[nextIndex].terminalId;
          } else {
            const prevIndex = (currentIndex - 1 + rowMajor.length) % rowMajor.length;
            result = rowMajor[prevIndex].terminalId;
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
            result = colBucket[nextIndex].terminalId;
          } else {
            const prevIndex = (currentColIndex - 1 + colBucket.length) % colBucket.length;
            result = colBucket[prevIndex].terminalId;
          }
          break;
        }
      }

      directionCache.current.set(cacheKey, result);
      return result;
    },
    [rowMajor, indexById, columnBuckets, positionById]
  );

  const findByIndex = useCallback(
    (index: number): string | null => {
      const position = rowMajor[index - 1];
      return position?.terminalId ?? null;
    },
    [rowMajor]
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
