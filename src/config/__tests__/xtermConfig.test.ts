import { describe, expect, it } from "vitest";
import {
  TERMINAL_SCROLLBAR_WIDTH,
  calculateTerminalDimensions,
  getEffectiveScrollbarWidth,
  getTerminalMetrics,
  getXtermOptions,
} from "@/config/xtermConfig";

const APPEARANCE = {
  fontSize: 12,
  fontFamily: "monospace",
  scrollback: 1000,
  performanceMode: false,
};

describe("scrollbar gutter (#11095)", () => {
  it("hands xterm the same gutter the column math reserves", () => {
    // The bug: getXtermOptions() configured a 15px scrollbar while
    // calculateTerminalDimensions() divided the *full* container width. Both
    // must derive from one constant, or the estimate runs wide and the
    // reconciliation watchdog re-wraps the grid after the agent has painted.
    expect(getXtermOptions(APPEARANCE).scrollbar?.width).toBe(TERMINAL_SCROLLBAR_WIDTH);
  });

  describe("getEffectiveScrollbarWidth", () => {
    // Mirrors FitAddon.proposeDimensions()'s gating exactly. The parity suite in
    // TerminalResizeController.fitParity.test.ts checks these same cases against
    // the real FitAddon; these pin the helper on its own.
    it("reserves the configured width for a scrollable terminal", () => {
      expect(getEffectiveScrollbarWidth({ scrollback: 1000, scrollbar: { width: 15 } })).toBe(15);
    });

    it("reserves nothing when the terminal has no scrollback", () => {
      expect(getEffectiveScrollbarWidth({ scrollback: 0, scrollbar: { width: 15 } })).toBe(0);
    });

    it("reserves nothing when the scrollbar is explicitly hidden", () => {
      expect(
        getEffectiveScrollbarWidth({
          scrollback: 1000,
          scrollbar: { width: 15, showScrollbar: false },
        })
      ).toBe(0);
    });

    // The unset-width fallback (xterm's own default) is deliberately NOT asserted
    // against a literal here — that would just copy the constant back out of the
    // implementation. The "no configured width" case in
    // TerminalResizeController.fitParity.test.ts pins it against the real
    // FitAddon, which is the only oracle that can actually catch us drifting from
    // xterm's default.

    it("honours an explicit zero width rather than treating it as unset", () => {
      // Guards the `??` — an `||` here would silently widen a deliberately
      // gutterless terminal back to the 14px default.
      expect(getEffectiveScrollbarWidth({ scrollback: 1000, scrollbar: { width: 0 } })).toBe(0);
    });
  });

  describe("calculateTerminalDimensions", () => {
    it("round-trips a container sized to hold an exact column count", () => {
      const { cellWidth, cellHeight } = getTerminalMetrics(APPEARANCE.fontSize);
      const desiredCols = 80;
      const desiredRows = 24;

      // Build the container the way the renderer does: room for the columns the
      // agent should get, *plus* the gutter xterm will steal back. The estimate
      // must return exactly those columns — not one extra, which is the spawn
      // that the watchdog later corrects mid-paint.
      const widthPx = desiredCols * cellWidth + TERMINAL_SCROLLBAR_WIDTH;
      const heightPx = desiredRows * cellHeight;

      expect(calculateTerminalDimensions(widthPx, heightPx, APPEARANCE.fontSize)).toEqual({
        cols: desiredCols,
        rows: desiredRows,
      });
    });

    it("reserves the gutter from width only, never from height", () => {
      const { cellHeight } = getTerminalMetrics(APPEARANCE.fontSize);
      const desiredRows = 30;

      // A height sized to exactly `desiredRows` cells must yield exactly that
      // many rows: xterm never reserves the scrollbar against available height,
      // so subtracting it there would come back a row short.
      const dims = calculateTerminalDimensions(1200, desiredRows * cellHeight, APPEARANCE.fontSize);

      expect(dims.rows).toBe(desiredRows);
    });

    it("clamps rather than going negative when the container is thinner than the gutter", () => {
      const dims = calculateTerminalDimensions(TERMINAL_SCROLLBAR_WIDTH - 1, 400, 12);
      expect(dims.cols).toBeGreaterThan(0);
    });
  });
});
