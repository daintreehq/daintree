import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import unicode11 from "@xterm/addon-unicode11";
const { Unicode11Addon } = unicode11;

const COLS = 80;
const ROWS = 24;
const INITIAL_SCROLLBACK = 10_000;
const REDUCED_SCROLLBACK = 1_000;
const LINES_TO_WRITE = 10_500;

function writeAll(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, () => resolve());
  });
}

function buildLines(count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(`line ${i}\r\n`);
  }
  return parts.join("");
}

describe("@xterm/headless options.scrollback active truncation (issue #6215)", () => {
  let terminal: Terminal | undefined;

  afterEach(() => {
    terminal?.dispose();
    terminal = undefined;
  });

  it("reducing options.scrollback synchronously evicts existing buffer lines", async () => {
    terminal = new Terminal({
      cols: COLS,
      rows: ROWS,
      scrollback: INITIAL_SCROLLBACK,
      allowProposedApi: true,
    });

    await writeAll(terminal, buildLines(LINES_TO_WRITE));

    const lengthBefore = terminal.buffer.active.length;
    expect(lengthBefore).toBeGreaterThan(REDUCED_SCROLLBACK + ROWS);

    let preHeap: number | undefined;
    if (typeof global.gc === "function") {
      global.gc();
      global.gc();
      preHeap = process.memoryUsage().heapUsed;
    }

    terminal.options.scrollback = REDUCED_SCROLLBACK;

    const lengthAfter = terminal.buffer.active.length;
    expect(lengthAfter).toBeLessThanOrEqual(REDUCED_SCROLLBACK + ROWS);
    expect(lengthAfter).toBeLessThan(lengthBefore);

    // Eviction must drop the oldest lines, not the newest — otherwise the trim primitive
    // would silently corrupt the most recently captured output.
    let foundNewest = false;
    let foundOldest = false;
    for (let y = 0; y < lengthAfter; y++) {
      const text = terminal.buffer.active.getLine(y)?.translateToString(true);
      if (text === `line ${LINES_TO_WRITE - 1}`) foundNewest = true;
      if (text === "line 0") foundOldest = true;
    }
    expect(foundNewest).toBe(true);
    expect(foundOldest).toBe(false);

    if (typeof global.gc === "function" && preHeap !== undefined) {
      global.gc();
      global.gc();
      const postHeap = process.memoryUsage().heapUsed;
      expect(
        postHeap,
        `expected V8 heap to drop after scrollback trim — preHeap=${preHeap} postHeap=${postHeap}`
      ).toBeLessThan(preHeap);
    }
  });

  it("Unicode 11 addon makes modern emoji render at width 2 in headless buffer (issue #7205)", async () => {
    terminal = new Terminal({
      cols: COLS,
      rows: ROWS,
      scrollback: REDUCED_SCROLLBACK,
      allowProposedApi: true,
    });
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";

    // Each emoji listed in #7205 must occupy 2 cells once Unicode 11 is active.
    // Write each one to its own row so column 0 is always the emoji's first cell.
    await writeAll(terminal, "⏳\r\n✅\r\n✨\r\n❌");

    const cell = terminal.buffer.active.getNullCell();
    for (let row = 0; row < 4; row++) {
      const line = terminal.buffer.active.getLine(row);
      expect(line, `row ${row} should exist`).toBeDefined();
      line!.getCell(0, cell);
      expect(cell.getWidth(), `emoji at row ${row} should report cell width 2`).toBe(2);
    }
  });

  it("setting options.scrollback to the current value is a no-op on buffer length", async () => {
    terminal = new Terminal({
      cols: COLS,
      rows: ROWS,
      scrollback: INITIAL_SCROLLBACK,
      allowProposedApi: true,
    });

    await writeAll(terminal, buildLines(LINES_TO_WRITE));
    terminal.options.scrollback = REDUCED_SCROLLBACK;
    const lengthAfterFirstTrim = terminal.buffer.active.length;

    terminal.options.scrollback = REDUCED_SCROLLBACK;
    const lengthAfterRepeat = terminal.buffer.active.length;

    expect(lengthAfterRepeat).toBe(lengthAfterFirstTrim);
  });

  // #11673 — the renderer decides whether a shrink is destructive by measuring
  // how much scrollback is retained. Measuring buffer.active gets that wrong
  // under a TUI: the alternate screen is a bare viewport, so it reports zero
  // retained lines while the setter still trims the normal buffer underneath.
  it("trims the normal buffer while the alternate screen is active", async () => {
    terminal = new Terminal({
      cols: COLS,
      rows: ROWS,
      scrollback: INITIAL_SCROLLBACK,
      allowProposedApi: true,
    });

    await writeAll(terminal, buildLines(LINES_TO_WRITE));
    // Enter the alternate screen, as a full-screen TUI does.
    await writeAll(terminal, "\x1b[?1049h");

    expect(terminal.buffer.active.type).toBe("alternate");
    const activeLengthBefore = terminal.buffer.active.length;
    const normalLengthBefore = terminal.buffer.normal.length;

    // The visible buffer is a viewport only — measuring it would report no
    // retained scrollback and wave the destructive write through.
    expect(activeLengthBefore - ROWS).toBeLessThanOrEqual(0);
    expect(normalLengthBefore - ROWS).toBeGreaterThan(REDUCED_SCROLLBACK);

    terminal.options.scrollback = REDUCED_SCROLLBACK;

    expect(terminal.buffer.normal.length).toBeLessThan(normalLengthBefore);
    expect(terminal.buffer.normal.length).toBeLessThanOrEqual(REDUCED_SCROLLBACK + ROWS);
    // The alternate screen itself never carried the history that was lost.
    expect(terminal.buffer.active.length).toBe(activeLengthBefore);
  });
});
