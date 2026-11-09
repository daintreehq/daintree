import { describe, expect, it } from "vitest";
import { gridRise, lastKeptRow, type ShownBuffer } from "../canopyGridRise";

/** A buffer whose lines are `text` from the top of its history; `cursorY` counts from `baseY`. */
function buffer(
  text: string[],
  { baseY = 0, viewportY = baseY, cursorY = 0 }: Partial<Omit<ShownBuffer, "getLine">> = {}
): ShownBuffer {
  return {
    baseY,
    viewportY,
    cursorY,
    getLine: (y) => (y < text.length ? { translateToString: () => text[y]! } : undefined),
  };
}

describe("lastKeptRow", () => {
  it("is the last row with text, however far above the bottom it is", () => {
    expect(lastKeptRow(buffer(["banner", "", "> prompt"]), 60, false)).toBe(2);
    expect(lastKeptRow(buffer(Array.from({ length: 60 }, (_, i) => `line ${i}`)), 60, false)).toBe(
      59
    );
  });

  it("takes blanks, spaces included, as no text", () => {
    expect(lastKeptRow(buffer(["banner", "      ", "　"]), 10, false)).toBe(0);
    expect(lastKeptRow(buffer([]), 10, false)).toBe(-1);
  });

  it("keeps a shown cursor below the text, and no hidden one", () => {
    const fresh = buffer(["banner", "> prompt"], { cursorY: 7 });
    expect(lastKeptRow(fresh, 30, true)).toBe(7);
    expect(lastKeptRow(fresh, 30, false)).toBe(1);
  });

  it("keeps the text below a cursor above it", () => {
    expect(lastKeptRow(buffer(["a", "b", "c", "status"], { cursorY: 1 }), 10, true)).toBe(3);
  });

  it("reads the screen scrolled back to, where the cursor below it is not", () => {
    // 100 rows of history over a 30-row screen, scrolled back to its top.
    const lines = [...Array.from({ length: 12 }, (_, i) => `old ${i}`), ...Array(118).fill("")];
    const scrolled = buffer(lines, { baseY: 100, viewportY: 0, cursorY: 29 });
    expect(lastKeptRow(scrolled, 30, true)).toBe(11);
  });

  it("counts rows, the cursor's too, from the top of the screen shown, not of the history", () => {
    const lines = [
      ...Array(50).fill("history"),
      "screen top",
      "",
      "> prompt",
      ...Array(27).fill(""),
    ];
    const screen = buffer(lines, { baseY: 50, cursorY: 7 });
    expect(lastKeptRow(screen, 30, true)).toBe(7);
    expect(lastKeptRow(screen, 30, false)).toBe(2);
  });
});

describe("gridRise", () => {
  // 60 rows of 16px in a 480px pane: 30 rows show.
  const tall = { gridHeight: 960, rowHeight: 16 };

  it("doesn't rise for kept rows that fit from the top", () => {
    expect(gridRise(tall, 480, 11)).toBe(0);
    expect(gridRise(tall, 480, 29)).toBe(0);
    expect(gridRise(tall, 480, -1)).toBe(0);
  });

  it("rises just far enough to bring the kept row to the pane's bottom", () => {
    expect(gridRise(tall, 480, 30)).toBe(16);
    expect(gridRise(tall, 480, 44)).toBe(240);
  });

  it("rises by the whole overflow, and no further, for the bottom row", () => {
    expect(gridRise(tall, 480, 59)).toBe(480);
    expect(gridRise(tall, 480, 80)).toBe(480);
  });

  it("doesn't rise for a grid that fits, or one a pixel over, but does two over", () => {
    const grid = { gridHeight: 480, rowHeight: 16 };
    expect(gridRise(grid, 480, 29)).toBe(0);
    expect(gridRise(grid, 600, 29)).toBe(0);
    expect(gridRise(grid, 479, 29)).toBe(0);
    expect(gridRise(grid, 478, 29)).toBe(2);
  });

  it("keeps the kept row's edge at the pane's bottom on a canvas xterm rounded off its rows", () => {
    // At 1.5x, 25px device cells are 16.67px: 59 rows round down to a 983px
    // canvas, 58 rows up to a 967px one.
    const cell = 25 / 1.5;
    expect(gridRise({ gridHeight: 983, rowHeight: cell }, 480, 58)).toBeCloseTo(503);
    expect(gridRise({ gridHeight: 967, rowHeight: cell }, 480, 57)).toBeCloseTo(58 * cell - 480);
    expect(gridRise({ gridHeight: 967, rowHeight: cell }, 480, 40)).toBeCloseTo(41 * cell - 480);
  });

  it("doesn't rise before the renderer or the pane has measured", () => {
    expect(gridRise({ gridHeight: 960, rowHeight: 0 }, 480, 59)).toBe(0);
    expect(gridRise({ gridHeight: Number.NaN, rowHeight: 16 }, 480, 59)).toBe(0);
    expect(gridRise(tall, 0, 59)).toBe(0);
  });
});
