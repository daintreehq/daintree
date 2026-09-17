import { describe, it, expect } from "vitest";
import {
  isPlausibleTerminalGeometry,
  isValidTerminalGeometry,
  MAX_TERMINAL_GRID_DIMENSION,
  MIN_PLAUSIBLE_TERMINAL_COLS,
  MIN_PLAUSIBLE_TERMINAL_ROWS,
} from "../terminal.js";

/**
 * The two predicates answer different questions and the gap between them is
 * where #12442 lived: a hidden pane's zero-size box divides to FitAddon's 2x1
 * floor, which is a grid a terminal can be resized to (so structurally valid)
 * and a grid no pane was ever showing (so implausible).
 */
describe("isPlausibleTerminalGeometry", () => {
  it("refuses the floor grid a zero-size container produces, which is structurally valid", () => {
    // Both halves asserted together: the point is the DISAGREEMENT, and a test
    // that only checked the refusal would still pass if the structural gate had
    // quietly been tightened instead — which would change what snapshot decoding
    // and xterm-level code accept.
    expect(isValidTerminalGeometry({ cols: 2, rows: 1 })).toBe(true);
    expect(isPlausibleTerminalGeometry({ cols: 2, rows: 1 })).toBe(false);
  });

  it("refuses the 3-column grid the reporter reproduced the corruption at", () => {
    expect(isPlausibleTerminalGeometry({ cols: 3, rows: 90 })).toBe(false);
  });

  it("refuses a grid that clears one floor but not the other", () => {
    expect(isPlausibleTerminalGeometry({ cols: 200, rows: 1 })).toBe(false);
    expect(isPlausibleTerminalGeometry({ cols: 2, rows: 90 })).toBe(false);
  });

  it("accepts the floor itself and everything above it", () => {
    expect(
      isPlausibleTerminalGeometry({
        cols: MIN_PLAUSIBLE_TERMINAL_COLS,
        rows: MIN_PLAUSIBLE_TERMINAL_ROWS,
      })
    ).toBe(true);
    expect(isPlausibleTerminalGeometry({ cols: 80, rows: 24 })).toBe(true);
    expect(isPlausibleTerminalGeometry({ cols: 302, rows: 90 })).toBe(true);
  });

  it("refuses one cell under the floor on either axis", () => {
    expect(
      isPlausibleTerminalGeometry({
        cols: MIN_PLAUSIBLE_TERMINAL_COLS - 1,
        rows: MIN_PLAUSIBLE_TERMINAL_ROWS,
      })
    ).toBe(false);
    expect(
      isPlausibleTerminalGeometry({
        cols: MIN_PLAUSIBLE_TERMINAL_COLS,
        rows: MIN_PLAUSIBLE_TERMINAL_ROWS - 1,
      })
    ).toBe(false);
  });

  it("inherits every structural rejection rather than restating them", () => {
    // Non-finite is the one that mattered: `normalizeTerminalGridDimension`
    // maps NaN to 1, so a comparison-based floor would have let it through.
    expect(isPlausibleTerminalGeometry({ cols: NaN, rows: NaN })).toBe(false);
    expect(isPlausibleTerminalGeometry({ cols: Infinity, rows: Infinity })).toBe(false);
    expect(isPlausibleTerminalGeometry({ cols: 80.5, rows: 24 })).toBe(false);
    expect(isPlausibleTerminalGeometry({ cols: -80, rows: -24 })).toBe(false);
    expect(
      isPlausibleTerminalGeometry({
        cols: MAX_TERMINAL_GRID_DIMENSION + 1,
        rows: 24,
      })
    ).toBe(false);
    expect(isPlausibleTerminalGeometry(null)).toBe(false);
    expect(isPlausibleTerminalGeometry(undefined)).toBe(false);
    expect(isPlausibleTerminalGeometry({ cols: 80 })).toBe(false);
  });

  it("keeps a floor no real pane can fall under", () => {
    // `calculateTerminalDimensions` refuses to ESTIMATE a pane below 20x10, so
    // a 20x5 floor cannot reject a grid that estimator would produce. Pinned
    // here because the two numbers have to stay in that order: raise this floor
    // above the estimator's and a legitimately narrow pane starts being refused.
    expect(MIN_PLAUSIBLE_TERMINAL_COLS).toBe(20);
    expect(MIN_PLAUSIBLE_TERMINAL_ROWS).toBeLessThanOrEqual(10);
  });
});
