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
