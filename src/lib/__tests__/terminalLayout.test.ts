import { describe, it, expect } from "vitest";
import {
  getAutoGridCols,
  getMaxGridCapacity,
  MIN_TERMINAL_WIDTH_PX,
  MIN_TERMINAL_HEIGHT_PX,
  ABSOLUTE_MAX_GRID_TERMINALS,
} from "../terminalLayout";

describe("getAutoGridCols", () => {
  describe("single terminal", () => {
    it("should return 1 for count of 0", () => {
      expect(getAutoGridCols(0, null)).toBe(1);
    });

    it("should return 1 for count of 1 regardless of width", () => {
      expect(getAutoGridCols(1, null)).toBe(1);
      expect(getAutoGridCols(1, 500)).toBe(1);
      expect(getAutoGridCols(1, 1000)).toBe(1);
      expect(getAutoGridCols(1, 2000)).toBe(1);
    });

    it("should handle negative counts defensively", () => {
      expect(getAutoGridCols(-1, null)).toBe(1);
      expect(getAutoGridCols(-10, null)).toBe(1);
    });
  });

  describe("progressive column caps", () => {
    const wideWidth = MIN_TERMINAL_WIDTH_PX * 5; // Room for 5 columns

    it("should return 2 columns for 2-5 terminals (when width permits)", () => {
      expect(getAutoGridCols(2, wideWidth)).toBe(2);
      expect(getAutoGridCols(3, wideWidth)).toBe(2);
      expect(getAutoGridCols(4, wideWidth)).toBe(2);
      expect(getAutoGridCols(5, wideWidth)).toBe(2);
    });

    it("should return 3 columns for 6-11 terminals (when width permits)", () => {
      expect(getAutoGridCols(6, wideWidth)).toBe(3);
      expect(getAutoGridCols(7, wideWidth)).toBe(3);
      expect(getAutoGridCols(8, wideWidth)).toBe(3);
      expect(getAutoGridCols(9, wideWidth)).toBe(3);
      expect(getAutoGridCols(10, wideWidth)).toBe(3);
      expect(getAutoGridCols(11, wideWidth)).toBe(3);
    });

    it("should return 4 columns for 12+ terminals (when width permits)", () => {
      expect(getAutoGridCols(12, wideWidth)).toBe(4);
      expect(getAutoGridCols(13, wideWidth)).toBe(4);
      expect(getAutoGridCols(14, wideWidth)).toBe(4);
      expect(getAutoGridCols(15, wideWidth)).toBe(4);
      expect(getAutoGridCols(16, wideWidth)).toBe(4);
    });

    it("should never exceed 4 columns even with many terminals", () => {
      expect(getAutoGridCols(20, wideWidth)).toBe(4);
      expect(getAutoGridCols(100, wideWidth)).toBe(4);
    });
  });

  describe("width constraints", () => {
    it("should return 1 column when width only fits 1", () => {
      const narrowWidth = MIN_TERMINAL_WIDTH_PX * 1.5;
      expect(getAutoGridCols(2, narrowWidth)).toBe(1);
      expect(getAutoGridCols(6, narrowWidth)).toBe(1);
      expect(getAutoGridCols(12, narrowWidth)).toBe(1);
    });

    it("should return 2 columns max when width only fits 2", () => {
      const mediumWidth = MIN_TERMINAL_WIDTH_PX * 2.5;
      expect(getAutoGridCols(2, mediumWidth)).toBe(2);
      expect(getAutoGridCols(6, mediumWidth)).toBe(2); // Would want 3, but only 2 fit
      expect(getAutoGridCols(12, mediumWidth)).toBe(2); // Would want 4, but only 2 fit
    });

    it("should return 3 columns max when width only fits 3", () => {
      const width = MIN_TERMINAL_WIDTH_PX * 3.5;
      expect(getAutoGridCols(6, width)).toBe(3);
      expect(getAutoGridCols(12, width)).toBe(3); // Would want 4, but only 3 fit
    });

    it("should use fallback width when null", () => {
      // Fallback width is 800, which fits 2 columns (800 / 380 = 2.1)
      expect(getAutoGridCols(2, null)).toBe(2);
      expect(getAutoGridCols(5, null)).toBe(2);
      expect(getAutoGridCols(6, null)).toBe(2); // Would want 3, but fallback only fits 2
    });
  });

  describe("no empty columns", () => {
    const wideWidth = MIN_TERMINAL_WIDTH_PX * 5;

    it("should not use more columns than terminals", () => {
      // 2 terminals should use 2 columns, not more
      expect(getAutoGridCols(2, wideWidth)).toBe(2);
      // 3 terminals could use 3 but is capped at 2 for this count range
      expect(getAutoGridCols(3, wideWidth)).toBe(2);
    });
  });

  describe("stability within ranges", () => {
    const wideWidth = MIN_TERMINAL_WIDTH_PX * 5;

    it("column count stays stable within 2-5 terminal range", () => {
      const cols2 = getAutoGridCols(2, wideWidth);
      const cols3 = getAutoGridCols(3, wideWidth);
      const cols4 = getAutoGridCols(4, wideWidth);
      const cols5 = getAutoGridCols(5, wideWidth);
      expect(cols2).toBe(cols3);
      expect(cols3).toBe(cols4);
      expect(cols4).toBe(cols5);
    });

    it("column count stays stable within 6-11 terminal range", () => {
      const cols6 = getAutoGridCols(6, wideWidth);
      const cols9 = getAutoGridCols(9, wideWidth);
      const cols11 = getAutoGridCols(11, wideWidth);
      expect(cols6).toBe(cols9);
      expect(cols9).toBe(cols11);
    });

    it("column count stays stable within 12-16 terminal range", () => {
      const cols12 = getAutoGridCols(12, wideWidth);
      const cols14 = getAutoGridCols(14, wideWidth);
      const cols16 = getAutoGridCols(16, wideWidth);
      expect(cols12).toBe(cols14);
      expect(cols14).toBe(cols16);
    });
  });

  describe("transition points", () => {
    const wideWidth = MIN_TERMINAL_WIDTH_PX * 5;

    it("transitions from 2 to 3 columns at 6 terminals", () => {
      expect(getAutoGridCols(5, wideWidth)).toBe(2);
      expect(getAutoGridCols(6, wideWidth)).toBe(3);
    });

    it("transitions from 3 to 4 columns at 12 terminals", () => {
      expect(getAutoGridCols(11, wideWidth)).toBe(3);
      expect(getAutoGridCols(12, wideWidth)).toBe(4);
    });
  });
});

describe("getMaxGridCapacity", () => {
  // Account for gap (4px) and padding (8px) in calculations
  const gap = 4;
  const padding = 8;
  const cellWidth = MIN_TERMINAL_WIDTH_PX + gap;
  const cellHeight = MIN_TERMINAL_HEIGHT_PX + gap;

  describe("null dimensions", () => {
    it("returns absolute max when dimensions are null", () => {
      expect(getMaxGridCapacity(null, null)).toBe(ABSOLUTE_MAX_GRID_TERMINALS);
      expect(getMaxGridCapacity(1000, null)).toBe(ABSOLUTE_MAX_GRID_TERMINALS);
      expect(getMaxGridCapacity(null, 800)).toBe(ABSOLUTE_MAX_GRID_TERMINALS);
    });
  });

  describe("laptop screen (15-inch, ~1200x700)", () => {
    it("calculates 3x3 = 9 terminals for typical laptop viewport", () => {
      // Simulate a 15" laptop: ~1200px wide, ~700px tall usable grid area
      const width = 1200;
      const height = 700;
      const capacity = getMaxGridCapacity(width, height);

      // 1200px / 384px ≈ 3 cols, 700px / 204px ≈ 3 rows = 9 terminals
      expect(capacity).toBeGreaterThanOrEqual(6);
      expect(capacity).toBeLessThanOrEqual(9);
    });
  });

  describe("large monitor (32-inch, ~2200x1200)", () => {
    it("calculates larger capacity for 32-inch monitor", () => {
      // Simulate a 32" monitor: ~2200px wide, ~1200px tall usable grid area
      const width = 2200;
      const height = 1200;
      const capacity = getMaxGridCapacity(width, height);

      // Should be capped at ABSOLUTE_MAX_GRID_TERMINALS (16)
      expect(capacity).toBe(ABSOLUTE_MAX_GRID_TERMINALS);
    });
  });

  describe("respects absolute maximum", () => {
    it("never exceeds ABSOLUTE_MAX_GRID_TERMINALS even on huge screens", () => {
      expect(getMaxGridCapacity(5000, 3000)).toBe(ABSOLUTE_MAX_GRID_TERMINALS);
      expect(getMaxGridCapacity(10000, 5000)).toBe(ABSOLUTE_MAX_GRID_TERMINALS);
    });
  });

  describe("very small viewports", () => {
    it("returns at least 1 for any valid dimensions", () => {
      expect(getMaxGridCapacity(400, 250)).toBeGreaterThanOrEqual(1);
      expect(getMaxGridCapacity(MIN_TERMINAL_WIDTH_PX, MIN_TERMINAL_HEIGHT_PX)).toBe(1);
    });
  });
});
