// @vitest-environment node
//
// Real xterm buffers, no DOM: `@xterm/headless` is the same core the pty-host
// mirror runs, so reflow behaviour here is the behaviour that ships. The
// renderer's `@xterm/xterm` needs a live renderer to settle its write queue,
// which jsdom cannot provide.
import { describe, it, expect, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { TerminalRestoreController } from "../TerminalRestoreController";
import type { ManagedTerminal } from "../types";
import type { SerializedTerminalSnapshot } from "@shared/types/terminal";

vi.mock("@/clients", () => ({
  terminalClient: { getSerializedState: vi.fn() },
}));

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

/**
 * Replay fidelity against a real xterm, not a mock (#11552).
 *
 * The contract a snapshot replay owes its caller is that the pane ends up in
 * the state it would have been in had the captured buffer simply been reflowed
 * to the live width. Measured against our pinned xterm, a verbatim
 * wrong-width replay preserves cell content and wrap flags but lands the CURSOR
 * on the wrong column — it re-derives the cursor from where the payload happens
 * to end at the replay width. That is not cosmetic: agent CLIs paint with
 * cursor-relative motion and erase-to-end-of-line, so every repaint after a
 * mis-placed restore writes against the wrong cells, and the damage only clears
 * once the agent redraws the region from scratch.
 *
 * These tests compare a restore against a twin terminal that was reflowed
 * rather than replayed, so they assert the invariant instead of a value copied
 * out of the implementation.
 */
describe("TerminalRestoreController replay fidelity (real xterm)", () => {
  /** Settle xterm's async parser queue. */
  const flush = (terminal: Terminal): Promise<void> =>
    new Promise<void>((resolve) => terminal.write("", () => resolve()));

  const writeAndFlush = (terminal: Terminal, data: string): Promise<void> =>
    new Promise<void>((resolve) => terminal.write(data, () => resolve()));

  function makeTerminal(cols: number, rows = 10): Terminal {
    return new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  }

  /** Capture a snapshot the way the pty-host mirror does. */
  async function capture(
    cols: number,
    content: string
  ): Promise<{ snapshot: SerializedTerminalSnapshot; source: Terminal }> {
    const source = makeTerminal(cols);
    const addon = new SerializeAddon();
    source.loadAddon(addon);
    await writeAndFlush(source, content);
    return { snapshot: { data: addon.serialize(), cols, rows: source.rows }, source };
  }

  /** The state the captured buffer reaches by reflow alone — the ground truth. */
  async function reflowed(source: Terminal, toCols: number): Promise<Terminal> {
    source.options.reflowCursorLine = true;
    source.resize(toCols, source.rows);
    source.options.reflowCursorLine = false;
    await flush(source);
    return source;
  }

  function readBuffer(terminal: Terminal): string[] {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.length > 0) lines.push(`${line.isWrapped ? "W" : "H"}${text}`);
    }
    return lines;
  }

  const cursorOf = (terminal: Terminal) =>
    `${terminal.buffer.active.cursorX},${terminal.buffer.active.cursorY}`;

  function makeController(terminal: Terminal): {
    controller: TerminalRestoreController;
    managed: ManagedTerminal;
  } {
    const managed = {
      terminal,
      writeChain: Promise.resolve(),
      restoreGeneration: 0,
      restoreWindowToken: 0,
      isSerializedRestoreInProgress: false,
      deferredOutput: [],
      isUserScrolledBack: false,
    } as unknown as ManagedTerminal;
    const controller = new TerminalRestoreController({
      getInstance: (id) => (id === "t1" ? managed : undefined),
      writeData: vi.fn(),
    });
    return { controller, managed };
  }

  // No trailing newline: the cursor is parked inside a wrapped group, which is
  // exactly where an agent leaves it between repaints.
  const WRAPPED_LINE = "Tip: press enter and the result will display beneath the input box";

  it.each([
    { label: "widening", captureCols: 40, liveCols: 100, content: WRAPPED_LINE },
    { label: "narrowing", captureCols: 100, liveCols: 40, content: WRAPPED_LINE },
    {
      label: "wide (CJK) cells",
      captureCols: 40,
      liveCols: 100,
      content: "日本語テキストの長い行".repeat(4),
    },
    {
      label: "row filled exactly to the capture width",
      captureCols: 100,
      liveCols: 40,
      content: `${"D".repeat(100)}TAIL`,
    },
  ])(
    "restores the reflow-equivalent buffer and cursor when $label",
    async ({ captureCols, liveCols, content }) => {
      const { snapshot, source } = await capture(captureCols, content);
      const truth = await reflowed(source, liveCols);

      const live = makeTerminal(liveCols);
      const { controller } = makeController(live);
      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      await flush(live);

      expect(live.cols).toBe(liveCols);
      expect(readBuffer(live)).toEqual(readBuffer(truth));
      expect(cursorOf(live)).toBe(cursorOf(truth));
    }
  );

  it("verbatim replay misplaces the cursor — the defect the alignment removes", async () => {
    const { snapshot, source } = await capture(40, WRAPPED_LINE);
    const truth = await reflowed(source, 100);

    // Exactly what the restore path did before the geometry contract existed.
    const verbatim = makeTerminal(100);
    verbatim.reset();
    verbatim.write(snapshot.data);
    await flush(verbatim);

    // Content survives, so a content-only assertion would pass either way and
    // prove nothing — the cursor is what actually diverges.
    expect(readBuffer(verbatim)).toEqual(readBuffer(truth));
    expect(cursorOf(verbatim)).not.toBe(cursorOf(truth));
  });

  it("aligns the incremental path the same way", async () => {
    const bulk = `${WRAPPED_LINE}\r\n`.repeat(40) + WRAPPED_LINE;
    const { snapshot, source } = await capture(40, bulk);
    const truth = await reflowed(source, 100);

    const live = makeTerminal(100);
    const { controller } = makeController(live);
    await controller.restoreFromSerializedIncremental("t1", snapshot.data, snapshot);
    await flush(live);

    expect(live.cols).toBe(100);
    expect(readBuffer(live)).toEqual(readBuffer(truth));
    expect(cursorOf(live)).toBe(cursorOf(truth));
  });

  it("replays a geometry-less snapshot without touching the live grid", async () => {
    const { snapshot } = await capture(40, WRAPPED_LINE);

    const live = makeTerminal(100);
    const { controller } = makeController(live);
    // Pre-#11552 payload: no geometry to align to, so it must behave exactly as
    // it always did rather than refuse the restore and lose the session.
    controller.restoreFromSerialized("t1", snapshot.data);
    await flush(live);

    expect(live.cols).toBe(100);
    expect(readBuffer(live).length).toBeGreaterThan(0);
  });
});
