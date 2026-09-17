import { describe, it, expect } from "vitest";
import {
  isCollapsedTerminalGeometry,
  isPlausibleTerminalGeometry,
  isValidTerminalGeometry,
  MAX_TERMINAL_GRID_DIMENSION,
} from "../terminal.js";

/**
 * Three predicates answering three different questions, and the gaps between
 * them are where #12442 lived. A hidden pane's zero-size box divides to
 * FitAddon's 2x1 floor: a grid a terminal can be resized to (structurally
 * valid), a grid no container produced (collapsed), and a grid no pane was
 * showing (implausible).
 *
 * The floors are exercised through the predicates rather than asserted as
 * constants — a test that reads back `MIN_PLAUSIBLE_TERMINAL_COLS` proves only
 * that the constant is itself, not that anything consults it.
 */
describe("terminal geometry floors", () => {
  it("disagrees about the floor grid: valid, but collapsed and implausible", () => {
    // All three asserted together because the point is the DISAGREEMENT. A test
    // that only checked the rejections would still pass if the structural gate
    // had been tightened instead — which would change what snapshot decoding
    // and xterm-level code accept, and is the wrong way to fix this.
    expect(isValidTerminalGeometry({ cols: 2, rows: 1 })).toBe(true);
    expect(isCollapsedTerminalGeometry({ cols: 2, rows: 1 })).toBe(true);
    expect(isPlausibleTerminalGeometry({ cols: 2, rows: 1 })).toBe(false);
  });

  describe("isCollapsedTerminalGeometry", () => {
    it("catches the floor signature on either axis alone", () => {
      expect(isCollapsedTerminalGeometry({ cols: 2, rows: 90 })).toBe(true);
      expect(isCollapsedTerminalGeometry({ cols: 302, rows: 1 })).toBe(true);
    });

    it("clears a grid one cell past the floor on both axes", () => {
      expect(isCollapsedTerminalGeometry({ cols: 3, rows: 2 })).toBe(false);
    });

    it("clears the smallest grid a real pane can measure", () => {
      // A pane at MIN_TERMINAL_WIDTH_PX x MIN_TERMINAL_HEIGHT_PX with the
      // largest supported font measures about this. It has to pass, or the
      // universal floor would clip a pane somebody is looking at — which is why
      // this floor is not the plausibility one.
      expect(isCollapsedTerminalGeometry({ cols: 23, rows: 4 })).toBe(false);
      expect(isPlausibleTerminalGeometry({ cols: 23, rows: 4 })).toBe(false);
    });

    it("treats a structurally invalid grid as collapsed", () => {
      // Non-finite is the case that mattered: `normalizeTerminalGridDimension`
      // maps NaN to 1, and a bare `< floor` comparison is false for NaN, so a
      // predicate that only compared numbers would have let it through.
      expect(isCollapsedTerminalGeometry({ cols: NaN, rows: NaN })).toBe(true);
      expect(isCollapsedTerminalGeometry({ cols: Infinity, rows: 24 })).toBe(true);
      expect(isCollapsedTerminalGeometry({ cols: 80.5, rows: 24 })).toBe(true);
      expect(isCollapsedTerminalGeometry({ cols: -80, rows: -24 })).toBe(true);
      expect(isCollapsedTerminalGeometry({ cols: MAX_TERMINAL_GRID_DIMENSION + 1, rows: 24 })).toBe(
        true
      );
      expect(isCollapsedTerminalGeometry(null)).toBe(true);
      expect(isCollapsedTerminalGeometry(undefined)).toBe(true);
      expect(isCollapsedTerminalGeometry({ cols: 80 })).toBe(true);
    });
  });

  describe("isPlausibleTerminalGeometry", () => {
    it("refuses the grids the reporter's panes collapsed to", () => {
      expect(isPlausibleTerminalGeometry({ cols: 2, rows: 1 })).toBe(false);
      expect(isPlausibleTerminalGeometry({ cols: 3, rows: 90 })).toBe(false);
    });

    it("refuses a grid that clears one floor but not the other", () => {
      expect(isPlausibleTerminalGeometry({ cols: 19, rows: 5 })).toBe(false);
      expect(isPlausibleTerminalGeometry({ cols: 20, rows: 4 })).toBe(false);
    });

    it("accepts the smallest workable pane and everything above it", () => {
      expect(isPlausibleTerminalGeometry({ cols: 20, rows: 5 })).toBe(true);
      expect(isPlausibleTerminalGeometry({ cols: 80, rows: 24 })).toBe(true);
      expect(isPlausibleTerminalGeometry({ cols: 302, rows: 90 })).toBe(true);
    });

    it("inherits every structural rejection rather than restating them", () => {
      expect(isPlausibleTerminalGeometry({ cols: NaN, rows: NaN })).toBe(false);
      expect(isPlausibleTerminalGeometry({ cols: Infinity, rows: Infinity })).toBe(false);
      expect(isPlausibleTerminalGeometry({ cols: 80.5, rows: 24 })).toBe(false);
      expect(isPlausibleTerminalGeometry({ cols: MAX_TERMINAL_GRID_DIMENSION + 1, rows: 24 })).toBe(
        false
      );
      expect(isPlausibleTerminalGeometry(null)).toBe(false);
      expect(isPlausibleTerminalGeometry({ cols: 80 })).toBe(false);
    });
  });

  it("orders the two floors so the strict one is never the looser test", () => {
    // The relationship, not the values: whatever the numbers become, anything
    // the strict floor accepts must clear the universal one, or a derived grid
    // could pass the write boundaries while the PTY refused it — the split this
    // whole fix exists to prevent.
    for (const grid of [
      { cols: 20, rows: 5 },
      { cols: 23, rows: 40 },
      { cols: 80, rows: 24 },
    ]) {
      if (isPlausibleTerminalGeometry(grid)) {
        expect(isCollapsedTerminalGeometry(grid)).toBe(false);
      }
    }
  });
});
