import { describe, it, expect } from "vitest";
import {
  getAutoGridCols,
  getGridFitMetrics,
  getMaxGridCapacity,
  computeGridColumns,
  computeAutomaticGridCols,
  applyHysteresis,
  computeScrollRowHeight,
  desiredAutoCols,
  getPanelLayoutMode,
  pxForCols,
  pxForRows,
  maxFeasibleCols,
  DEFAULT_TERMINAL_METRICS,
  MIN_TERMINAL_WIDTH_PX,
  MIN_TERMINAL_HEIGHT_PX,
  READABLE_GRID_MIN_COLS,
  COMPACT_GRID_MIN_COLS,
  ABSOLUTE_MIN_COLS,
  AGENT_WIDE_COLS,
  MAX_USEFUL_COLS,
  READABLE_MIN_ROWS,
  TARGET_GRID_ROWS,
  MAX_SCROLL_ROWS,
  AUTO_GRID_MAX_COLS,
  GRID_GAP_PX,
  GRID_PADDING_PX,
  ABSOLUTE_MAX_GRID_TERMINALS,
  GRID_TRANSITION_DURATION_MS,
  type TerminalMetrics,
} from "../terminalLayout";

// Exact container width at which `n` readable comfortable (80-col) panels fit.
// Mirrors `maxFeasibleCols`' nth boundary: `wCols(n)` yields exactly n columns
// of feasibility and `wCols(n) - 1` yields n - 1. Derived from the engine's own
// metric model so the tests stay correct if the metrics are tuned.
const wCols = (n: number) =>
  pxForCols(READABLE_GRID_MIN_COLS) * n + GRID_GAP_PX * (n - 1) + GRID_PADDING_PX;

// Same, for compact density (64-col floor).
const wColsCompact = (n: number) =>
  pxForCols(COMPACT_GRID_MIN_COLS) * n + GRID_GAP_PX * (n - 1) + GRID_PADDING_PX;

describe("desiredAutoCols — count-driven progression", () => {
  it("steps 1 → 2 → 3 then settles at 2 for 4+", () => {
    expect(desiredAutoCols(0)).toBe(1);
    expect(desiredAutoCols(1)).toBe(1);
    expect(desiredAutoCols(2)).toBe(2);
    expect(desiredAutoCols(3)).toBe(3);
    expect(desiredAutoCols(4)).toBe(2);
    expect(desiredAutoCols(5)).toBe(2);
    expect(desiredAutoCols(20)).toBe(2);
  });

  it("treats negative counts as a single panel", () => {
    expect(desiredAutoCols(-1)).toBe(1);
  });
});

describe("getPanelLayoutMode", () => {
  it("routes 1 → single, 2 → split, 3+ → grid", () => {
    expect(getPanelLayoutMode(0)).toBe("single");
    expect(getPanelLayoutMode(1)).toBe("single");
    expect(getPanelLayoutMode(2)).toBe("split");
    expect(getPanelLayoutMode(3)).toBe("grid");
    expect(getPanelLayoutMode(9)).toBe("grid");
  });
});

describe("pxForCols / pxForRows — character-cell geometry", () => {
  it("derives panel width from cell width plus chrome", () => {
    const m = DEFAULT_TERMINAL_METRICS;
    expect(pxForCols(80)).toBe(
      Math.ceil(80 * m.cellWidth + m.paddingX + m.scrollbarWidth + m.borderX)
    );
    // More columns is always wider.
    expect(pxForCols(120)).toBeGreaterThan(pxForCols(80));
    expect(pxForCols(80)).toBeGreaterThan(pxForCols(50));
  });

  it("derives panel height from cell height plus header and chrome", () => {
    const m = DEFAULT_TERMINAL_METRICS;
    expect(pxForRows(24)).toBe(
      Math.ceil(24 * m.cellHeight + m.headerHeight + m.paddingY + m.borderY)
    );
    expect(pxForRows(40)).toBeGreaterThan(pxForRows(24));
  });

  it("honors custom measured metrics", () => {
    const wide: TerminalMetrics = { ...DEFAULT_TERMINAL_METRICS, cellWidth: 12 };
    expect(pxForCols(80, wide)).toBeGreaterThan(pxForCols(80));
  });
});

describe("maxFeasibleCols", () => {
  it("returns at least 1 even for degenerate inputs", () => {
    expect(maxFeasibleCols(0, 700)).toBe(1);
    expect(maxFeasibleCols(700, 0)).toBe(1);
    expect(maxFeasibleCols(-100, 700)).toBe(1);
  });

  it("counts how many minimum-width panels fit, accounting for gaps", () => {
    const mpw = pxForCols(READABLE_GRID_MIN_COLS);
    expect(maxFeasibleCols(wCols(1), mpw)).toBe(1);
    expect(maxFeasibleCols(wCols(2), mpw)).toBe(2);
    expect(maxFeasibleCols(wCols(3), mpw)).toBe(3);
    expect(maxFeasibleCols(wCols(3) - 1, mpw)).toBe(2);
  });
});

describe("getAutoGridCols — count-driven feel inside a readability envelope", () => {
  describe("single / zero panels", () => {
    it("returns 1 for 0 or 1 panel regardless of width", () => {
      expect(getAutoGridCols(0, null)).toBe(1);
      expect(getAutoGridCols(1, null)).toBe(1);
      expect(getAutoGridCols(1, 5000)).toBe(1);
      expect(getAutoGridCols(-3, 5000)).toBe(1);
    });
  });

  describe("two panels", () => {
    it("always reports 2 columns (the split layout handles narrow windows)", () => {
      expect(getAutoGridCols(2, null)).toBe(2);
      expect(getAutoGridCols(2, 300)).toBe(2);
      expect(getAutoGridCols(2, 5000)).toBe(2);
    });
  });

  describe("three panels — three-across only when readable", () => {
    it("renders three columns once three readable panels fit", () => {
      expect(getAutoGridCols(3, wCols(3))).toBe(3);
      expect(getAutoGridCols(3, wCols(3) + 500)).toBe(3);
    });

    it("falls back to two columns when three do not fit", () => {
      expect(getAutoGridCols(3, wCols(3) - 1)).toBe(2);
      expect(getAutoGridCols(3, wCols(2))).toBe(2);
    });

    it("falls back to one column on a genuinely small container", () => {
      expect(getAutoGridCols(3, wCols(2) - 1)).toBe(1);
    });
  });

  describe("four-plus panels — the two-column monitoring rail", () => {
    it("settles at two columns and never sprawls wider, however wide the screen", () => {
      expect(getAutoGridCols(4, wCols(2))).toBe(2);
      expect(getAutoGridCols(4, wCols(3))).toBe(2);
      expect(getAutoGridCols(4, wCols(4))).toBe(2);
      expect(getAutoGridCols(8, 6000)).toBe(2);
      expect(getAutoGridCols(20, 9999)).toBe(2);
    });

    it("drops to one column when two readable panels do not fit", () => {
      expect(getAutoGridCols(6, wCols(2) - 1)).toBe(1);
    });

    it("never reports four columns from the automatic engine", () => {
      // Direct regression guard for the 4-column sprawl (#8859 over-correction).
      for (const count of [4, 5, 8, 12, 30]) {
        expect(getAutoGridCols(count, 100000)).toBeLessThanOrEqual(2);
      }
    });
  });

  describe("first paint (width unknown)", () => {
    it("lands on the predictable count-driven shape immediately", () => {
      expect(getAutoGridCols(2, null)).toBe(2);
      expect(getAutoGridCols(3, null)).toBe(3);
      expect(getAutoGridCols(4, null)).toBe(2);
      expect(getAutoGridCols(8, null)).toBe(2);
    });

    it("treats transient non-positive widths as unknown", () => {
      expect(getAutoGridCols(3, 0)).toBe(3);
      expect(getAutoGridCols(3, -100)).toBe(3);
    });
  });

  describe("compact density (opt-in)", () => {
    it("widens a 4+ grid to three columns on a wide container", () => {
      expect(getAutoGridCols(4, wColsCompact(3), undefined, { density: "compact" })).toBe(3);
      expect(getAutoGridCols(8, wColsCompact(3), undefined, { density: "compact" })).toBe(3);
    });

    it("still falls back to two columns when three compact panels do not fit", () => {
      expect(getAutoGridCols(4, wColsCompact(3) - 1, undefined, { density: "compact" })).toBe(2);
    });

    it("comfortable density keeps 4+ at two columns at the same width", () => {
      expect(getAutoGridCols(4, wColsCompact(3))).toBe(2);
    });
  });

  describe("breakpoint hysteresis (width-driven Schmitt trigger)", () => {
    it("holds the wider column count through the narrow buffer", () => {
      // At a width that freshly computes 2 columns, a sticky previous 3 holds.
      const held = getAutoGridCols(3, wCols(3) - 1, 3);
      const fresh = getAutoGridCols(3, wCols(3) - 1, undefined);
      expect(fresh).toBe(2);
      expect(held).toBe(3);
    });

    it("narrows once the container drops well past the threshold", () => {
      // Far below the 3-column threshold: hysteresis cannot hold 3.
      expect(getAutoGridCols(3, wCols(2), 3)).toBe(2);
    });

    it("never widens past the natural target when previousCols is smaller", () => {
      expect(getAutoGridCols(3, wCols(3), 1)).toBe(3);
      expect(getAutoGridCols(4, wCols(4), 1)).toBe(2);
    });

    it("does not smooth a column drop caused by opening more panels", () => {
      // Going from 3 panels (3 cols) to 4 panels must drop to 2 immediately —
      // count changes are predictable, only width changes are smoothed.
      expect(getAutoGridCols(4, wCols(4), 3)).toBe(2);
    });

    it("a narrowing viewport overrides a stale wide previousCols", () => {
      // Far below even the two-column threshold: hysteresis cannot rescue a
      // stale previous count of 3.
      expect(getAutoGridCols(6, wCols(1), 3)).toBe(1);
    });
  });
});

describe("applyHysteresis", () => {
  it("passes the target through untouched without a previous count", () => {
    expect(applyHysteresis(2, undefined, 1500, 700, 3)).toBe(2);
  });

  it("never lowers a count that already grew", () => {
    expect(applyHysteresis(3, 2, 1500, 700, 3)).toBe(3);
  });

  it("caps a held count by the count-justified ceiling", () => {
    // previous=3 but only 2 columns are count-justified now → cannot hold 3.
    expect(applyHysteresis(2, 3, 100000, 700, 2)).toBe(2);
  });
});

describe("computeScrollRowHeight", () => {
  it("targets the comfortable row height when container height is unknown", () => {
    expect(computeScrollRowHeight(null)).toBe(pxForRows(TARGET_GRID_ROWS));
  });

  it("stays within the readable row-height tiers", () => {
    for (const h of [400, 900, 1500, 3000]) {
      const rh = computeScrollRowHeight(h);
      expect(rh).toBeGreaterThanOrEqual(pxForRows(READABLE_MIN_ROWS));
      expect(rh).toBeLessThanOrEqual(pxForRows(MAX_SCROLL_ROWS));
    }
  });

  it("caps at the max row height on very tall containers", () => {
    expect(computeScrollRowHeight(4000)).toBe(pxForRows(MAX_SCROLL_ROWS));
  });

  it("grows the row height as the container gets taller (two rows + peek)", () => {
    expect(computeScrollRowHeight(1700)).toBeGreaterThan(computeScrollRowHeight(900));
  });
});

describe("computeAutomaticGridCols (explicit options form)", () => {
  it("matches getAutoGridCols for the comfortable default", () => {
    expect(computeAutomaticGridCols({ count: 3, width: wCols(3) })).toBe(3);
    expect(computeAutomaticGridCols({ count: 4, width: wCols(4) })).toBe(2);
  });

  it("respects custom metrics — wider cells need more room for three across", () => {
    const wideCells: TerminalMetrics = { ...DEFAULT_TERMINAL_METRICS, cellWidth: 14 };
    const narrowCells: TerminalMetrics = { ...DEFAULT_TERMINAL_METRICS, cellWidth: 6 };
    const width = wCols(3);
    expect(computeAutomaticGridCols({ count: 3, width, metrics: narrowCells })).toBe(3);
    expect(computeAutomaticGridCols({ count: 3, width, metrics: wideCells })).toBeLessThan(3);
  });
});

describe("computeGridColumns — strategy dispatch", () => {
  it("returns 1 for an empty grid", () => {
    expect(computeGridColumns(0, wCols(3), "automatic")).toBe(1);
  });

  it("keeps the 2-pane invariant across every strategy", () => {
    expect(computeGridColumns(2, null, "automatic")).toBe(2);
    expect(computeGridColumns(2, 300, "automatic")).toBe(2);
    expect(computeGridColumns(2, wCols(3), "automatic")).toBe(2);
    expect(computeGridColumns(2, 300, "fixed-rows", 3)).toBe(2);
    expect(computeGridColumns(2, 300, "fixed-columns", 1)).toBe(2);
  });

  it("uses the count-driven automatic engine for 3+ panels", () => {
    expect(computeGridColumns(3, wCols(3), "automatic")).toBe(3);
    expect(computeGridColumns(3, wCols(2), "automatic")).toBe(2);
    expect(computeGridColumns(6, wCols(4), "automatic")).toBe(2);
  });

  it("honors the fixed-columns strategy", () => {
    expect(computeGridColumns(4, wCols(4), "fixed-columns", 3)).toBe(3);
    expect(computeGridColumns(4, wCols(4), "fixed-columns", 0)).toBe(1);
    expect(computeGridColumns(4, wCols(4), "fixed-columns", 15)).toBe(10);
  });

  it("derives columns from the fixed-rows strategy", () => {
    expect(computeGridColumns(6, wCols(4), "fixed-rows", 2)).toBe(3);
    expect(computeGridColumns(6, wCols(4), "fixed-rows", 3)).toBe(2);
    expect(computeGridColumns(5, wCols(4), "fixed-rows", 2)).toBe(3);
    expect(computeGridColumns(4, wCols(4), "fixed-rows", 0)).toBe(4);
    expect(computeGridColumns(4, wCols(4), "fixed-rows", 15)).toBe(1);
  });

  it("forwards previousCols into the automatic hysteresis path", () => {
    expect(computeGridColumns(3, wCols(3) - 1, "automatic", undefined, 3)).toBe(3);
    expect(computeGridColumns(3, wCols(3) - 1, "automatic", undefined, undefined)).toBe(2);
  });
});

describe("getGridFitMetrics", () => {
  it("returns null when dimensions are unknown", () => {
    expect(getGridFitMetrics(null, null)).toBeNull();
    expect(getGridFitMetrics(1000, null)).toBeNull();
    expect(getGridFitMetrics(null, 800)).toBeNull();
  });

  it("returns max cols, rows, and fit count for a known viewport", () => {
    const fit = getGridFitMetrics(1200, 700);
    expect(fit).not.toBeNull();
    expect(fit!.maxCols).toBeGreaterThanOrEqual(3);
    expect(fit!.maxRows).toBeGreaterThanOrEqual(3);
    expect(fit!.fitCount).toBe(fit!.maxCols * fit!.maxRows);
  });

  it("returns at least 1 col and 1 row at the smallest valid viewport", () => {
    const fit = getGridFitMetrics(MIN_TERMINAL_WIDTH_PX, MIN_TERMINAL_HEIGHT_PX);
    expect(fit).not.toBeNull();
    expect(fit!.maxCols).toBe(1);
    expect(fit!.maxRows).toBe(1);
  });
});

describe("getMaxGridCapacity", () => {
  it("returns the legacy fallback when dimensions are unknown", () => {
    expect(getMaxGridCapacity(null, null)).toBe(ABSOLUTE_MAX_GRID_TERMINALS);
  });

  it("reports the on-screen panel fit for a typical laptop viewport", () => {
    const capacity = getMaxGridCapacity(1200, 700);
    expect(capacity).toBeGreaterThanOrEqual(6);
    expect(capacity).toBeLessThanOrEqual(9);
  });
});

describe("layout constants", () => {
  it("orders the column-width tiers", () => {
    expect(ABSOLUTE_MIN_COLS).toBeLessThan(COMPACT_GRID_MIN_COLS);
    expect(COMPACT_GRID_MIN_COLS).toBeLessThan(READABLE_GRID_MIN_COLS);
    expect(READABLE_GRID_MIN_COLS).toBeLessThan(AGENT_WIDE_COLS);
    expect(AGENT_WIDE_COLS).toBeLessThan(MAX_USEFUL_COLS);
  });

  it("orders the row-height tiers", () => {
    expect(READABLE_MIN_ROWS).toBeLessThan(TARGET_GRID_ROWS);
    expect(TARGET_GRID_ROWS).toBeLessThan(MAX_SCROLL_ROWS);
  });

  it("pins the at-a-glance ceiling and transition timing", () => {
    expect(AUTO_GRID_MAX_COLS).toBe(4);
    expect(GRID_TRANSITION_DURATION_MS).toBe(200);
    expect(GRID_PADDING_PX).toBeGreaterThan(0);
  });
});
