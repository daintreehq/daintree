// @vitest-environment node
//
// Real xterm buffers, no DOM: `@xterm/headless` is the same core the pty-host
// mirror runs, so reflow behaviour here is the behaviour that ships. The
// renderer's `@xterm/xterm` needs a live renderer to settle its write queue,
// which jsdom cannot provide.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { TerminalRestoreController } from "../TerminalRestoreController";
import { TerminalWriteController } from "../TerminalWriteController";
import { INCREMENTAL_RESTORE_CONFIG } from "../types";
import { streamRangeOf, utf8Length } from "../streamFence";
import { PartialEscapeTracker } from "@shared/utils/terminalPartialEscapeTail";
import type { ManagedTerminal } from "../types";
import type { SerializedTerminalSnapshot } from "@shared/types/terminal";
import { terminalClient } from "@/clients";

vi.mock("@/clients", () => ({
  terminalClient: { getSerializedState: vi.fn() },
}));

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("@/utils/performance", () => ({
  markRendererPerformance: vi.fn(),
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
  const getSerializedState = vi.mocked(terminalClient.getSerializedState);

  const settle = async (terminal: Terminal): Promise<void> => {
    // A restore hops through a microtask before replaying deferred output, and
    // each replayed write queues behind it.
    for (let i = 0; i < 4; i++) {
      await flush(terminal);
      await Promise.resolve();
    }
  };

  // Every terminal in a scenario — source, destination, reference — shares it.
  let gridScrollback = 200;
  function makeGrid(): Terminal {
    return new Terminal({ cols: 40, rows: 6, scrollback: gridScrollback, allowProposedApi: true });
  }

  function screen(terminal: Terminal): { lines: string[]; cursor: string; fg: number[] } {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    const fg: number[] = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      lines.push(line.translateToString(true));
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (cell?.getChars()) fg.push(cell.getFgColor());
      }
    }
    return { lines, cursor: `${buffer.cursorX},${buffer.cursorY}`, fg };
  }

  /** The pty-host side: a mirror that has parsed the first `parsed` chunks. */
  async function hostSnapshot(
    chunks: string[],
    parsed: number,
    withContinuation = true
  ): Promise<SerializedTerminalSnapshot> {
    const mirror = makeGrid();
    const addon = new SerializeAddon();
    mirror.loadAddon(addon);
    const tracker = new PartialEscapeTracker();
    let offset = 0;
    for (const chunk of chunks.slice(0, parsed)) {
      await new Promise<void>((resolve) => mirror.write(chunk, resolve));
      tracker.feed(chunk);
      offset += utf8Length(chunk);
    }
    return {
      data: addon.serialize(),
      cols: mirror.cols,
      rows: mirror.rows,
      ...(withContinuation
        ? { continuation: { pendingEscapeTail: tracker.tail, streamOffset: offset } }
        : {}),
    };
  }

  function makePane(terminal: Terminal) {
    const { managed } = makeController(terminal, {
      // Skips the rAF activity-marker refresh, which has no bearing here.
      isAltBuffer: true,
      parserTail: new PartialEscapeTracker(),
    });
    const acks = { port: 0, ipcBytes: 0 };
    const writer = new TerminalWriteController({
      getInstance: (id) => (id === "t1" ? managed : undefined),
      acknowledgePortData: (_id, _bytes, chunkCount) => {
        acks.port += chunkCount;
      },
      acknowledgeData: (_id, bytes) => {
        acks.ipcBytes += bytes;
      },
      notifyWriteComplete: vi.fn(),
      incrementUnseen: vi.fn(),
    });
    const restorer = new TerminalRestoreController({
      getInstance: (id) => (id === "t1" ? managed : undefined),
      writeData: (id, data, chunkCount, range) => writer.write(id, data, chunkCount, range),
    });
    const stream = { end: 0 };
    // What the ingest path does per delivered chunk: stamp its stream range at
    // receipt, then hand it to the write controller.
    const deliver = (chunk: string, asBytes = false): void => {
      stream.end += utf8Length(chunk);
      // Port chunks arrive as UTF-8 bytes, IPC chunks as strings.
      const data = asBytes ? new TextEncoder().encode(chunk) : chunk;
      writer.write("t1", data, 1, streamRangeOf(data, stream.end));
    };
    return { managed, restorer, deliver, acks, stream };
  }

  async function uninterrupted(chunks: string[]): Promise<ReturnType<typeof screen>> {
    const terminal = makeGrid();
    for (const chunk of chunks) terminal.write(chunk);
    await flush(terminal);
    return screen(terminal);
  }

  /**
   * The renderer painted `painted` chunks live, then a fetch-and-restore opened
   * its window; every later chunk arrives during the fetch. The host serialized
   * after parsing `parsed` of them, so chunks `painted..parsed` are delivered
   * but already in the snapshot.
   */
  async function restoreMidStream(
    chunks: string[],
    painted: number,
    parsed: number,
    options: { withContinuation?: boolean; lateChunks?: number; asBytes?: boolean } = {}
  ): Promise<{ result: ReturnType<typeof screen>; acks: { port: number; ipcBytes: number } }> {
    const terminal = makeGrid();
    const pane = makePane(terminal);
    const late = options.lateChunks ?? 0;
    const deliver = (chunk: string) => pane.deliver(chunk, options.asBytes);
    for (const chunk of chunks.slice(0, painted)) deliver(chunk);
    await flush(terminal);

    const snapshot = await hostSnapshot(chunks, parsed, options.withContinuation ?? true);
    getSerializedState.mockImplementationOnce(async () => {
      for (const chunk of chunks.slice(painted, chunks.length - late)) deliver(chunk);
      return snapshot;
    });
    await pane.restorer.fetchAndRestore("t1");
    await settle(terminal);
    for (const chunk of chunks.slice(chunks.length - late)) deliver(chunk);
    await settle(terminal);
    return { result: screen(terminal), acks: pane.acks };
  }

  const SPLITS: Record<string, string[]> = {
    "CSI SGR": ["hello \x1b[3", "1mRED", " done"],
    "OSC title": ["hello \x1b]0;ti", "tle\x07world", "!"],
    "lone ESC": ["hello \x1b", "[31mRED", " done"],
    "cursor position": ["hello \x1b[2;", "3Hworld", "!"],
  };

  describe("fetch-and-restore across a split escape sequence (#12791)", () => {
    beforeEach(() => {
      getSerializedState.mockReset();
      gridScrollback = 200;
    });

    for (const [name, chunks] of Object.entries(SPLITS)) {
      it(`renders a ${name} split the same as uninterrupted playback`, async () => {
        const expected = await uninterrupted(chunks);
        // Snapshot cut right after the chunk that ends mid-sequence, with that
        // chunk either painted before the fetch or held back during it.
        for (const painted of [0, 1]) {
          const { result } = await restoreMidStream(chunks, painted, 1);
          expect(result, `painted=${painted}`).toEqual(expected);
        }
      });
    }

    it("drops held-back chunks the snapshot already contains instead of repeating them", async () => {
      const chunks = ["one\r\n", "two\r\n", "three\r\n", "four\r\n"];
      const expected = await uninterrupted(chunks);
      for (let parsed = 0; parsed <= chunks.length; parsed++) {
        const { result } = await restoreMidStream(chunks, 0, parsed);
        expect(result, `parsed=${parsed}`).toEqual(expected);
      }
    });

    it("repeats held-back chunks when the snapshot carries no fence (the defect)", async () => {
      const chunks = ["one\r\n", "two\r\n", "three\r\n"];
      const { result } = await restoreMidStream(chunks, 0, 2, { withContinuation: false });
      expect(result).not.toEqual(await uninterrupted(chunks));
    });

    it("drops a covered chunk that lands after the replay has finished", async () => {
      const chunks = ["hello \x1b[3", "1mRED", " done"];
      const { result } = await restoreMidStream(chunks, 0, 2, { lateChunks: 2 });
      expect(result).toEqual(await uninterrupted(chunks));
    });

    it("settles every held-back chunk's ledger exactly once, painted or not", async () => {
      const chunks = ["a", "b", "c", "d", "e"];
      const { acks } = await restoreMidStream(chunks, 1, 3);
      expect(acks.port).toBe(chunks.length);
      expect(acks.ipcBytes).toBe(chunks.join("").length);
    });

    it("trims a held-back batch that straddles the snapshot's offset", async () => {
      const chunks = ["ōne ", "twö 😀 ", "three"];
      const terminal = makeGrid();
      const pane = makePane(terminal);
      const snapshot = await hostSnapshot(chunks, 1);
      getSerializedState.mockImplementationOnce(async () => {
        // The ingest queue coalesced the first two chunks into one batch.
        const batch = chunks[0]! + chunks[1]!;
        pane.stream.end = utf8Length(batch);
        const range = streamRangeOf(batch, pane.stream.end);
        pane.managed.deferredOutput.push({ data: batch, chunkCount: 2, range });
        return snapshot;
      });
      await pane.restorer.fetchAndRestore("t1");
      await settle(terminal);
      pane.deliver(chunks[2]!);
      await settle(terminal);
      expect(screen(terminal)).toEqual(await uninterrupted(chunks));
    });

    it("fences port-delivered byte chunks the same way", async () => {
      for (const chunks of Object.values(SPLITS)) {
        const expected = await uninterrupted(chunks);
        const { result } = await restoreMidStream(chunks, 0, 2, { asBytes: true });
        expect(result).toEqual(expected);
      }
    });

    it("restores a split through the incremental path for a large snapshot", async () => {
      gridScrollback = 12000;
      const filler = Array.from({ length: 11000 }, (_, i) => `line ${i} ${"x".repeat(24)}\r\n`);
      const chunks = [filler.join(""), "tail \x1b[3", "1mRED"];
      const snapshot = await hostSnapshot(chunks, 2);
      expect(snapshot.data.length).toBeGreaterThan(
        INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes
      );
      const expected = await uninterrupted(chunks);
      const { result } = await restoreMidStream(chunks, 0, 2);
      expect(result).toEqual(expected);
    });

    it("applies an empty screen when the source is only mid-sequence", async () => {
      const chunks = ["\x1b[3", "1mRED"];
      const { result } = await restoreMidStream(chunks, 0, 1);
      expect(result).toEqual(await uninterrupted(chunks));
    });

    it("swallows the rest of a sequence too long to carry instead of printing it", async () => {
      const chunks = ["hi \x1b]52;c;" + "QUFB".repeat(20000), "QUFB\x07world"];
      const { result } = await restoreMidStream(chunks, 0, 1);
      expect(result).toEqual(await uninterrupted(chunks));
    });

    it("grounds a destination parser left mid-sequence before the snapshot lands", async () => {
      const chunks = ["prompt$ "];
      const terminal = makeGrid();
      const pane = makePane(terminal);
      // A stale live write left the pane inside an OSC string, which would eat
      // everything up to the next BEL without the leading CAN.
      terminal.write("\x1b]0;stale");
      await flush(terminal);
      getSerializedState.mockResolvedValueOnce(await hostSnapshot(chunks, 1));
      await pane.restorer.fetchAndRestore("t1");
      await settle(terminal);
      expect(screen(terminal).lines[0]?.trimEnd()).toBe("prompt$");
    });
  });
});
