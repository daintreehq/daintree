import { describe, it, expect } from "vitest";
import {
  getAutoGridCols,
  computeAutomaticGridCols,
  computeGridColumns,
  applyHysteresis,
  computeScrollRowHeight,
  gridRowsOverflow,
  gridRowsOverflowWithHysteresis,
  gridRowOverflowHysteresisBuffer,
  GRID_ROW_OVERFLOW_HYSTERESIS_MULTIPLIER,
  getGridFitMetrics,
  getMaxGridCapacity,
  getPanelLayoutMode,
  pxForCols,
  pxForRows,
  maxFeasibleCols,
  DEFAULT_TERMINAL_METRICS,
  GRID_MIN_PANEL_COLS,
  GRID_MIN_PANEL_ROWS,
  ABSOLUTE_MIN_COLS,
  AUTO_GRID_MAX_COLS,
  GRID_GAP_PX,
  GRID_PADDING_PX,
  MIN_TERMINAL_WIDTH_PX,
  MIN_TERMINAL_HEIGHT_PX,
  ABSOLUTE_MAX_GRID_TERMINALS,
  GRID_TRANSITION_DURATION_MS,
  type TerminalMetrics,
} from "../terminalLayout";

// Exact container width at which `n` minimum-width panels fit across. Mirrors
// `maxFeasibleCols`' nth boundary — `wCols(n)` yields exactly n columns of
// feasibility, `wCols(n) - 1` yields n - 1. Derived from the engine's own
// metric model so the tests survive a metric tune.
const wCols = (n: number) =>
  pxForCols(GRID_MIN_PANEL_COLS) * n + GRID_GAP_PX * (n - 1) + GRID_PADDING_PX;

describe("getPanelLayoutMode", () => {
  it("routes 1 → single, 2 → split, 3+ → grid", () => {
    expect(getPanelLayoutMode(0)).toBe("single");
    expect(getPanelLayoutMode(1)).toBe("single");
    expect(getPanelLayoutMode(2)).toBe("split");
    expect(getPanelLayoutMode(3)).toBe("grid");
    expect(getPanelLayoutMode(12)).toBe("grid");
  });
});

describe("pxForCols / pxForRows — character-cell geometry", () => {
  it("derives panel size from cell geometry plus chrome", () => {
    const m = DEFAULT_TERMINAL_METRICS;
    expect(pxForCols(60)).toBe(
      Math.ceil(60 * m.cellWidth + m.paddingX + m.scrollbarWidth + m.borderX)
    );
    expect(pxForRows(16)).toBe(
      Math.ceil(16 * m.cellHeight + m.headerHeight + m.paddingY + m.borderY)
    );
    expect(pxForCols(120)).toBeGreaterThan(pxForCols(60));
  });

  it("honors custom measured metrics", () => {
    const wide: TerminalMetrics = { ...DEFAULT_TERMINAL_METRICS, cellWidth: 12 };
    expect(pxForCols(60, wide)).toBeGreaterThan(pxForCols(60));
  });
});

describe("maxFeasibleCols", () => {
  it("returns at least 1 for degenerate inputs", () => {
    expect(maxFeasibleCols(0, 532)).toBe(1);
    expect(maxFeasibleCols(532, 0)).toBe(1);
    expect(maxFeasibleCols(-100, 532)).toBe(1);
  });

  it("counts how many minimum-width panels fit, accounting for gaps", () => {
    const mpw = pxForCols(GRID_MIN_PANEL_COLS);
    expect(maxFeasibleCols(wCols(1), mpw)).toBe(1);
    expect(maxFeasibleCols(wCols(2), mpw)).toBe(2);
    expect(maxFeasibleCols(wCols(4), mpw)).toBe(4);
    expect(maxFeasibleCols(wCols(3) - 1, mpw)).toBe(2);
  });
});

describe("getAutoGridCols — size-driven, fit-as-many-across", () => {
  it("returns 1 for 0 or 1 panel, 2 for exactly 2 panels", () => {
    expect(getAutoGridCols(0, 5000)).toBe(1);
    expect(getAutoGridCols(1, 5000)).toBe(1);
    expect(getAutoGridCols(2, 300)).toBe(2);
    expect(getAutoGridCols(2, 5000)).toBe(2);
  });

  it("scales the column count with available width", () => {
    expect(getAutoGridCols(8, wCols(1))).toBe(1);
    expect(getAutoGridCols(8, wCols(2))).toBe(2);
    expect(getAutoGridCols(8, wCols(3))).toBe(3);
    expect(getAutoGridCols(8, wCols(4))).toBe(4);
  });

  it("gives a wide display 3-4 columns for a large fleet (not a 2-col rail)", () => {
    // The core fix: many panels on a big screen spread across 3-4 columns
    // instead of being pinned to 2.
    expect(getAutoGridCols(12, wCols(3))).toBe(3);
    expect(getAutoGridCols(12, wCols(4))).toBe(4);
    expect(getAutoGridCols(20, 6000)).toBe(4);
  });

  it("caps at the at-a-glance ceiling of 4 columns", () => {
    expect(getAutoGridCols(30, 100000)).toBe(AUTO_GRID_MAX_COLS);
    expect(AUTO_GRID_MAX_COLS).toBe(4);
  });

  it("never shows more columns than panels", () => {
    expect(getAutoGridCols(3, 100000)).toBe(3);
    expect(getAutoGridCols(2, 100000)).toBe(2);
  });

  it("packs a 3-panel row across only when three panels fit", () => {
    expect(getAutoGridCols(3, wCols(3))).toBe(3);
    expect(getAutoGridCols(3, wCols(3) - 1)).toBe(2);
    expect(getAutoGridCols(3, wCols(2) - 1)).toBe(1);
  });

  it("first paint (unknown width) assumes the count-justified shape fits", () => {
    expect(getAutoGridCols(2, null)).toBe(2);
    expect(getAutoGridCols(3, null)).toBe(3);
    expect(getAutoGridCols(12, null)).toBe(4);
  });

  it("compact density packs to a tighter floor", () => {
    // A width that fits 2 comfortable columns fits 3 compact ones.
    const width = pxForCols(ABSOLUTE_MIN_COLS) * 3 + GRID_GAP_PX * 2 + GRID_PADDING_PX;
    expect(getAutoGridCols(8, width)).toBeLessThan(3);
    expect(getAutoGridCols(8, width, undefined, { density: "compact" })).toBe(3);
  });

  describe("breakpoint hysteresis", () => {
    it("holds the wider column count through the narrow buffer", () => {
      const fresh = getAutoGridCols(8, wCols(3) - 1, undefined);
      const held = getAutoGridCols(8, wCols(3) - 1, 3);
      expect(fresh).toBe(2);
      expect(held).toBe(3);
    });

    it("narrows once the container drops well past the threshold", () => {
      expect(getAutoGridCols(8, wCols(2), 3)).toBe(2);
    });

    it("a narrowing viewport overrides a stale wide previousCols", () => {
      expect(getAutoGridCols(8, wCols(1), 4)).toBe(1);
    });
  });
});

describe("computeAutomaticGridCols — explicit options form", () => {
  it("matches getAutoGridCols for the comfortable default", () => {
    expect(computeAutomaticGridCols({ count: 12, width: wCols(4) })).toBe(4);
  });

  it("respects custom metrics — wider cells fit fewer columns", () => {
    const wideCells: TerminalMetrics = { ...DEFAULT_TERMINAL_METRICS, cellWidth: 16 };
    expect(
      computeAutomaticGridCols({ count: 8, width: wCols(4), metrics: wideCells })
    ).toBeLessThan(4);
  });
});

describe("applyHysteresis", () => {
  it("passes the target through without a previous count", () => {
    expect(applyHysteresis(2, undefined, 1500, 532, 4)).toBe(2);
  });

  it("never lowers a count that already grew", () => {
    expect(applyHysteresis(3, 2, 1500, 532, 4)).toBe(3);
  });

  it("caps a held count by the count-justified ceiling", () => {
    expect(applyHysteresis(2, 4, 100000, 532, 2)).toBe(2);
  });
});

describe("gridRowsOverflow — the only thing that triggers scroll mode", () => {
  it("never overflows for a single row", () => {
    expect(gridRowsOverflow(1, 100)).toBe(false);
    expect(gridRowsOverflow(0, 100)).toBe(false);
  });

  it("does not overflow when unknown height", () => {
    expect(gridRowsOverflow(8, null)).toBe(false);
  });

  it("overflows only once minimum-height rows exceed the viewport", () => {
    const minRow = pxForRows(GRID_MIN_PANEL_ROWS);
    const threeRows = 3 * minRow + 2 * GRID_GAP_PX + GRID_PADDING_PX;
    expect(gridRowsOverflow(3, threeRows)).toBe(false);
    expect(gridRowsOverflow(3, threeRows - 1)).toBe(true);
  });

  it("fits many rows on a tall display before scrolling", () => {
    // A tall display packs several rows in — panel count alone never scrolls.
    expect(gridRowsOverflow(4, 1600)).toBe(false);
    expect(gridRowsOverflow(2, 700)).toBe(false);
  });
});

describe("gridRowsOverflowWithHysteresis — scroll-mode Schmitt trigger (#10871)", () => {
  // Height at which exactly `n` minimum-height rows stop fitting. `hRows(n)` is
  // the entry threshold; a container shorter than it overflows. Derived from the
  // engine's own metric model so the test survives a metric tune.
  const hRows = (n: number) =>
    n * pxForRows(GRID_MIN_PANEL_ROWS) + (n - 1) * GRID_GAP_PX + GRID_PADDING_PX;

  it("never overflows for a single row, regardless of previous state", () => {
    expect(gridRowsOverflowWithHysteresis(1, 100, true)).toBe(false);
    expect(gridRowsOverflowWithHysteresis(0, 100, false)).toBe(false);
  });

  it("does not overflow when height is unknown", () => {
    expect(gridRowsOverflowWithHysteresis(8, null, true)).toBe(false);
  });

  it("enters scroll mode on the bare threshold when not already scrolling", () => {
    const needed = hRows(3);
    // previous = undefined (first paint) and previous = false behave identically
    // to the bare threshold on the way *in* — the mode is never sticky to enter.
    expect(gridRowsOverflowWithHysteresis(3, needed, undefined)).toBe(false);
    expect(gridRowsOverflowWithHysteresis(3, needed - 1, undefined)).toBe(true);
    expect(gridRowsOverflowWithHysteresis(3, needed, false)).toBe(false);
    expect(gridRowsOverflowWithHysteresis(3, needed - 1, false)).toBe(true);
  });

  it("holds scroll mode until the container grows a full buffer past entry (dead band)", () => {
    const needed = hRows(3);
    const buffer = gridRowOverflowHysteresisBuffer();
    // Just inside the band: was scrolling, container grew a little — still holds.
    expect(gridRowsOverflowWithHysteresis(3, needed + buffer - 1, true)).toBe(true);
    // Past the band: releases.
    expect(gridRowsOverflowWithHysteresis(3, needed + buffer + 1, true)).toBe(false);
    // The invariant the fix guarantees: exit height (H_off) > entry height
    // (H_on) — a real dead band, not a knife-edge.
    const H_on = needed; // enters just below this
    const H_off = needed + buffer; // exits just above this
    expect(H_off).toBeGreaterThan(H_on);
    expect(buffer).toBeGreaterThan(0);
  });

  it("swallows content-box/border-box measurement jitter at the boundary", () => {
    // The RO callback and the initial/remeasure paths could disagree by the
    // vertical padding term right at the boundary. A few-px disagreement must
    // NOT drop the grid out of scroll mode on its own.
    const needed = hRows(3);
    const jitter = GRID_PADDING_PX;
    expect(gridRowsOverflowWithHysteresis(3, needed + jitter, true)).toBe(true);
    // The buffer dominates that jitter by a wide margin.
    expect(gridRowOverflowHysteresisBuffer()).toBeGreaterThan(jitter * 4);
  });

  it("stays in scroll mode when the container is smaller than the buffer", () => {
    // Regression guard for the inline exit math: reusing `gridRowsOverflow` on
    // `containerHeight - buffer` would hit its `<= 0` guard and wrongly report
    // "no overflow" for a tiny container. A tiny container must stay scrolling.
    const buffer = gridRowOverflowHysteresisBuffer();
    expect(gridRowsOverflowWithHysteresis(3, 50, true)).toBe(true);
    expect(gridRowsOverflowWithHysteresis(3, Math.floor(buffer / 2), true)).toBe(true);
  });

  it("documents the pre-fix bug: the bare threshold has no dead band", () => {
    // The un-hysteretic `gridRowsOverflow` this fix supersedes flips at the SAME
    // height in both directions (no previous-state memory) — H_on === H_off,
    // the oscillation source. At a height inside the fixed function's dead band,
    // the bare threshold has already released while the fixed one still holds.
    const needed = hRows(3);
    const holdHeight = needed + gridRowOverflowHysteresisBuffer() - 1;
    expect(gridRowsOverflow(3, holdHeight)).toBe(false); // bare: released (bug)
    expect(gridRowsOverflowWithHysteresis(3, holdHeight, true)).toBe(true); // fixed: held
  });
});

describe("gridRowOverflowHysteresisBuffer", () => {
  it("scales with measured cell metrics and stays a generous multiple of one row", () => {
    const buffer = gridRowOverflowHysteresisBuffer();
    const oneRow = pxForRows(GRID_MIN_PANEL_ROWS);
    expect(buffer).toBe(Math.ceil(oneRow * GRID_ROW_OVERFLOW_HYSTERESIS_MULTIPLIER));
    expect(buffer).toBeGreaterThan(oneRow); // multiplier > 1 → dead band exceeds a row

    // A denser (smaller cell) metric set yields a proportionally smaller buffer,
    // proving it tracks the metrics rather than being a fixed pixel band.
    const dense: TerminalMetrics = { ...DEFAULT_TERMINAL_METRICS, cellHeight: 12 };
    expect(gridRowOverflowHysteresisBuffer(dense)).toBeLessThan(buffer);
  });
});

describe("computeScrollRowHeight — packed, viewport-only", () => {
  it("falls back to the minimum row height when height is unknown", () => {
    expect(computeScrollRowHeight(null)).toBe(pxForRows(GRID_MIN_PANEL_ROWS));
  });

  it("never goes below the minimum row height", () => {
    for (const h of [300, 700, 1200, 2400]) {
      expect(computeScrollRowHeight(h)).toBeGreaterThanOrEqual(pxForRows(GRID_MIN_PANEL_ROWS));
    }
  });

  it("stays packed — a scroll row is never more than twice the minimum", () => {
    for (const h of [300, 700, 1200, 2400]) {
      expect(computeScrollRowHeight(h)).toBeLessThanOrEqual(2 * pxForRows(GRID_MIN_PANEL_ROWS));
    }
  });

  it("divides the viewport across the rows it can hold", () => {
    const minRow = pxForRows(GRID_MIN_PANEL_ROWS);
    const height = 1200;
    const rh = computeScrollRowHeight(height);
    const visible = Math.floor((height - GRID_PADDING_PX + GRID_GAP_PX) / (minRow + GRID_GAP_PX));
    expect(visible * rh + (visible - 1) * GRID_GAP_PX).toBeLessThanOrEqual(height);
  });
});

describe("computeGridColumns — strategy dispatch", () => {
  it("returns 1 for an empty grid", () => {
    expect(computeGridColumns(0, wCols(3), "automatic")).toBe(1);
  });

  it("keeps the 2-pane invariant across every strategy", () => {
    expect(computeGridColumns(2, null, "automatic")).toBe(2);
    expect(computeGridColumns(2, 300, "automatic")).toBe(2);
    expect(computeGridColumns(2, wCols(4), "automatic")).toBe(2);
    expect(computeGridColumns(2, 300, "fixed-rows", 3)).toBe(2);
    expect(computeGridColumns(2, 300, "fixed-columns", 1)).toBe(2);
  });

  it("uses the size-driven automatic engine for 3+ panels", () => {
    expect(computeGridColumns(12, wCols(4), "automatic")).toBe(4);
    expect(computeGridColumns(12, wCols(2), "automatic")).toBe(2);
  });

  it("honors the fixed-columns strategy", () => {
    expect(computeGridColumns(8, wCols(4), "fixed-columns", 3)).toBe(3);
    expect(computeGridColumns(8, wCols(4), "fixed-columns", 0)).toBe(1);
    expect(computeGridColumns(8, wCols(4), "fixed-columns", 15)).toBe(10);
  });

  it("derives columns from the fixed-rows strategy", () => {
    expect(computeGridColumns(6, wCols(4), "fixed-rows", 2)).toBe(3);
    expect(computeGridColumns(6, wCols(4), "fixed-rows", 3)).toBe(2);
  });

  it("forwards previousCols into the automatic hysteresis path", () => {
    expect(computeGridColumns(8, wCols(3) - 1, "automatic", undefined, 3)).toBe(3);
    expect(computeGridColumns(8, wCols(3) - 1, "automatic", undefined, undefined)).toBe(2);
  });
});

describe("getGridFitMetrics / getMaxGridCapacity", () => {
  it("returns null when dimensions are unknown", () => {
    expect(getGridFitMetrics(null, null)).toBeNull();
  });

  it("returns max cols, rows, and fit count for a known viewport", () => {
    const fit = getGridFitMetrics(1200, 700);
    expect(fit).not.toBeNull();
    expect(fit!.fitCount).toBe(fit!.maxCols * fit!.maxRows);
  });

  it("returns at least 1 col and 1 row at the smallest valid viewport", () => {
    const fit = getGridFitMetrics(MIN_TERMINAL_WIDTH_PX, MIN_TERMINAL_HEIGHT_PX);
    expect(fit!.maxCols).toBe(1);
    expect(fit!.maxRows).toBe(1);
  });

  it("falls back to the legacy constant when dimensions are unknown", () => {
    expect(getMaxGridCapacity(null, null)).toBe(ABSOLUTE_MAX_GRID_TERMINALS);
  });
});

describe("layout constants", () => {
  it("keeps the panel minimums reasonably small", () => {
    expect(GRID_MIN_PANEL_COLS).toBeLessThan(80);
    expect(GRID_MIN_PANEL_COLS).toBeGreaterThanOrEqual(ABSOLUTE_MIN_COLS);
    expect(GRID_MIN_PANEL_ROWS).toBeLessThan(24);
  });

  it("pins the at-a-glance ceiling and transition timing", () => {
    expect(AUTO_GRID_MAX_COLS).toBe(4);
    expect(GRID_TRANSITION_DURATION_MS).toBe(200);
  });
});
