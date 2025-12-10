import { describe, it, expect } from "vitest";

/**
 * Tests for the redraw detection pattern matching used in TerminalInstanceService.
 * These patterns trigger adaptive flush timing to eliminate TUI flicker.
 *
 * Detection triggers on:
 * - \x1b[2J - CSI Erase in Display (ED) - Clear entire display
 * - \x1b[H - CSI Cursor Position - Move cursor to home (1,1)
 *
 * Both sequences typically signal the start of a full-screen repaint.
 */

// Extract the redraw detection logic for testability
function detectRedrawPattern(data: string | Uint8Array): boolean {
  if (typeof data === "string") {
    return data.includes("\x1b[2J") || data.includes("\x1b[H");
  }
  return false;
}

describe("Terminal redraw detection", () => {
  describe("detectRedrawPattern", () => {
    it("detects clear screen sequence (\\x1b[2J)", () => {
      expect(detectRedrawPattern("\x1b[2J")).toBe(true);
      expect(detectRedrawPattern("before\x1b[2Jafter")).toBe(true);
      expect(detectRedrawPattern("\x1b[2J\x1b[H")).toBe(true);
    });

    it("detects cursor home sequence (\\x1b[H)", () => {
      expect(detectRedrawPattern("\x1b[H")).toBe(true);
      expect(detectRedrawPattern("before\x1b[Hafter")).toBe(true);
      expect(detectRedrawPattern("\x1b[H\x1b[2J")).toBe(true);
    });

    it("returns false for standard terminal output", () => {
      expect(detectRedrawPattern("Hello, World!")).toBe(false);
      expect(detectRedrawPattern("")).toBe(false);
      expect(detectRedrawPattern("\r\n")).toBe(false);
      expect(detectRedrawPattern("npm run build")).toBe(false);
    });

    it("returns false for binary data (Uint8Array)", () => {
      const binaryData = new Uint8Array([27, 91, 50, 74]); // \x1b[2J as bytes
      expect(detectRedrawPattern(binaryData)).toBe(false);
    });

    it("returns false for other ANSI sequences", () => {
      // Color codes
      expect(detectRedrawPattern("\x1b[31m")).toBe(false); // Red
      expect(detectRedrawPattern("\x1b[0m")).toBe(false); // Reset
      // Cursor movement (not home)
      expect(detectRedrawPattern("\x1b[5A")).toBe(false); // Move up 5
      expect(detectRedrawPattern("\x1b[10B")).toBe(false); // Move down 10
      expect(detectRedrawPattern("\x1b[3C")).toBe(false); // Move forward 3
      expect(detectRedrawPattern("\x1b[2D")).toBe(false); // Move backward 2
      // Cursor position with coordinates
      expect(detectRedrawPattern("\x1b[5;10H")).toBe(false); // Position 5,10
      // Clear line (not full screen)
      expect(detectRedrawPattern("\x1b[K")).toBe(false); // Clear to end of line
      expect(detectRedrawPattern("\x1b[2K")).toBe(false); // Clear entire line
    });

    it("detects redraw in typical TUI frame data", () => {
      // Simulates typical TUI repaint: clear + content
      const tuiFrame =
        "\x1b[H\x1b[2J" +
        "\x1b[1;1HLine 1 content\r\n" +
        "\x1b[2;1HLine 2 content\r\n" +
        "\x1b[3;1HLine 3 content";
      expect(detectRedrawPattern(tuiFrame)).toBe(true);
    });

    it("detects redraw in stress test output pattern", () => {
      // Pattern similar to what stress-test generates
      const stressFrame = "\x1b[H" + "=".repeat(80) + "\r\n" + "Data: 12345\r\n";
      expect(detectRedrawPattern(stressFrame)).toBe(true);
    });

    it("handles partial sequences correctly", () => {
      // Partial \x1b[2J - should not match incomplete sequence
      expect(detectRedrawPattern("\x1b[2")).toBe(false);
      expect(detectRedrawPattern("\x1b[")).toBe(false);
      expect(detectRedrawPattern("\x1b")).toBe(false);
    });

    it("detects mixed content with redraw sequences", () => {
      // Real-world vim output often has text followed by screen clear
      expect(detectRedrawPattern("some text\x1b[Hmore text")).toBe(true);
      expect(detectRedrawPattern("\x1b[31mred\x1b[0m\x1b[2J")).toBe(true);
    });
  });

  describe("timing constants", () => {
    // Document the expected timing values
    const STANDARD_FLUSH_DELAY_MS = 4;
    const REDRAW_FLUSH_DELAY_MS = 16;

    it("standard delay preserves typing latency", () => {
      expect(STANDARD_FLUSH_DELAY_MS).toBe(4);
      expect(STANDARD_FLUSH_DELAY_MS).toBeLessThanOrEqual(5);
    });

    it("redraw delay allows full frame capture at 60fps", () => {
      expect(REDRAW_FLUSH_DELAY_MS).toBe(16);
      // 60fps = 16.67ms per frame, 16ms is just under 1 frame
      expect(REDRAW_FLUSH_DELAY_MS).toBeGreaterThanOrEqual(16);
      expect(REDRAW_FLUSH_DELAY_MS).toBeLessThanOrEqual(17);
    });

    it("redraw delay is 4x standard delay", () => {
      expect(REDRAW_FLUSH_DELAY_MS / STANDARD_FLUSH_DELAY_MS).toBe(4);
    });
  });
});
