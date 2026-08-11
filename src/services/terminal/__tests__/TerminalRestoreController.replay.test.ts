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
import { terminalClient } from "@/clients";

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

  function makeTerminal(cols: number, rows: number = 10): Terminal {
    return new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  }

  /** Capture a snapshot the way the pty-host mirror does. */
  async function capture(
    cols: number,
    content: string,
    rows?: number
  ): Promise<{ snapshot: SerializedTerminalSnapshot; source: Terminal }> {
    const source = makeTerminal(cols, rows);
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

  function makeController(
    terminal: Terminal,
    overrides: Partial<ManagedTerminal> = {}
  ): {
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
      // Opened: these panes were attached and measured, so `terminal.cols/rows`
      // genuinely describes their grid. Parked panes are the exception and say
      // so explicitly (#11718).
      isOpened: true,
      ...overrides,
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

  /**
   * A parked pane must end a restore on the grid it is really on (#11718).
   *
   * A pane restored into a non-selected worktree is prewarmed but never
   * attached, so nothing fits it — yet it stays content-live and keeps parsing
   * whatever its surviving PTY streams. `terminal.cols/rows` for such a pane is
   * xterm's constructor default, not evidence of anything, and seeding the
   * restore window from it left the pane back at 80×24 after a correctly
   * aligned replay. Every subsequent agent repaint then wrapped into the wrong
   * rows, and because that is committed cell data no later fit or Redraw undoes
   * it — it only clears once new output scrolls it away.
   */
  describe("parked pane geometry", () => {
    const PARKED_COLS = 120;
    const PARKED_ROWS = 30;
    const CAPTURE_COLS = 90;

    // Longer than the 80-column default and shorter than the pane's real grid,
    // so it occupies one row on the real grid and wraps onto a second at the
    // default. Erase-line then only clears the first of those two rows, which
    // is how one repainting status line becomes fragments down the pane.
    const STATUS_LINE = "* Cooking".padEnd(95, ".");

    /** Cursor-addressed repaints, the way an agent CLI emits them. */
    async function streamStatusRepaints(terminal: Terminal): Promise<void> {
      for (let frame = 0; frame < 4; frame++) {
        await writeAndFlush(terminal, `\x1b[1;1H\x1b[2K${STATUS_LINE} ${frame}`);
      }
    }

    it("parses live output at the pane's real grid, not the constructor default", async () => {
      const { snapshot, source } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);

      // Ground truth: the same session on the real grid throughout — what the
      // user would have seen had the view never been evicted.
      const truth = await reflowed(source, PARKED_COLS);
      await streamStatusRepaints(truth);

      // The pane as hydration builds it: prewarmed at xterm's default, never
      // attached, carrying the persisted grid only as an attach target.
      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, {
        isOpened: false,
        targetCols: PARKED_COLS,
        targetRows: PARKED_ROWS,
      });

      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      await flush(live);
      // endRestoreWindow hops out of the write callback via queueMicrotask, so
      // the geometry is only settled one tick after the replay drains.
      await Promise.resolve();

      // Live PTY output arrives long before the user selects this worktree.
      await streamStatusRepaints(live);

      expect(live.cols).toBe(PARKED_COLS);
      expect(readBuffer(live)).toEqual(readBuffer(truth));
      expect(cursorOf(live)).toBe(cursorOf(truth));
    });

    it("falls back to the snapshot's capture grid when the pane has no target", async () => {
      // No persisted size reached this pane, so the grid the mirror and PTY were
      // last agreed on is the best evidence left — still better than a default
      // the pane was never on.
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);

      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, { isOpened: false });

      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(CAPTURE_COLS);
      expect(live.rows).toBe(PARKED_ROWS);
    });

    it("keeps that fallback through fetchAndRestore, the path hydration uses", async () => {
      // fetchAndRestore opens its window BEFORE the snapshot exists, and the
      // nested restore cannot reseed an open window — so a seed computed from
      // capture geometry would never survive this entry point. Expressing "no
      // target" as an absent seed is what makes the two paths agree.
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);
      vi.mocked(terminalClient.getSerializedState).mockResolvedValue(snapshot);

      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, { isOpened: false });

      await controller.fetchAndRestore("t1");
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(CAPTURE_COLS);
      expect(live.rows).toBe(PARKED_ROWS);
    });

    it("prefers the parked target over the capture grid through fetchAndRestore", async () => {
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);
      vi.mocked(terminalClient.getSerializedState).mockResolvedValue(snapshot);

      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, {
        isOpened: false,
        targetCols: PARKED_COLS,
        targetRows: PARKED_ROWS,
      });

      await controller.fetchAndRestore("t1");
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(PARKED_COLS);
    });

    it("applies the parked target on the incremental path too", async () => {
      // Large snapshots take the incremental route, which opens its own window.
      const bulk = `${WRAPPED_LINE}\r\n`.repeat(40) + WRAPPED_LINE;
      const { snapshot } = await capture(CAPTURE_COLS, bulk, PARKED_ROWS);

      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, {
        isOpened: false,
        targetCols: PARKED_COLS,
        targetRows: PARKED_ROWS,
      });

      await controller.restoreFromSerializedIncremental("t1", snapshot.data, snapshot);
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(PARKED_COLS);
      expect(live.rows).toBe(PARKED_ROWS);
    });

    it("ignores a parked target that is not a grid a terminal could have had", async () => {
      // Corrupt or legacy persisted state must not become the pane's grid; the
      // capture grid stands instead.
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);

      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, {
        isOpened: false,
        targetCols: 100_000,
        targetRows: PARKED_ROWS,
      });

      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(CAPTURE_COLS);
    });

    it("keeps a resize that lands mid-replay ahead of the parked target", async () => {
      // The window seed is the only thing that changed: a real resize arriving
      // during the replay still parks into pendingRestoreGeometry and still
      // wins, exactly as before (#11552).
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);

      const live = makeTerminal(80, 24);
      const { controller, managed } = makeController(live, {
        isOpened: false,
        targetCols: PARKED_COLS,
        targetRows: PARKED_ROWS,
      });

      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      managed.pendingRestoreGeometry = { cols: 64, rows: 20 };
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(64);
      expect(live.rows).toBe(20);
    });

    it("leaves an opened pane's live grid authoritative", async () => {
      // An attached pane WAS measured, so its own grid outranks a stale target.
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);

      const live = makeTerminal(100);
      const { controller } = makeController(live, {
        isOpened: true,
        targetCols: PARKED_COLS,
        targetRows: PARKED_ROWS,
      });

      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(100);
    });
  });
});
