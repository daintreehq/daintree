import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Terminal } from "@xterm/headless";
import { applyXtermReflowFastpath } from "../xtermReflowFastpath.js";

/**
 * Equivalence suite for the reflow fastpath: drives an UNPATCHED terminal
 * through adversarial content + resize scripts first (prototype patching is
 * process-global and irreversible, so baseline snapshots must be collected
 * before the first apply), then patches and replays the identical scripts,
 * comparing full-buffer snapshots. An xterm version bump that drifts any of
 * the internals the fastpath mirrors fails here before it can ship.
 */

async function makeTerminal(cols: number, rows: number, scrollback: number): Promise<Terminal> {
  const { Terminal: HeadlessTerminal } = await import("@xterm/headless");
  return new HeadlessTerminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
    convertEol: true,
  });
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    terminal.write(data, () => resolve());
  });
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

interface BufferSnapshot {
  cols: number;
  rows: number;
  length: number;
  baseY: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  text: string[];
  wrapped: boolean[];
  cells: string[];
  markers: number[];
}

function snapshot(
  terminal: Terminal,
  markers: { line: number; isDisposed: boolean }[]
): BufferSnapshot {
  const buffer = terminal.buffer.active;
  const text: string[] = [];
  const wrapped: boolean[] = [];
  const cells: string[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    text.push(line?.translateToString(false) ?? "<missing>");
    wrapped.push(line?.isWrapped ?? false);
    // Full per-cell attribute dump on a sample of lines keeps runtime sane
    // while still covering colors, widths, and cell-level flags.
    if (y % 3 === 0 && line) {
      const parts: string[] = [];
      for (let x = 0; x < terminal.cols; x += 1) {
        const cell = line.getCell(x);
        if (!cell) continue;
        parts.push(
          `${x}:${cell.getChars()}|w${cell.getWidth()}|f${cell.getFgColor()}|b${cell.getBgColor()}|u${cell.isUnderline()}|i${cell.isInverse()}`
        );
      }
      cells.push(`${y}=${parts.join(",")}`);
    }
  }
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    length: buffer.length,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    text,
    wrapped,
    cells,
    markers: markers.map((marker) => (marker.isDisposed ? -2 : marker.line)),
  };
}

function adversarialContent(seed: number, lineCount: number): string {
  const rng = createRng(seed);
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    const draw = rng();
    if (draw < 0.2) {
      const width = 120 + Math.floor(rng() * 200);
      let long = `tool-result ${i}: `;
      while (long.length < width) long += "path/to/module.ts:42 expected=true actual=false ";
      lines.push(long.slice(0, width));
    } else if (draw < 0.3) {
      lines.push(
        `\x1b[1;31mfail\x1b[0m \x1b[42m ok \x1b[0m \x1b[4:3m\x1b[58:5:196mcurly-${i}\x1b[0m plain tail`
      );
    } else if (draw < 0.4) {
      lines.push(`宽字符测试 ${i} 你好世界 emoji 👍👨‍👩‍👧 combining éà done`);
    } else if (draw < 0.45) {
      lines.push(`\x1b[1"qprotected-${i}\x1b[0"q cleared \x1b[K tail`);
    } else {
      lines.push(`[worker ${i % 4}] step ${i} ok`);
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

interface ScriptResult {
  snapshots: BufferSnapshot[];
}

/**
 * The deterministic script both terminals replay. Every snapshot point is
 * taken after synchronous resize work settles, so patched and unpatched
 * runs are directly comparable.
 */
async function runScript(terminal: Terminal): Promise<ScriptResult> {
  const snapshots: BufferSnapshot[] = [];
  const markers: { line: number; isDisposed: boolean }[] = [];

  await write(terminal, adversarialContent(1234, 400));
  const marker = terminal.registerMarker(0);
  if (marker) markers.push(marker);
  await write(terminal, adversarialContent(77, 300));
  const marker2 = terminal.registerMarker(-5);
  if (marker2) markers.push(marker2);
  snapshots.push(snapshot(terminal, markers));

  // Width shrink storm (drag-like ±1 steps), then a deep shrink.
  for (let cols = 99; cols >= 90; cols -= 1) {
    terminal.resize(cols, 24);
  }
  snapshots.push(snapshot(terminal, markers));
  terminal.resize(57, 24);
  snapshots.push(snapshot(terminal, markers));

  // Grow back past the original width (unwrap + per-line grow paths).
  terminal.resize(130, 24);
  snapshots.push(snapshot(terminal, markers));

  // Write at the new grid, resize rows both directions.
  await write(terminal, adversarialContent(4242, 120));
  terminal.resize(130, 10);
  snapshots.push(snapshot(terminal, markers));
  terminal.resize(80, 31);
  snapshots.push(snapshot(terminal, markers));

  // Alt buffer: no reflow, but rows/cols loops still run.
  await write(terminal, "\x1b[?1049h");
  await write(terminal, adversarialContent(9, 40));
  terminal.resize(70, 20);
  snapshots.push(snapshot(terminal, markers));
  await write(terminal, "\x1b[?1049l");
  snapshots.push(snapshot(terminal, markers));

  // Pending-write flushSync inside resize (the PERF-112 shape).
  terminal.write(adversarialContent(31337, 200));
  terminal.resize(100, 24);
  snapshots.push(snapshot(terminal, markers));

  // Capacity-slack roundtrip: snapshot IMMEDIATELY after each grow-back —
  // a grow that fails to null-fill re-exposed slack cells is only visible
  // at this instant, before the next shrink hides them again.
  terminal.resize(45, 24);
  snapshots.push(snapshot(terminal, markers));
  terminal.resize(100, 24);
  snapshots.push(snapshot(terminal, markers));
  terminal.resize(72, 24);
  await write(terminal, adversarialContent(555, 80));
  snapshots.push(snapshot(terminal, markers));

  return { snapshots };
}

const SCROLLBACK = 3000;

/** Randomized-geometry rounds shared by the fuzz baseline and patched run. */
async function runFuzz(terminal: Terminal): Promise<BufferSnapshot[]> {
  const rng = createRng(20260707);
  const snapshots: BufferSnapshot[] = [];
  for (let round = 0; round < 12; round += 1) {
    await write(terminal, adversarialContent(round * 31 + 7, 60));
    const cols = 20 + Math.floor(rng() * 140);
    const rows = 5 + Math.floor(rng() * 35);
    terminal.resize(cols, rows);
    snapshots.push(snapshot(terminal, []));
  }
  return snapshots;
}

let baseline: ScriptResult;
let baselineFuzz: BufferSnapshot[];

describe("xtermReflowFastpath", () => {
  let envBefore: string | undefined;

  beforeAll(async () => {
    envBefore = process.env.DAINTREE_DISABLE_XTERM_REFLOW_FASTPATH;
    delete process.env.DAINTREE_DISABLE_XTERM_REFLOW_FASTPATH;
    // Baselines MUST run before any apply — prototype patches are global to
    // the process and cannot be removed.
    const scriptTerminal = await makeTerminal(100, 24, SCROLLBACK);
    try {
      baseline = await runScript(scriptTerminal);
    } finally {
      scriptTerminal.dispose();
    }
    const fuzzTerminal = await makeTerminal(100, 24, SCROLLBACK);
    try {
      baselineFuzz = await runFuzz(fuzzTerminal);
    } finally {
      fuzzTerminal.dispose();
    }
  }, 120_000);

  afterAll(() => {
    if (envBefore === undefined) {
      delete process.env.DAINTREE_DISABLE_XTERM_REFLOW_FASTPATH;
    } else {
      process.env.DAINTREE_DISABLE_XTERM_REFLOW_FASTPATH = envBefore;
    }
  });

  it("respects the kill switch without touching prototypes", async () => {
    const terminal = await makeTerminal(100, 24, SCROLLBACK);
    try {
      process.env.DAINTREE_DISABLE_XTERM_REFLOW_FASTPATH = "1";
      expect(applyXtermReflowFastpath(terminal)).toBe(false);
    } finally {
      delete process.env.DAINTREE_DISABLE_XTERM_REFLOW_FASTPATH;
      terminal.dispose();
    }
  });

  it("returns false for a non-terminal input", () => {
    expect(applyXtermReflowFastpath({})).toBe(false);
    expect(applyXtermReflowFastpath(null)).toBe(false);
  });

  it("applies both patch layers against the pinned xterm build", async () => {
    const terminal = await makeTerminal(100, 24, SCROLLBACK);
    try {
      // If this fails after an @xterm bump, the internals the fastpath
      // mirrors have drifted — re-verify against the new sources.
      expect(applyXtermReflowFastpath(terminal)).toBe(true);
      // Idempotent on an already-patched process.
      expect(applyXtermReflowFastpath(terminal)).toBe(true);
    } finally {
      terminal.dispose();
    }
  });

  it("matches unpatched buffer state across adversarial content and resizes", async () => {
    const terminal = await makeTerminal(100, 24, SCROLLBACK);
    try {
      // The baseline itself must be non-trivial or equality proves nothing.
      expect(baseline.snapshots[0]!.text.some((line) => line.includes("tool-result"))).toBe(true);
      expect(baseline.snapshots[0]!.wrapped.some(Boolean)).toBe(true);
      expect(baseline.snapshots[0]!.markers.some((line) => line >= 0)).toBe(true);

      expect(applyXtermReflowFastpath(terminal)).toBe(true);
      const patched = await runScript(terminal);
      expect(patched.snapshots.length).toBe(baseline.snapshots.length);
      for (let i = 0; i < patched.snapshots.length; i += 1) {
        expect(patched.snapshots[i], `snapshot ${i}`).toEqual(baseline.snapshots[i]);
      }
    } finally {
      terminal.dispose();
    }
  }, 60_000);

  it("matches unpatched behavior across randomized resize fuzz rounds", async () => {
    const terminal = await makeTerminal(100, 24, SCROLLBACK);
    try {
      expect(applyXtermReflowFastpath(terminal)).toBe(true);
      const patchedSnapshots = await runFuzz(terminal);
      expect(patchedSnapshots).toEqual(baselineFuzz);
    } finally {
      terminal.dispose();
    }
  }, 60_000);
});
