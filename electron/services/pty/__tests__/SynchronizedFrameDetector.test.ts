import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Terminal } from "@xterm/headless";
import type { FrameSnapshot } from "../SynchronizedFrameAnalyzer.js";
import { SynchronizedFrameDetector } from "../SynchronizedFrameDetector.js";

const OPEN = "\x1b[?2026h";
const CLOSE = "\x1b[?2026l";

async function flushTerminal(terminal: Terminal): Promise<void> {
  return new Promise((resolve) => terminal.write("", resolve));
}

describe("SynchronizedFrameDetector", () => {
  let terminal: Terminal;
  let frames: FrameSnapshot[];
  let detector: SynchronizedFrameDetector;

  beforeEach(() => {
    terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    frames = [];
    detector = new SynchronizedFrameDetector(terminal, (snap) => {
      frames.push(snap);
    });
  });

  afterEach(() => {
    detector.dispose();
    terminal.dispose();
  });

  it("fires exactly one frame-close on a balanced 2026 bracket pair", async () => {
    terminal.write(`${OPEN}hello world${CLOSE}`);
    await flushTerminal(terminal);
    expect(frames).toHaveLength(1);
    expect(frames[0].terminalCols).toBe(40);
    expect(frames[0].rows.length).toBeGreaterThan(0);
    expect(frames[0].bottomRowText).toBe("");
  });

  it("fires once for nested 2026 brackets — outer close commits", async () => {
    terminal.write(`${OPEN}outer${OPEN}inner${CLOSE} more${CLOSE}`);
    await flushTerminal(terminal);
    expect(frames).toHaveLength(1);
  });

  it("handles CSI sequences split across writes", async () => {
    // node-pty can deliver `\x1b[?20` and `26h` in separate chunks. The
    // xterm parser stitches them back together; verify the detector sees
    // the open as if it were one chunk.
    terminal.write("\x1b[?20");
    terminal.write("26h frame body \x1b[?2026l");
    await flushTerminal(terminal);
    expect(frames).toHaveLength(1);
  });

  it("captures bottom rows in the snapshot", async () => {
    // Move to bottom-1 and write a known marker, then bracket a frame.
    terminal.write(`\x1b[10;1Hbottom-row-marker${OPEN}${CLOSE}`);
    await flushTerminal(terminal);
    expect(frames).toHaveLength(1);
    const snap = frames[0];
    expect(snap.bottomRowText).toContain("bottom-row-marker");
    // Snapshot should have the configured row count (default 3) up to
    // terminal.rows.
    expect(snap.rows.length).toBe(3);
    // Each row has exactly terminal.cols cells.
    for (const row of snap.rows) {
      expect(row.length).toBe(40);
    }
  });

  it("ignores non-2026 DECSET sequences", async () => {
    // Bracketed paste mode (?2004), application cursor keys (?1)
    terminal.write("\x1b[?2004h\x1b[?1h\x1b[?2004l\x1b[?1l");
    await flushTerminal(terminal);
    expect(frames).toHaveLength(0);
  });

  it("force-resets nesting counter on missing close after timeout", async () => {
    detector.dispose();
    const detector2 = new SynchronizedFrameDetector(terminal, (snap) => frames.push(snap), {
      missingCloseTimeoutMs: 50,
    });
    try {
      terminal.write(OPEN);
      await flushTerminal(terminal);
      expect(detector2.getNestingDepth()).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(detector2.getNestingDepth()).toBe(0);
      // Snapshot must NOT have been emitted on timeout — would reflect a
      // half-rendered state.
      expect(frames).toHaveLength(0);
    } finally {
      detector2.dispose();
    }
  });

  it("ignores stray close brackets", async () => {
    terminal.write(CLOSE);
    await flushTerminal(terminal);
    expect(frames).toHaveLength(0);
  });

  it("stops emitting frames after dispose", async () => {
    terminal.write(`${OPEN}first${CLOSE}`);
    await flushTerminal(terminal);
    expect(frames).toHaveLength(1);
    detector.dispose();
    terminal.write(`${OPEN}second${CLOSE}`);
    await flushTerminal(terminal);
    expect(frames).toHaveLength(1);
  });

  it("does not double-fire when the same write batch contains multiple frames", async () => {
    terminal.write(`${OPEN}one${CLOSE}${OPEN}two${CLOSE}${OPEN}three${CLOSE}`);
    await flushTerminal(terminal);
    expect(frames).toHaveLength(3);
  });
});
