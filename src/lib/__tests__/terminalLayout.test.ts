import { describe, it, expect } from "vitest";
import {
  getAutoGridCols,
  getGridFitMetrics,
  getMaxGridCapacity,
  computeGridColumns,
  MIN_TERMINAL_WIDTH_PX,
  MIN_TERMINAL_HEIGHT_PX,
  COMFORTABLE_PANEL_WIDTH_PX,
  AUTO_GRID_MAX_COLS,
  GRID_HYSTERESIS_BUFFER_PX,
  ABSOLUTE_MAX_GRID_TERMINALS,
  GRID_TRANSITION_DURATION_MS,
} from "../terminalLayout";

const C = COMFORTABLE_PANEL_WIDTH_PX; // size-driven denominator (480, #8859)

describe("getAutoGridCols", () => {
  describe("single terminal", () => {
    it("should return 1 for count of 0", () => {
      expect(getAutoGridCols(0, null)).toBe(1);
    });

    it("should return 1 for count of 1 regardless of width", () => {
      expect(getAutoGridCols(1, null)).toBe(1);
      expect(getAutoGridCols(1, 500)).toBe(1);
      expect(getAutoGridCols(1, 1000)).toBe(1);
      expect(getAutoGridCols(1, 5000)).toBe(1);
    });

    it("should handle negative counts defensively", () => {
      expect(getAutoGridCols(-1, null)).toBe(1);
      expect(getAutoGridCols(-10, null)).toBe(1);
    });
  });

  describe("size-driven column count (count never adds a column)", () => {
    // With many panels open, the column count is purely floor(width / C),
    // capped at AUTO_GRID_MAX_COLS. Panel count only limits via no-empty-columns.
    const many = 12;

    it("uses 1 column until two comfortable panels fit (2 × C)", () => {
      expect(getAutoGridCols(many, C)).toBe(1); // floor(480/480)=1
      expect(getAutoGridCols(many, 2 * C - 1)).toBe(1); // 959 → 1
    });

    it("widens to 2 columns at 2 × C", () => {
      expect(getAutoGridCols(many, 2 * C)).toBe(2); // 960 → 2
      expect(getAutoGridCols(many, 3 * C - 1)).toBe(2); // 1439 → 2
    });

    it("widens to 3 columns at 3 × C", () => {
      expect(getAutoGridCols(many, 3 * C)).toBe(3); // 1440 → 3
      expect(getAutoGridCols(many, 4 * C - 1)).toBe(3); // 1919 → 3
    });

    it("widens to 4 columns at 4 × C", () => {
      expect(getAutoGridCols(many, 4 * C)).toBe(4); // 1920 → 4
    });

    it("hard-caps at 4 columns regardless of width", () => {
      // Literal 4 (not AUTO_GRID_MAX_COLS) so a silent constant bump is caught —
      // the issue treats the 4-column ceiling as the at-a-glance limit (#8859).
      expect(getAutoGridCols(many, 5 * C)).toBe(4);
      expect(getAutoGridCols(many, 10 * C)).toBe(4);
      expect(getAutoGridCols(100, 99999)).toBe(4);
    });

    it("pins AUTO_GRID_MAX_COLS to the 4-column design contract", () => {
      expect(AUTO_GRID_MAX_COLS).toBe(4);
    });

    it('places the 1→2 column boundary at 960px (13" MacBook Air gets 2)', () => {
      // Literal pixels (not C) to verify the product-facing breakpoint directly.
      expect(getAutoGridCols(many, 959)).toBe(1);
      expect(getAutoGridCols(many, 960)).toBe(2);
    });

    it('keeps 13" MacBook Air-class widths on 2 columns (#8859)', () => {
      // Issue #8859: typical usable grid width on a 13" MBA with sidebars
      // visible is ~1100-1200px; that must stay at 2 columns, not collapse to 1.
      expect(getAutoGridCols(many, 1100)).toBe(2);
      expect(getAutoGridCols(many, 1200)).toBe(2);
    });

    it("is driven by width, not panel count, at a fixed width", () => {
      // Same width → same column count whether 3 panels or 50 are open.
      const wide = 3 * C; // fits 3 columns
      expect(getAutoGridCols(3, wide)).toBe(3);
      expect(getAutoGridCols(10, wide)).toBe(3);
      expect(getAutoGridCols(50, wide)).toBe(3);
    });
  });

  describe("no empty columns", () => {
    const wide = 4 * C; // fits 4 columns at the new cap

    it("never uses more columns than panels", () => {
      expect(getAutoGridCols(2, wide)).toBe(2); // capped by count, not the 4-col width fit
      expect(getAutoGridCols(3, wide)).toBe(3);
      expect(getAutoGridCols(4, wide)).toBe(4);
      expect(getAutoGridCols(6, wide)).toBe(4); // still capped at AUTO_GRID_MAX_COLS
    });
  });

  describe("fallback width", () => {
    it("uses the first-paint fallback (3-column band) when width is null", () => {
      // FALLBACK_GRID_WIDTH_PX (1680) lands in the 3-column band with C=480.
      expect(getAutoGridCols(4, null)).toBe(3);
      expect(getAutoGridCols(10, null)).toBe(3);
      expect(getAutoGridCols(2, null)).toBe(2); // capped by count
    });

    it("uses the fallback for non-positive transient widths", () => {
      expect(getAutoGridCols(4, 0)).toBe(3);
      expect(getAutoGridCols(4, -100)).toBe(3);
    });
  });

  describe("breakpoint hysteresis (width-driven Schmitt trigger)", () => {
    const many = 12;
    // 3→4 boundary: widen at 4×C (1920), narrow at 4×C − buffer.
    const fourColNarrow = 4 * C - GRID_HYSTERESIS_BUFFER_PX; // 1840
    // 2→3 boundary: widen at 3×C (1440), narrow at 3×C − buffer.
    const threeColNarrow = 3 * C - GRID_HYSTERESIS_BUFFER_PX; // 1360
    // 1→2 boundary: widen at 2×C (960), narrow at 2×C − buffer.
    const twoColNarrow = 2 * C - GRID_HYSTERESIS_BUFFER_PX; // 880

    it("holds 4 columns through the narrow buffer once widened", () => {
      // Natural width target is 3 cols here, but a sticky 4 holds above narrowAt.
      expect(getAutoGridCols(many, fourColNarrow, 4)).toBe(4);
      expect(getAutoGridCols(many, fourColNarrow + 10, 4)).toBe(4);
    });

    it("narrows from 4 to 3 columns once below the buffer", () => {
      expect(getAutoGridCols(many, fourColNarrow - 1, 4)).toBe(3);
    });

    it("holds 3 columns through the narrow buffer once widened", () => {
      // Natural width target is 2 cols here, but a sticky 3 holds above narrowAt.
      expect(getAutoGridCols(many, threeColNarrow, 3)).toBe(3);
      expect(getAutoGridCols(many, threeColNarrow + 10, 3)).toBe(3);
    });

    it("narrows from 3 to 2 columns once below the buffer", () => {
      expect(getAutoGridCols(many, threeColNarrow - 1, 3)).toBe(2);
    });

    it("holds 2 columns through the narrow buffer once widened", () => {
      expect(getAutoGridCols(many, twoColNarrow, 2)).toBe(2);
    });

    it("narrows from 2 to 1 column once below the buffer", () => {
      expect(getAutoGridCols(many, twoColNarrow - 1, 2)).toBe(1);
    });

    it("does not widen past the natural target when previousCols is smaller", () => {
      // prev=1 must not bias an upward widen — width drives that.
      expect(getAutoGridCols(many, 2 * C, 1)).toBe(2);
      expect(getAutoGridCols(many, 3 * C, 2)).toBe(3);
      expect(getAutoGridCols(many, 4 * C, 3)).toBe(4);
    });

    it("a narrowing viewport overrides a sticky wide count", () => {
      // Even with previousCols=4, a width that fits only 1 column wins.
      expect(getAutoGridCols(many, C - 1, 4)).toBe(1);
    });

    it("preserves pure width-driven behavior when previousCols is undefined", () => {
      expect(getAutoGridCols(many, fourColNarrow, undefined)).toBe(3);
      expect(getAutoGridCols(many, threeColNarrow, undefined)).toBe(2);
      expect(getAutoGridCols(many, twoColNarrow, undefined)).toBe(1);
    });

    it("respects no-empty-columns under a sticky prior", () => {
      // 2 panels cap at 2 cols even if a stale previousCols=4 leaks in.
      expect(getAutoGridCols(2, 4 * C, 4)).toBe(2);
    });

    it("holds a chained sequence through a staged narrowing drag", () => {
      // Simulate the per-render previousCols handoff as the window shrinks
      // across the 3→4 boundary: 1960 → 1860 → 1810.
      const at1960 = getAutoGridCols(many, 1960, 3); // widens to 4
      const at1860 = getAutoGridCols(many, 1860, at1960); // sticky 4 (≥1840)
      const at1810 = getAutoGridCols(many, 1810, at1860); // drops to 3 (<1840)
      expect(at1960).toBe(4);
      expect(at1860).toBe(4);
      expect(at1810).toBe(3);
    });
  });
});

describe("getGridFitMetrics", () => {
  it("returns null when dimensions are unknown", () => {
    expect(getGridFitMetrics(null, null)).toBeNull();
    expect(getGridFitMetrics(1000, null)).toBeNull();
    expect(getGridFitMetrics(null, 800)).toBeNull();
  });

  it("returns max cols, rows, and fit count for a known viewport", () => {
    // 1200×700: ~3 cols × ~3 rows = 9 panels fit before scrolling.
    const fit = getGridFitMetrics(1200, 700);
    expect(fit).not.toBeNull();
    expect(fit!.maxCols).toBeGreaterThanOrEqual(3);
    expect(fit!.maxRows).toBeGreaterThanOrEqual(3);
    expect(fit!.fitCount).toBe(fit!.maxCols * fit!.maxRows);
  });

  it("returns at least 1 col and 1 row even at the smallest valid viewport", () => {
    const fit = getGridFitMetrics(MIN_TERMINAL_WIDTH_PX, MIN_TERMINAL_HEIGHT_PX);
    expect(fit).not.toBeNull();
    expect(fit!.maxCols).toBe(1);
    expect(fit!.maxRows).toBe(1);
    expect(fit!.fitCount).toBe(1);
  });
});

describe("getMaxGridCapacity (legacy fit hint, no longer a hard cap)", () => {
  it("returns the ABSOLUTE_MAX_GRID_TERMINALS fallback when dimensions are unknown", () => {
    expect(getMaxGridCapacity(null, null)).toBe(ABSOLUTE_MAX_GRID_TERMINALS);
    expect(getMaxGridCapacity(1000, null)).toBe(ABSOLUTE_MAX_GRID_TERMINALS);
    expect(getMaxGridCapacity(null, 800)).toBe(ABSOLUTE_MAX_GRID_TERMINALS);
  });

  it("reports the on-screen panel fit for a typical laptop viewport", () => {
    const width = 1200;
    const height = 700;
    const capacity = getMaxGridCapacity(width, height);
    expect(capacity).toBeGreaterThanOrEqual(6);
    expect(capacity).toBeLessThanOrEqual(9);
  });

  it("scales past the legacy 16-panel cap on large monitors", () => {
    // 2200×1200 fits 5 cols × 5 rows = 25 on-screen panels — no longer clamped.
    expect(getMaxGridCapacity(2200, 1200)).toBeGreaterThan(ABSOLUTE_MAX_GRID_TERMINALS);
    expect(getMaxGridCapacity(5000, 3000)).toBeGreaterThan(ABSOLUTE_MAX_GRID_TERMINALS);
  });

  it("returns at least 1 for any valid dimensions", () => {
    expect(getMaxGridCapacity(400, 250)).toBeGreaterThanOrEqual(1);
    expect(getMaxGridCapacity(MIN_TERMINAL_WIDTH_PX, MIN_TERMINAL_HEIGHT_PX)).toBe(1);
  });
});

describe("grid transition timing constants", () => {
  it("GRID_TRANSITION_DURATION_MS is 200", () => {
    expect(GRID_TRANSITION_DURATION_MS).toBe(200);
  });
});

describe("computeGridColumns", () => {
  describe("2→3 panel transitions (regression test for issue #1754)", () => {
    const wide = 3 * C; // fits 3 columns

    it("keeps 2 and 3 panels at 2 columns when only 2 fit by count", () => {
      // 2 panels honor the side-by-side invariant; 3 panels follow the width
      // formula (3 cols fit at this width).
      expect(computeGridColumns(2, wide, "automatic")).toBe(2);
      expect(computeGridColumns(3, wide, "automatic")).toBe(3);
    });

    it("returns correct columns for 3 panels across strategies", () => {
      expect(computeGridColumns(3, wide, "automatic")).toBe(3);
      expect(computeGridColumns(3, wide, "fixed-columns", 2)).toBe(2);
      expect(computeGridColumns(3, wide, "fixed-columns", 3)).toBe(3);
      expect(computeGridColumns(3, wide, "fixed-rows", 1)).toBe(3);
      expect(computeGridColumns(3, wide, "fixed-rows", 2)).toBe(2);
    });

    it("handles transitions with varying widths", () => {
      const narrow = 1.5 * MIN_TERMINAL_WIDTH_PX; // 570 — below the 2-pane gate
      const twoFit = 2.2 * C; // ~1056 — fits 2 columns

      // Narrow: 2 panels stack (each would get < MIN_TERMINAL_WIDTH_PX side by side).
      expect(computeGridColumns(2, narrow, "automatic")).toBe(1);
      // Narrow: 3 panels also constrained to 1 column.
      expect(computeGridColumns(3, narrow, "automatic")).toBe(1);

      // Two columns fit: both 2 and 3 panels land on 2 columns.
      expect(computeGridColumns(2, twoFit, "automatic")).toBe(2);
      expect(computeGridColumns(3, twoFit, "automatic")).toBe(2);
    });

    it("uses the null-width fallback during transitions", () => {
      expect(computeGridColumns(2, null, "automatic")).toBe(2); // invariant
      expect(computeGridColumns(3, null, "automatic")).toBe(3); // fallback fits 3 cols
    });
  });

  describe("2-pane invariant (width-gated for automatic, unconditional for fixed)", () => {
    const sideBySideMin = MIN_TERMINAL_WIDTH_PX * 2; // 760 — two readable panes
    const wide = 3 * C;

    it("forces 2 columns for 2 automatic panes once both fit side by side", () => {
      expect(computeGridColumns(2, sideBySideMin, "automatic")).toBe(2);
      expect(computeGridColumns(2, sideBySideMin + 200, "automatic")).toBe(2);
      expect(computeGridColumns(2, wide, "automatic")).toBe(2);
      expect(computeGridColumns(2, null, "automatic")).toBe(2);
    });

    it("stacks 2 automatic panes when the window is too narrow for side by side", () => {
      // Key behavior change: a 300px window can't show 2 readable panes.
      expect(computeGridColumns(2, 300, "automatic")).toBe(1);
      expect(computeGridColumns(2, sideBySideMin - 1, "automatic")).toBe(1);
    });

    it("preserves the 2-column preference for transient non-positive widths", () => {
      // A 0/negative measurement mid-transition must not collapse 2 panes to 1.
      expect(computeGridColumns(2, 0, "automatic")).toBe(2);
      expect(computeGridColumns(2, -50, "automatic")).toBe(2);
    });

    it("keeps the unconditional 2x1 invariant for fixed strategies (unchanged)", () => {
      expect(computeGridColumns(2, 300, "fixed-rows", 3)).toBe(2);
      expect(computeGridColumns(2, 500, "fixed-rows", 3)).toBe(2);
      expect(computeGridColumns(2, wide, "fixed-rows", 1)).toBe(2);
      expect(computeGridColumns(2, wide, "fixed-rows", 10)).toBe(2);
      // Even when the user explicitly sets columns=1, 2 panes stay 2x1.
      expect(computeGridColumns(2, 300, "fixed-columns", 1)).toBe(2);
      expect(computeGridColumns(2, wide, "fixed-columns", 4)).toBe(2);
    });
  });

  describe("non-2-pane cases follow normal logic", () => {
    const wide = 3 * C;
    const narrow = 1.5 * MIN_TERMINAL_WIDTH_PX; // 570

    it("returns 1 column for 0 or 1 pane in automatic/fixed-rows mode", () => {
      expect(computeGridColumns(0, wide, "automatic")).toBe(1);
      expect(computeGridColumns(1, wide, "automatic")).toBe(1);
      expect(computeGridColumns(1, wide, "fixed-rows", 3)).toBe(1);
    });

    it("respects fixed-columns setting even for 1 pane", () => {
      expect(computeGridColumns(1, wide, "fixed-columns", 2)).toBe(2);
      expect(computeGridColumns(1, wide, "fixed-columns", 1)).toBe(1);
    });

    it("respects width constraints for 3+ panes in automatic mode", () => {
      expect(computeGridColumns(6, narrow, "automatic")).toBe(1);
      expect(computeGridColumns(6, wide, "automatic")).toBe(3);
    });

    it("uses fixed-columns value for 3+ panes", () => {
      expect(computeGridColumns(4, wide, "fixed-columns", 2)).toBe(2);
      expect(computeGridColumns(4, wide, "fixed-columns", 4)).toBe(4);
    });

    it("calculates columns from fixed-rows for 3+ panes", () => {
      expect(computeGridColumns(6, wide, "fixed-rows", 2)).toBe(3);
      expect(computeGridColumns(6, wide, "fixed-rows", 3)).toBe(2);
    });

    it("forwards previousCols to the automatic hysteresis path", () => {
      // 1360 = 3×C − buffer: a sticky 3 holds, a fresh measurement narrows to 2.
      expect(computeGridColumns(12, 1360, "automatic", undefined, 3)).toBe(3);
      expect(computeGridColumns(12, 1359, "automatic", undefined, 3)).toBe(2);
    });
  });

  describe("edge cases", () => {
    const wide = 3 * C;

    it("handles null width gracefully", () => {
      expect(computeGridColumns(4, null, "automatic")).toBe(3); // fallback fits 3
      expect(computeGridColumns(2, null, "automatic")).toBe(2); // invariant
    });

    it("clamps fixed-columns value to a valid range", () => {
      expect(computeGridColumns(4, wide, "fixed-columns", 0)).toBe(1);
      expect(computeGridColumns(4, wide, "fixed-columns", 15)).toBe(10);
    });

    it("clamps fixed-rows value to a valid range", () => {
      expect(computeGridColumns(4, wide, "fixed-rows", 0)).toBe(4);
      expect(computeGridColumns(4, wide, "fixed-rows", 15)).toBe(1);
    });

    it("handles 2 panes with a missing value parameter", () => {
      expect(computeGridColumns(2, wide, "fixed-rows")).toBe(2);
      expect(computeGridColumns(2, wide, "fixed-columns")).toBe(2);
    });

    it("handles 2 panes with invalid value parameters", () => {
      expect(computeGridColumns(2, wide, "fixed-rows", 0)).toBe(2);
      expect(computeGridColumns(2, wide, "fixed-columns", 0)).toBe(2);
    });

    it("handles non-even division for fixed-rows", () => {
      // 5 panes / 2 rows = ceil(2.5) = 3 columns
      expect(computeGridColumns(5, wide, "fixed-rows", 2)).toBe(3);
      // 7 panes / 3 rows = ceil(2.33) = 3 columns
      expect(computeGridColumns(7, wide, "fixed-rows", 3)).toBe(3);
    });
  });
});
