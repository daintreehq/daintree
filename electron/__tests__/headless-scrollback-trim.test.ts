import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";

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
});
