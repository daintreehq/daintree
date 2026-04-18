import { describe, it, expect } from "vitest";
import type { NavigationDirection } from "../useGridNavigation";

interface GridPosition {
  terminalId: string;
  row: number;
  col: number;
  center: { x: number; y: number };
}

const createRowMajor = (positions: GridPosition[]) => {
  return [...positions].sort((a, b) => {
    if (a.row !== b.row) return a.row - b.row;
    return a.col - b.col;
  });
};

const createIndexById = (rowMajor: GridPosition[]) => {
  const map = new Map<string, number>();
  rowMajor.forEach((pos, index) => {
    map.set(pos.terminalId, index);
  });
  return map;
};

const createColumnBuckets = (positions: GridPosition[]) => {
  const buckets = new Map<number, GridPosition[]>();
  for (const pos of positions) {
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
};

const findNearest = (
  currentId: string,
  direction: NavigationDirection,
  gridLayout: GridPosition[]
): string | null => {
  const rowMajor = createRowMajor(gridLayout);
  const indexById = createIndexById(rowMajor);
  const columnBuckets = createColumnBuckets(gridLayout);

  if (rowMajor.length === 0) return null;

  const current = gridLayout.find((p) => p.terminalId === currentId);
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

  return result;
};

describe("Grid Navigation Logic", () => {
  const createGridLayout = (
    positions: { id: string; row: number; col: number }[]
  ): GridPosition[] => {
    return positions.map((pos) => ({
      terminalId: pos.id,
      row: pos.row,
      col: pos.col,
      center: { x: pos.col * 150, y: pos.row * 150 },
    }));
  };

  describe("horizontal navigation (left/right)", () => {
    it("wraps from rightmost to next row leftmost", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
        { id: "term-3", row: 0, col: 2 },
        { id: "term-4", row: 1, col: 0 },
        { id: "term-5", row: 1, col: 1 },
        { id: "term-6", row: 1, col: 2 },
      ]);

      const nextId = findNearest("term-3", "right", gridLayout);
      expect(nextId).toBe("term-4");
    });

    it("wraps from leftmost to previous row rightmost", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
        { id: "term-3", row: 0, col: 2 },
        { id: "term-4", row: 1, col: 0 },
        { id: "term-5", row: 1, col: 1 },
        { id: "term-6", row: 1, col: 2 },
      ]);

      const prevId = findNearest("term-4", "left", gridLayout);
      expect(prevId).toBe("term-3");
    });

    it("wraps from bottom-right to top-left", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
        { id: "term-3", row: 1, col: 0 },
        { id: "term-4", row: 1, col: 1 },
      ]);

      const nextId = findNearest("term-4", "right", gridLayout);
      expect(nextId).toBe("term-1");
    });

    it("wraps from top-left to bottom-right", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
        { id: "term-3", row: 1, col: 0 },
        { id: "term-4", row: 1, col: 1 },
      ]);

      const prevId = findNearest("term-1", "left", gridLayout);
      expect(prevId).toBe("term-4");
    });

    it("handles irregular rows with different column counts", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
        { id: "term-3", row: 0, col: 2 },
        { id: "term-4", row: 1, col: 0 },
        { id: "term-5", row: 2, col: 0 },
        { id: "term-6", row: 2, col: 1 },
      ]);

      const nextId = findNearest("term-3", "right", gridLayout);
      expect(nextId).toBe("term-4");
    });
  });

  describe("vertical navigation (up/down)", () => {
    it("loops to top of column when pressing down from bottom", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
        { id: "term-3", row: 0, col: 2 },
        { id: "term-4", row: 1, col: 0 },
        { id: "term-5", row: 1, col: 1 },
        { id: "term-6", row: 1, col: 2 },
      ]);

      const nextId = findNearest("term-4", "down", gridLayout);
      expect(nextId).toBe("term-1");
    });

    it("loops to bottom of column when pressing up from top", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
        { id: "term-3", row: 0, col: 2 },
        { id: "term-4", row: 1, col: 0 },
        { id: "term-5", row: 1, col: 1 },
        { id: "term-6", row: 1, col: 2 },
      ]);

      const prevId = findNearest("term-1", "up", gridLayout);
      expect(prevId).toBe("term-4");
    });

    it("stays within column in irregular grids", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
        { id: "term-3", row: 0, col: 2 },
        { id: "term-4", row: 1, col: 0 },
        { id: "term-5", row: 1, col: 2 },
      ]);

      const downId = findNearest("term-1", "down", gridLayout);
      expect(downId).toBe("term-4");

      const upId = findNearest("term-4", "up", gridLayout);
      expect(upId).toBe("term-1");
    });

    it("handles ragged grids with gaps using visual columns", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
        { id: "term-3", row: 0, col: 2 },
        { id: "term-4", row: 1, col: 0 },
        { id: "term-5", row: 1, col: 2 },
        { id: "term-6", row: 2, col: 1 },
        { id: "term-7", row: 2, col: 2 },
      ]);

      const downFrom3 = findNearest("term-3", "down", gridLayout);
      expect(downFrom3).toBe("term-5");

      const upFrom5 = findNearest("term-5", "up", gridLayout);
      expect(upFrom5).toBe("term-3");

      const downFrom2 = findNearest("term-2", "down", gridLayout);
      expect(downFrom2).toBe("term-6");

      const upFrom6 = findNearest("term-6", "up", gridLayout);
      expect(upFrom6).toBe("term-2");
    });

    it("loops to self in single-row column", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
        { id: "term-3", row: 0, col: 2 },
      ]);

      const downId = findNearest("term-2", "down", gridLayout);
      const upId = findNearest("term-2", "up", gridLayout);

      expect(downId).toBe("term-2");
      expect(upId).toBe("term-2");
    });
  });

  describe("tab-group-aware grid layout", () => {
    // Simulates the hook's new behavior: one grid position per visual group,
    // using activeTabId as the representative terminalId.
    const buildGroupLayout = (
      groups: { activeTabId: string; panelIds: string[] }[],
      cols: number
    ): GridPosition[] => {
      return groups
        .map((group, index) => {
          const resolvedId = group.panelIds.includes(group.activeTabId)
            ? group.activeTabId
            : group.panelIds[0];
          return resolvedId
            ? {
                terminalId: resolvedId,
                row: Math.floor(index / cols),
                col: index % cols,
                center: { x: (index % cols) * 150, y: Math.floor(index / cols) * 150 },
              }
            : null;
        })
        .filter((pos): pos is GridPosition => pos !== null);
    };

    it("uses group count for columns, not raw terminal count", () => {
      // 3 raw terminals in 2 visual groups (first group has 2 tabs)
      const groups = [
        { activeTabId: "term-1", panelIds: ["term-1", "term-2"] },
        { activeTabId: "term-3", panelIds: ["term-3"] },
      ];
      const layout = buildGroupLayout(groups, 2);

      expect(layout).toHaveLength(2);
      expect(layout[0]).toMatchObject({ terminalId: "term-1", row: 0, col: 0 });
      expect(layout[1]).toMatchObject({ terminalId: "term-3", row: 0, col: 1 });
    });

    it("down from col 1 stays in col 1 with tab groups", () => {
      // 6 raw terminals → 4 visual groups (2 columns, 2 rows)
      const groups = [
        { activeTabId: "term-1", panelIds: ["term-1", "term-2"] },
        { activeTabId: "term-3", panelIds: ["term-3"] },
        { activeTabId: "term-4", panelIds: ["term-4", "term-5"] },
        { activeTabId: "term-6", panelIds: ["term-6"] },
      ];
      const layout = buildGroupLayout(groups, 2);

      // Down from col 1, row 0 → col 1, row 1
      expect(findNearest("term-3", "down", layout)).toBe("term-6");
      // Up from col 1, row 1 → col 1, row 0
      expect(findNearest("term-6", "up", layout)).toBe("term-3");
      // Down from col 0, row 0 → col 0, row 1
      expect(findNearest("term-1", "down", layout)).toBe("term-4");
    });

    it("uses activeTabId as navigation target", () => {
      const groups = [
        { activeTabId: "term-2", panelIds: ["term-1", "term-2", "term-3"] },
        { activeTabId: "term-5", panelIds: ["term-4", "term-5"] },
      ];
      const layout = buildGroupLayout(groups, 2);

      // The representative IDs should be the activeTabIds
      expect(layout[0]!.terminalId).toBe("term-2");
      expect(layout[1]!.terminalId).toBe("term-5");
    });

    it("falls back to panelIds[0] when activeTabId is invalid", () => {
      const groups = [
        { activeTabId: "stale-id", panelIds: ["term-1", "term-2"] },
        { activeTabId: "term-3", panelIds: ["term-3"] },
      ];
      const layout = buildGroupLayout(groups, 2);

      expect(layout[0]!.terminalId).toBe("term-1");
    });

    it("returns null for non-representative (hidden tab) ID", () => {
      // term-2 is in a group but not the active tab
      const groups = [
        { activeTabId: "term-1", panelIds: ["term-1", "term-2"] },
        { activeTabId: "term-3", panelIds: ["term-3"] },
      ];
      const layout = buildGroupLayout(groups, 2);

      // term-2 is not in the layout, so findNearest returns null
      expect(findNearest("term-2", "down", layout)).toBe(null);
    });

    it("handles 3×3 group grid with correct column navigation", () => {
      // 9 visual groups in 3 columns — the exact scenario from the issue
      const groups = [
        { activeTabId: "g1", panelIds: ["g1"] },
        { activeTabId: "g2", panelIds: ["g2"] },
        { activeTabId: "g3", panelIds: ["g3", "g3b"] },
        { activeTabId: "g4", panelIds: ["g4"] },
        { activeTabId: "g5", panelIds: ["g5"] },
        { activeTabId: "g6", panelIds: ["g6"] },
        { activeTabId: "g7", panelIds: ["g7"] },
        { activeTabId: "g8", panelIds: ["g8"] },
        { activeTabId: "g9", panelIds: ["g9"] },
      ];
      const layout = buildGroupLayout(groups, 3);

      // Down from top-right (g3, col 2) → middle-right (g6, col 2)
      expect(findNearest("g3", "down", layout)).toBe("g6");
      // Down from middle-right → bottom-right
      expect(findNearest("g6", "down", layout)).toBe("g9");
      // Up from bottom-right → middle-right
      expect(findNearest("g9", "up", layout)).toBe("g6");
      // Down from bottom-right wraps to top-right
      expect(findNearest("g9", "down", layout)).toBe("g3");
    });

    it("handles incomplete last row with groups", () => {
      // 5 visual groups in 3 columns: row 0 has 3, row 1 has 2
      const groups = [
        { activeTabId: "g1", panelIds: ["g1"] },
        { activeTabId: "g2", panelIds: ["g2"] },
        { activeTabId: "g3", panelIds: ["g3"] },
        { activeTabId: "g4", panelIds: ["g4", "g4b"] },
        { activeTabId: "g5", panelIds: ["g5"] },
      ];
      const layout = buildGroupLayout(groups, 3);

      // Col 2 only has g3 (row 0), no row 1 entry — wraps to itself
      expect(findNearest("g3", "down", layout)).toBe("g3");
      // Col 0: g1 (row 0) → g4 (row 1)
      expect(findNearest("g1", "down", layout)).toBe("g4");
      // Col 1: g2 (row 0) → g5 (row 1)
      expect(findNearest("g2", "down", layout)).toBe("g5");
    });
  });

  describe("edge cases", () => {
    it("handles single terminal", () => {
      const gridLayout = createGridLayout([{ id: "term-1", row: 0, col: 0 }]);

      expect(findNearest("term-1", "right", gridLayout)).toBe("term-1");
      expect(findNearest("term-1", "left", gridLayout)).toBe("term-1");
      expect(findNearest("term-1", "up", gridLayout)).toBe("term-1");
      expect(findNearest("term-1", "down", gridLayout)).toBe("term-1");
    });

    it("handles two terminals", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
      ]);

      expect(findNearest("term-1", "right", gridLayout)).toBe("term-2");
      expect(findNearest("term-2", "right", gridLayout)).toBe("term-1");
      expect(findNearest("term-1", "left", gridLayout)).toBe("term-2");
      expect(findNearest("term-2", "left", gridLayout)).toBe("term-1");
    });

    it("returns null for empty grid", () => {
      const gridLayout: GridPosition[] = [];

      expect(findNearest("term-1", "right", gridLayout)).toBe(null);
    });

    it("returns null for non-existent terminal", () => {
      const gridLayout = createGridLayout([
        { id: "term-1", row: 0, col: 0 },
        { id: "term-2", row: 0, col: 1 },
      ]);

      expect(findNearest("term-999", "right", gridLayout)).toBe(null);
    });
  });
});
