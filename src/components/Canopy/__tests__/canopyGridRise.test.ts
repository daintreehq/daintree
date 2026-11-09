import { describe, expect, it } from "vitest";
import { gridRise, lastKeptRow, type ShownBuffer } from "../canopyGridRise";

/** A buffer whose lines are `text` from the top of its history; `cursorY` counts from `baseY`. */
function buffer(
  text: string[],
  { baseY = 0, viewportY = baseY, cursorY = 0 } = {}
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

  it("counts rows from the top of the screen shown, not of the history", () => {
    const lines = [...Array(50).fill("history"), "screen top", "", "> prompt", ...Array(27).fill("")];
    expect(lastKeptRow(buffer(lines, { baseY: 50, cursorY: 2 }), 30, true)).toBe(2);
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

  it("doesn't rise for a grid that fits, or one a pixel over", () => {
    expect(gridRise({ gridHeight: 480, rowHeight: 16 }, 480, 29)).toBe(0);
    expect(gridRise({ gridHeight: 481, rowHeight: 16 }, 480, 29)).toBe(0);
    expect(gridRise({ gridHeight: 480, rowHeight: 16 }, 600, 29)).toBe(0);
  });

  it("brings the bottom row's edge to the pane's on a canvas rounded past its rows", () => {
    // WebGL rounds its canvas: 60 rows of 16.5px in a 990.4px one.
    expect(gridRise({ gridHeight: 990.4, rowHeight: 16.5 }, 480, 59)).toBeCloseTo(510);
    expect(gridRise({ gridHeight: 990.4, rowHeight: 16.5 }, 480, 40)).toBeCloseTo(196.5);
  });

  it("doesn't rise before the renderer or the pane has measured", () => {
    expect(gridRise({ gridHeight: 960, rowHeight: 0 }, 480, 59)).toBe(0);
    expect(gridRise({ gridHeight: Number.NaN, rowHeight: 16 }, 480, 59)).toBe(0);
    expect(gridRise(tall, 0, 59)).toBe(0);
  });
});
