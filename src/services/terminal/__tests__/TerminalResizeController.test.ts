import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";

const { resizeMock, getEffectiveAgentConfigMock } = vi.hoisted(() => ({
  resizeMock: vi.fn(),
  getEffectiveAgentConfigMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: resizeMock,
  },
}));

vi.mock("@shared/config/agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/config/agentRegistry")>();
  return {
    ...actual,
    getEffectiveAgentConfig: getEffectiveAgentConfigMock,
  };
});

import {
  TerminalResizeController,
  getXtermCellDimensions,
  REVEAL_REWRAP_QUIESCENT_MS,
  RESIZE_FLUSH_SYNC_BUDGET_BYTES,
  type ResizeControllerDeps,
} from "../TerminalResizeController";
import { TERMINAL_SCROLLBAR_WIDTH } from "@/config/xtermConfig";
import { MAX_TERMINAL_GRID_DIMENSION } from "@shared/types/terminal";

/**
 * The scrollbar gutter the controller reserves before dividing a container width
 * into columns, mirroring `FitAddon` (#11095). Sourced from the config rather
 * than hardcoded so a change to the configured width doesn't silently desync the
 * mock terminal from the production one.
 */
const SCROLLBAR_PX = TERMINAL_SCROLLBAR_WIDTH;

/** Cell metrics these tests attach via `_core` (see `getXtermCellDimensions`). */
const CELL = { width: 10, height: 20 };

/**
 * Columns the controller should derive for a container of `widthPx`.
 *
 * These suites exercise the resize *control flow* — dedup gates, debounce, lock
 * replay, PTY delivery — so they take the column formula as given and assert
 * against it. The formula itself is verified against a genuinely independent
 * oracle (the real `FitAddon`) in `TerminalResizeController.fitParity.test.ts`.
 */
const colsFor = (widthPx: number): number =>
  Math.max(2, Math.floor((widthPx - SCROLLBAR_PX) / CELL.width));

/**
 * The widest and tallest pixel box that still resolves to the same grid as
 * `widthPx`/`heightPx` — a box the pixel dedup treats as new while the column
 * and row math lands exactly where it did before.
 *
 * Derived from the gutter and cell size rather than hardcoded: now that the
 * scrollbar is reserved before the division (#11095), a fixed "+4px" would
 * cross a cell boundary and silently stop testing the collision it was written
 * for.
 */
const sameGridBox = (widthPx: number, heightPx: number): [number, number] => [
  widthPx + (CELL.width - 1 - ((widthPx - SCROLLBAR_PX) % CELL.width)),
  heightPx + (CELL.height - 1 - (heightPx % CELL.height)),
];

function createManagedTerminal() {
  const terminal = {
    cols: 80,
    rows: 24,
    // Mirrors getXtermOptions(): a live terminal always has scrollback and a
    // visible scrollbar, so the controller reserves SCROLLBAR_PX of every
    // container width before dividing into columns — same as FitAddon (#11095).
    options: {
      scrollback: 1000,
      scrollbar: { width: SCROLLBAR_PX },
    },
    buffer: {
      active: {
        baseY: 0,
        viewportY: 0,
        length: 20,
      },
    },
    resize: vi.fn(function (this: { cols: number; rows: number }, cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }),
    write: vi.fn(),
    scrollToBottom: vi.fn(),
  } as unknown as {
    cols: number;
    rows: number;
    options: { scrollback: number; scrollbar: { width: number } };
    buffer: { active: { baseY: number; viewportY: number; length: number } };
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

  return {
    terminal,
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 100, rows: 30 })),
    },
    hostElement: {
      style: { width: "100%" },
      checkVisibility: vi.fn(() => true),
      getBoundingClientRect: vi.fn(() => ({ left: 0, width: 1000, height: 700 })),
      querySelector: vi.fn(() => null),
    } as unknown as HTMLDivElement,
    isFocused: true,
    isVisible: true,
    lastAppliedTier: TerminalRefreshTier.FOCUSED,
    getRefreshTier: vi.fn(() => TerminalRefreshTier.FOCUSED),
    lastWidth: 800,
    lastHeight: 600,
    resizeJob: undefined,
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    isUserScrolledBack: false,
    isAltBuffer: false,
  } as any;
}

describe("TerminalResizeController", () => {
  let postTaskCallbacks: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // clearAllMocks resets calls but NOT implementations, and both of these are
    // module-hoisted and shared by every test in the file. Without an explicit
    // reset, one test's `mockImplementation`/`mockReturnValue` silently governs
    // every test that runs after it, making the suite order-dependent.
    resizeMock.mockReset();
    getEffectiveAgentConfigMock.mockReset();
    postTaskCallbacks = [];

    vi.stubGlobal("scheduler", {
      postTask: vi.fn((cb: () => unknown, opts?: { signal?: AbortSignal }) => {
        return new Promise<unknown>((resolve, reject) => {
          if (opts?.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          postTaskCallbacks.push(() => {
            if (opts?.signal?.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            try {
              resolve(cb());
            } catch (e) {
              reject(e);
            }
          });
        });
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    postTaskCallbacks = [];
  });

  const flushPostTasks = async () => {
    const callbacks = [...postTaskCallbacks];
    postTaskCallbacks = [];
    callbacks.forEach((cb) => cb());
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  };

  it("background-tier resize flushes held ingest bytes, then moves xterm before the PTY", () => {
    // The core #11628 contract. A content-visibility:hidden pane still parses
    // every byte the PTY emits, so moving the PTY alone leaves the app writing
    // cursor-addressed output sized for the new width into a parser holding the
    // old grid — damage no later reflow can undo. Both grids move together, and
    // the order is load-bearing: SIGWINCH must not reach the app for a grid the
    // parser has not adopted. Held ingest bytes drain first so the backlog
    // parses at the still-consistent outgoing grid.
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    // A streaming pane takes the same path: unlike applyDeferredResize's
    // out-of-band wake reconcile, an observed layout change is never gated on
    // quiescence — deferring it is what splits the grids in the first place.
    managed.pendingWrites = 1;
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

    const order: string[] = [];
    managed.terminal.resize.mockImplementationOnce(function (
      this: { cols: number; rows: number },
      cols: number,
      rows: number
    ) {
      order.push("xterm");
      this.cols = cols;
      this.rows = rows;
    });
    resizeMock.mockImplementationOnce(() => {
      order.push("pty");
    });

    const dataBuffer = {
      flushForTerminal: vi.fn(() => {
        order.push("flush");
      }),
      resetForTerminal: vi.fn(),
      // Under RESIZE_FLUSH_SYNC_BUDGET_BYTES, so the backlog is drained inline
      // rather than left queued for watermarked draining.
      getQueuedBytes: vi.fn(() => 1024),
      resumeFlush: vi.fn(),
    };

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: dataBuffer as any,
    });

    const result = controller.resize("term-1", 1600, 800);
    expect(result).toEqual({ cols: colsFor(1600), rows: 40 });
    // No DOM measurement: a hidden container reports 0x0, which is the whole
    // reason this branch computes from cached cell metrics.
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
    expect(managed.fitAddon.proposeDimensions).not.toHaveBeenCalled();

    expect(order).toEqual(["flush", "xterm", "pty"]);
    expect(dataBuffer.resetForTerminal).toHaveBeenCalledWith("term-1");
    // The flush succeeded, so ingest is already drained — no resume needed.
    expect(dataBuffer.resumeFlush).not.toHaveBeenCalled();
    // Exact counts alongside `order`: the one-shot implementations above only
    // record the FIRST call each, so a duplicate commit would slip past the
    // ordering assertion on its own.
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1600), 40);
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);
    // Reflow mutates ybase/ydisp without firing onScroll, so a bottom-following
    // pane needs the explicit re-pin.
    expect(managed.terminal.scrollToBottom).toHaveBeenCalledOnce();
    expect(managed.latestCols).toBe(colsFor(1600));
    expect(managed.latestRows).toBe(40);
    // The pixel dedup cache still tracks the RAW container width — the scrollbar
    // is reserved when dividing into columns, never folded into this gate.
    expect(managed.lastWidth).toBe(1600);
    expect(managed.lastHeight).toBe(800);
  });

  it("background-tier resize moves an alt-screen pane's grids together too", () => {
    // Deliberately the opposite of applyBackgroundResize's alt-screen refusal.
    // That path can skip BOTH grids because it never sent SIGWINCH; this one
    // always has, so refusing only the xterm half is exactly the split #11628
    // reports. Moving xterm first lets the TUI's own redraw land on the grid it
    // was sized for.
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    managed.isAltBuffer = true;
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

    const order: string[] = [];
    managed.terminal.resize.mockImplementationOnce(function (
      this: { cols: number; rows: number },
      cols: number,
      rows: number
    ) {
      order.push("xterm");
      this.cols = cols;
      this.rows = rows;
    });
    resizeMock.mockImplementationOnce(() => {
      order.push("pty");
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    expect(controller.resize("term-1", 1600, 800)).toEqual({ cols: colsFor(1600), rows: 40 });
    expect(order).toEqual(["xterm", "pty"]);
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1600), 40);
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);
  });

  it("background-tier resize parks the xterm half while a serialized restore replays", () => {
    // The one sanctioned exception to the atomicity contract: during a restore
    // xterm is deliberately held at the snapshot's capture width so the payload
    // decodes, and live output is deferred for the same window — so the PTY may
    // lead. The obligation has to be RECORDED though; the old PTY-only path
    // never did, which is why the grid never caught up.
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    managed.isSerializedRestoreInProgress = true;
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    expect(controller.resize("term-1", 1600, 800)).toEqual({ cols: colsFor(1600), rows: 40 });
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(managed.pendingRestoreGeometry).toEqual({ cols: colsFor(1600), rows: 40 });
    // The PTY still gets the real geometry so the agent keeps producing output
    // sized for the grid the user will see once the replay normalizes.
    expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);
  });

  it("background-tier resize leaves an over-budget ingest backlog queued and resumes it", () => {
    // Above RESIZE_FLUSH_SYNC_BUDGET_BYTES the backlog is too big to parse
    // inline at the outgoing grid, so it stays queued and is resumed after the
    // commit for watermarked draining — the grids still move together.
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

    const order: string[] = [];
    managed.terminal.resize.mockImplementationOnce(function (
      this: { cols: number; rows: number },
      cols: number,
      rows: number
    ) {
      order.push("xterm");
      this.cols = cols;
      this.rows = rows;
    });
    resizeMock.mockImplementationOnce(() => {
      order.push("pty");
    });

    const dataBuffer = {
      flushForTerminal: vi.fn(),
      resetForTerminal: vi.fn(),
      getQueuedBytes: vi.fn(() => RESIZE_FLUSH_SYNC_BUDGET_BYTES + 1),
      resumeFlush: vi.fn(() => {
        order.push("resume");
      }),
    };

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: dataBuffer as any,
    });

    expect(controller.resize("term-1", 1600, 800)).toEqual({ cols: colsFor(1600), rows: 40 });
    // Never flushed at the outgoing grid — that is the whole point of the budget.
    expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
    expect(dataBuffer.resetForTerminal).not.toHaveBeenCalled();
    expect(order).toEqual(["xterm", "pty", "resume"]);
  });

  it("background-tier resize returns null when cell dims are unavailable", () => {
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    // No _core attached — cellDims will be null.

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    const result = controller.resize("term-1", 1600, 800);
    expect(result).toBeNull();
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
    expect(resizeMock).not.toHaveBeenCalled();
    // Dedup cache must not be touched on a no-op early return.
    expect(managed.lastWidth).toBe(800);
    expect(managed.lastHeight).toBe(600);
  });

  it("background-tier resize dedups an identical follow-up without reapplying either grid", () => {
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.resize("term-1", 1600, 800);
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledTimes(1);

    // Same pixel dims → dedup guard returns null before any side effects. Now
    // that the branch reflows xterm too, the guard has to spare both halves:
    // a redundant re-reflow is not free on a pane with deep scrollback.
    const second = controller.resize("term-1", 1600, 800);
    expect(second).toBeNull();
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledTimes(1);
  });

  it("background-tier settled agents commit the coalesced target to both grids", () => {
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    const order: string[] = [];
    managed.terminal.resize.mockImplementationOnce(function (
      this: { cols: number; rows: number },
      cols: number,
      rows: number
    ) {
      order.push("xterm");
      this.cols = cols;
      this.rows = rows;
    });
    resizeMock.mockImplementationOnce(() => {
      order.push("pty");
    });

    controller.resize("term-1", 1600, 800);
    controller.resize("term-1", 1700, 800);
    // Neither grid moves synchronously — the settled 500ms guard owns the pair,
    // which is the whole point of coalescing a drag for these agents.
    expect(order).toEqual([]);

    vi.advanceTimersByTime(499);
    expect(order).toEqual([]);

    vi.advanceTimersByTime(1);
    // One atomic commit at the LATEST target: the superseded 1600px geometry
    // must never reach either grid, and xterm must adopt it before SIGWINCH.
    expect(order).toEqual(["xterm", "pty"]);
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1700), 40);
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1700), 40);
  });

  it("background-tier resize applies a box whose grid equals a stranded target", () => {
    // The #11639 split. `latestCols`/`latestRows` are written ahead of the
    // commit, so a target can outlive the work that was going to apply it —
    // here a settled timer `lockResize` drops. Deduping the next box against
    // that cache calls the resize resolved while xterm is still on the old
    // grid, and the pixel stamp that goes with it makes the box redundant for
    // good. Only the grid xterm actually holds can answer "is there work?".
    const managed = createManagedTerminal();
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: CELL } } } },
    });
    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    // Arm the write-ahead, then strand it: the lock cancels the settled timer,
    // so the target survives with nothing left to commit it.
    controller.resize("term-1", 1600, 800);
    expect(controller.hasPendingResize("term-1")).toBe(true);
    controller.lockResize("term-1", true);
    controller.lockResize("term-1", false);
    expect(controller.hasPendingResize("term-1")).toBe(false);
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(managed.terminal.cols).toBe(80);

    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;

    // A different pixel box — so the pixel gate lets it through — that lands on
    // the same grid the stranded target already names. Grown to the widest and
    // tallest pixel still inside the same cell rather than hardcoded, so a
    // change to the gutter or cell size cannot quietly move it onto a different
    // grid and stop testing the collision it was written for.
    const [retryWidth, retryHeight] = sameGridBox(1600, 800);
    expect(colsFor(retryWidth)).toBe(colsFor(1600));
    expect(controller.resize("term-1", retryWidth, retryHeight)).toEqual({
      cols: colsFor(1600),
      rows: 40,
    });

    vi.advanceTimersByTime(500);
    expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1600), 40);
    expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);
  });

  it("background-tier convergence supersedes a queued target instead of letting it fire", () => {
    // Deduping on the live grid returns before `applyResize`, and `applyResize`
    // is what used to cancel older queued work on the way past. Without an
    // explicit supersede the dropped job still fires and drags both grids to a
    // box that is no longer the container (#11095).
    const managed = createManagedTerminal();
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: CELL } } } },
    });
    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    // xterm is settled on the 1600px grid; a later 1700px box queued behind it.
    managed.terminal.cols = colsFor(1600);
    managed.terminal.rows = 40;
    managed.latestCols = colsFor(1600);
    managed.latestRows = 40;
    managed.lastWidth = 1600;
    managed.lastHeight = 800;
    controller.resize("term-1", 1700, 800);
    expect(controller.hasPendingResize("term-1")).toBe(true);

    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;

    // Back to a box on the grid xterm already holds — no reflow to do.
    expect(controller.resize("term-1", 1604, 819)).toBeNull();
    expect(managed.latestCols).toBe(colsFor(1604));
    expect(managed.latestRows).toBe(40);

    vi.advanceTimersByTime(500);
    expect(managed.terminal.resize).not.toHaveBeenCalledWith(colsFor(1700), 40);
    expect(resizeMock).not.toHaveBeenCalledWith("term-1", colsFor(1700), 40);
    expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1604), 40);
  });

  it("background-tier resize records a restore target when the replay grid already matches", () => {
    // While a snapshot replays, xterm is parked at the CAPTURE grid, so
    // `terminal.cols` describes the payload rather than the pane. A box that
    // happens to match it has not converged on anything: it still has to reach
    // resizeTerminal to be recorded as the geometry the replay normalizes to
    // when it closes (#11552).
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    managed.isSerializedRestoreInProgress = true;
    managed.pendingRestoreGeometry = { cols: 100, rows: 30 };
    managed.latestCols = 100;
    managed.latestRows = 30;
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: CELL } } } },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    // A box landing on exactly the replay grid, derived from that grid on BOTH
    // axes — a hardcoded pair would keep passing against a naive live-grid
    // guard if the fixture's rows ever stopped matching by accident.
    const parkedCols = managed.terminal.cols;
    const parkedRows = managed.terminal.rows;
    const parkedWidth = SCROLLBAR_PX + parkedCols * CELL.width;
    const parkedHeight = parkedRows * CELL.height;

    expect(controller.resize("term-1", parkedWidth, parkedHeight)).toEqual({
      cols: parkedCols,
      rows: parkedRows,
    });

    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(managed.pendingRestoreGeometry).toEqual({ cols: parkedCols, rows: parkedRows });
    expect(resizeMock).toHaveBeenCalledWith("term-1", parkedCols, parkedRows);
    expect(managed.lastWidth).toBe(parkedWidth);
    expect(managed.lastHeight).toBe(parkedHeight);
  });

  it("background-tier convergence re-asserts a PTY the cache left ahead of the grid", () => {
    // Isolates the cache half of the supersede gate: panel spawn sizes the PTY
    // directly and stamps the target, leaving NO queued work behind it, so
    // `hasPendingResize` cannot carry this case. Finding xterm already correct
    // is not the same as the two halves agreeing.
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: CELL } } } },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.sendPtyResize("term-1", 100, 30);
    expect(controller.hasPendingResize("term-1")).toBe(false);
    resizeMock.mockClear();

    // A sentinel the converged branch must leave alone: no grid moves, so the
    // auto-follow intent recorded with the last real change still stands. The
    // fixture's buffer reads as at-bottom, so an unconditional assignment here
    // would flip this to true.
    managed.latestWasAtBottom = false;

    const liveCols = managed.terminal.cols;
    const liveRows = managed.terminal.rows;
    const result = controller.resize(
      "term-1",
      SCROLLBAR_PX + liveCols * CELL.width,
      liveRows * CELL.height
    );

    expect(result).toBeNull();
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(resizeMock).toHaveBeenCalledWith("term-1", liveCols, liveRows);
    expect(managed.latestCols).toBe(liveCols);
    expect(managed.latestRows).toBe(liveRows);
    expect(managed.latestWasAtBottom).toBe(false);
  });

  it("a stale background tier does not divert a visible terminal off the measured path", () => {
    // A freshly prewarmed terminal carries lastAppliedTier === BACKGROUND until
    // applyRendererPolicy promotes it, but it can already be attached and
    // visible on screen. Both branches now move xterm and the PTY together, so
    // the difference this guards is what happens when cell metrics are absent:
    // the measured path falls back to fitAddon.proposeDimensions(), while the
    // hidden branch has no fallback and bails with null (asserted directly by
    // "background-tier resize returns null when cell dims are unavailable").
    // Withholding _core is therefore what makes this test able to tell the two
    // branches apart at all. Regression guard for the two-pane split
    // second-panel sizing bug.
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = true;
    // No _core: cell metrics are unavailable, so only the measured path can
    // produce a grid here.
    const proposal = { cols: 137, rows: 42 };
    managed.fitAddon.proposeDimensions = vi.fn(() => proposal);

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    const result = controller.resize("term-1", 1600, 800, { immediate: true });
    // Had the stale BACKGROUND tier diverted this to the hidden branch, the
    // missing cell metrics would have produced null and touched nothing.
    expect(result).toEqual(proposal);
    expect(managed.fitAddon.proposeDimensions).toHaveBeenCalled();
    expect(managed.terminal.resize).toHaveBeenCalledWith(proposal.cols, proposal.rows);
    expect(resizeMock).toHaveBeenCalledWith("term-1", proposal.cols, proposal.rows);
  });

  it("flushes and resets ingest buffers before applying resize", () => {
    const managed = createManagedTerminal();
    const flushForTerminal = vi.fn();
    const resetForTerminal = vi.fn();
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal,
        resetForTerminal,
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.applyResize("term-1", 132, 41);

    expect(flushForTerminal).toHaveBeenCalledWith("term-1");
    expect(resetForTerminal).toHaveBeenCalledWith("term-1");
    expect(managed.terminal.resize).toHaveBeenCalledWith(132, 41);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 132, 41);
    // A bottom-following pane (latestWasAtBottom && !isUserScrolledBack) is
    // re-pinned after the commit — the shared pin the reveal path now mirrors
    // (#11316).
    expect(managed.terminal.scrollToBottom).toHaveBeenCalledOnce();
  });

  describe("pre-resize flush budget", () => {
    function makeBudgetDeps(queuedBytes: number) {
      return {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => queuedBytes),
        resumeFlush: vi.fn(),
      };
    }

    it("flushes and resets when held bytes are at the budget", () => {
      const managed = createManagedTerminal();
      const dataBuffer = makeBudgetDeps(RESIZE_FLUSH_SYNC_BUDGET_BYTES);
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: dataBuffer as any,
      });

      controller.applyResize("term-1", 132, 41);

      expect(dataBuffer.flushForTerminal).toHaveBeenCalledWith("term-1");
      expect(dataBuffer.resetForTerminal).toHaveBeenCalledWith("term-1");
      expect(dataBuffer.resumeFlush).not.toHaveBeenCalled();
      expect(managed.terminal.resize).toHaveBeenCalledWith(132, 41);
    });

    it("skips the flush AND the reset past the budget, still resizes, then resumes the watermarked drain", () => {
      // A queue-deleting reset without the flush would drop the held output —
      // the skip path must leave the backlog queued for resumeFlush.
      const managed = createManagedTerminal();
      const dataBuffer = makeBudgetDeps(RESIZE_FLUSH_SYNC_BUDGET_BYTES + 1);
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: dataBuffer as any,
      });

      controller.applyResize("term-1", 132, 41);

      expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
      expect(dataBuffer.resetForTerminal).not.toHaveBeenCalled();
      expect(managed.terminal.resize).toHaveBeenCalledWith(132, 41);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 132, 41);
      expect(dataBuffer.resumeFlush).toHaveBeenCalledWith("term-1");
    });

    it("resumes the drain on the skip path even when the xterm resize is settled-deferred", () => {
      const managed = createManagedTerminal();
      managed.launchAgentId = "codex";
      managed.runtimeAgentId = "codex";
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });
      const dataBuffer = makeBudgetDeps(RESIZE_FLUSH_SYNC_BUDGET_BYTES + 1);
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: dataBuffer as any,
      });

      controller.applyResize("term-1", 132, 41);

      // Oversized ingest keeps draining at the still-consistent outgoing grid.
      expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
      expect(dataBuffer.resumeFlush).toHaveBeenCalledWith("term-1");
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledWith(132, 41);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 132, 41);
      expect(dataBuffer.resumeFlush).toHaveBeenCalledTimes(2);
    });

    it("applies the budget on the debounced resize path", () => {
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      const dataBuffer = makeBudgetDeps(RESIZE_FLUSH_SYNC_BUDGET_BYTES + 1);
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: dataBuffer as any,
      });

      // Unfocused + visible + deep buffer → resize() takes the debounce path
      // instead of applyResize.
      managed.isFocused = false;
      managed.terminal.buffer.active.length = 5000;
      controller.resize("term-1", 1600, 800);
      vi.advanceTimersByTime(200);

      expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
      expect(dataBuffer.resetForTerminal).not.toHaveBeenCalled();
      expect(managed.terminal.resize).toHaveBeenCalled();
      expect(dataBuffer.resumeFlush).toHaveBeenCalledWith("term-1");
    });

    it("commits a debounced settled resize in flush, xterm, PTY order", () => {
      const managed = createManagedTerminal();
      managed.runtimeAgentId = "codex";
      managed.isFocused = false;
      managed.terminal.buffer.active.length = 5000;
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: CELL } } } },
      });
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });
      const sequence: string[] = [];
      managed.terminal.resize.mockImplementation(function (
        this: { cols: number; rows: number },
        cols: number,
        rows: number
      ) {
        sequence.push("xterm");
        this.cols = cols;
        this.rows = rows;
      });
      resizeMock.mockImplementation(() => sequence.push("pty"));
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: {
          flushForTerminal: vi.fn(() => sequence.push("flush")),
          resetForTerminal: vi.fn(() => sequence.push("reset")),
          getQueuedBytes: vi.fn(() => 0),
          resumeFlush: vi.fn(() => sequence.push("resume")),
        } as unknown as ResizeControllerDeps["dataBuffer"],
      });

      controller.resize("term-1", 1600, 800);
      vi.advanceTimersByTime(599);
      expect(sequence).toEqual(["flush", "reset"]);

      vi.advanceTimersByTime(1);
      expect(sequence).toEqual(["flush", "reset", "flush", "reset", "xterm", "pty"]);
    });
  });

  it("lockResize with custom TTL expires after specified duration", () => {
    const managed = createManagedTerminal();
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.lockResize("term-1", true, 300);
    expect(controller.isResizeLocked("term-1")).toBe(true);

    vi.advanceTimersByTime(200);
    expect(controller.isResizeLocked("term-1")).toBe(true);

    vi.advanceTimersByTime(200);
    expect(controller.isResizeLocked("term-1")).toBe(false);
  });

  it("later lockResize call overwrites earlier TTL", () => {
    const managed = createManagedTerminal();
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.lockResize("term-1", true, 500);
    controller.lockResize("term-1", true, 200);

    vi.advanceTimersByTime(300);
    expect(controller.isResizeLocked("term-1")).toBe(false);
  });

  it("does not apply deferred resize while resize lock is active", () => {
    const managed = createManagedTerminal();
    managed.latestCols = 120;
    managed.latestRows = 40;

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.lockResize("term-1", true);
    controller.applyDeferredResize("term-1");

    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(resizeMock).not.toHaveBeenCalled();
    // No resize happened → no pin (#11316).
    expect(managed.terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("applyDeferredResize defers a grid change on a streaming main-buffer pane to the watchdog (#10863 choke point)", () => {
    const managed = createManagedTerminal();
    managed.latestCols = 120;
    managed.latestRows = 40;
    managed.pendingWrites = 2; // a queued batch is still parsing — mid-stream
    managed.attachGeneration = 7;

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.applyDeferredResize("term-1");

    // The grid-changing resync must NOT re-wrap the streaming buffer; the
    // obligation goes to the reconciliation watchdog instead.
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(resizeMock).not.toHaveBeenCalled();
    expect(managed.revealPendingRepair).toBe(true);
    expect(managed.revealPendingGeneration).toBe(7);
    // The resize was deferred to the watchdog → the pin must not fire here
    // either (#11316).
    expect(managed.terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("applyDeferredResize still applies a grid change on a streaming ALT-buffer pane (alt exempt from the re-wrap hazard)", () => {
    const managed = createManagedTerminal();
    managed.latestCols = 120;
    managed.latestRows = 40;
    managed.pendingWrites = 2;
    managed.isAltBuffer = true;

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.applyDeferredResize("term-1");

    expect(managed.terminal.resize).toHaveBeenCalledWith(120, 40);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 120, 40);
    expect(managed.revealPendingRepair).toBeUndefined();
    // applyDeferredResize does resize alt buffers, so the shared pin runs here
    // too — intentionally mirroring commitResize (a real alt buffer has no
    // scrollback, so scrollToBottom is a no-op). reconcileGeometryFresh differs:
    // it exits above the pin for alt. Locking the asymmetry (#11316).
    expect(managed.terminal.scrollToBottom).toHaveBeenCalledOnce();
  });

  it("applyDeferredResize is a no-op when xterm dims already match latest", () => {
    const managed = createManagedTerminal();
    managed.terminal.cols = 120;
    managed.terminal.rows = 40;
    managed.latestCols = 120;
    managed.latestRows = 40;

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.applyDeferredResize("term-1");

    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(resizeMock).not.toHaveBeenCalled();
    // Cache-match early return → no resize, no pin (#11316).
    expect(managed.terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("applyDeferredResize syncs xterm and PTY atomically for settled-strategy agents", () => {
    const managed = createManagedTerminal();
    managed.terminal.cols = 80;
    managed.terminal.rows = 24;
    managed.latestCols = 160;
    managed.latestRows = 40;
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";

    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.applyDeferredResize("term-1");

    // Wake-path resync must NOT split xterm and PTY across the 500ms settled
    // window — both must fire synchronously so refresh paints a coherent grid.
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(managed.terminal.resize).toHaveBeenCalledWith(160, 40);
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 160, 40);

    // Advancing past the settled delay must not produce a spurious second resize.
    vi.advanceTimersByTime(500);
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledTimes(1);
    // The wake-path resize re-pins a bottom-following pane — the reveal-path gap
    // this fix closes (#11316: a reflow shifts the viewport off-bottom without
    // firing onScroll, so the deferred resize must restore the bottom).
    expect(managed.terminal.scrollToBottom).toHaveBeenCalledOnce();
  });

  it("applyDeferredResize preserves a deliberately user-scrolled viewport", () => {
    const managed = createManagedTerminal();
    managed.terminal.cols = 80;
    managed.terminal.rows = 24;
    managed.latestCols = 160;
    managed.latestRows = 40;
    // The user scrolled up before hiding — the reveal-path resize must reflow
    // but NEVER yank the viewport back to the bottom (#11316).
    managed.isUserScrolledBack = true;

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.applyDeferredResize("term-1");

    expect(managed.terminal.resize).toHaveBeenCalledWith(160, 40);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 160, 40);
    expect(managed.terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("applyDeferredResize does not pin when the pane was not following the bottom", () => {
    const managed = createManagedTerminal();
    managed.terminal.cols = 80;
    managed.terminal.rows = 24;
    managed.latestCols = 160;
    managed.latestRows = 40;
    // Auto-follow was already off before the hide (latestWasAtBottom captured
    // false), and the user has not scrolled back — the pin's OTHER predicate.
    // Guards against the helper degenerating to `if (!isUserScrolledBack)`, which
    // every other test would still pass (#11316).
    managed.latestWasAtBottom = false;
    managed.isUserScrolledBack = false;

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.applyDeferredResize("term-1");

    expect(managed.terminal.resize).toHaveBeenCalledWith(160, 40);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 160, 40);
    expect(managed.terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("applyDeferredResize cancels a pending settled timer before atomic resync", () => {
    const managed = createManagedTerminal();
    managed.terminal.cols = 80;
    managed.terminal.rows = 24;
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    // A resize observed while the pane is genuinely hidden arms the settled
    // timer. isVisible must be false too, or this takes the measured path and
    // never exercises the hidden branch the comment claims.
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    controller.resize("term-1", 1200, 700);
    expect(resizeMock).not.toHaveBeenCalled();
    expect(managed.terminal.resize).not.toHaveBeenCalled();

    // Wake fires applyDeferredResize before the timer would have run: the
    // reveal owns the commit, and the superseded timer must not fire behind it.
    managed.lastAppliedTier = TerminalRefreshTier.FOCUSED;
    managed.isFocused = true;
    managed.isVisible = true;
    controller.applyDeferredResize("term-1");

    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledTimes(1);

    // Pending settled timer must have been cancelled — no second fire.
    vi.advanceTimersByTime(500);
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledTimes(1);
  });

  it("does not run fit while resize lock is active", () => {
    const managed = createManagedTerminal();
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.lockResize("term-1", true);
    const result = controller.fit("term-1");

    expect(result).toBeNull();
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
    expect(resizeMock).not.toHaveBeenCalled();
  });

  it("fit() returns null without calling getBoundingClientRect when checkVisibility returns false", () => {
    const managed = createManagedTerminal();
    (managed.hostElement.checkVisibility as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as unknown as ResizeControllerDeps["dataBuffer"],
    });

    const result = controller.fit("term-1");
    expect(result).toBeNull();
    expect(managed.hostElement.getBoundingClientRect).not.toHaveBeenCalled();
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
  });

  it("fit() returns null when visible but dimensions are too small", () => {
    const managed = createManagedTerminal();
    (managed.hostElement.getBoundingClientRect as ReturnType<typeof vi.fn>).mockReturnValue({
      left: 0,
      width: 40,
      height: 30,
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as unknown as ResizeControllerDeps["dataBuffer"],
    });

    const result = controller.fit("term-1");
    expect(result).toBeNull();
    expect(managed.hostElement.checkVisibility).toHaveBeenCalled();
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
  });

  it("fit() succeeds when visible and dimensions are adequate", () => {
    const managed = createManagedTerminal();

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as unknown as ResizeControllerDeps["dataBuffer"],
    });

    const result = controller.fit("term-1");
    expect(result).toEqual({ cols: 100, rows: 30 });
    expect(managed.hostElement.checkVisibility).toHaveBeenCalled();
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
    expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
  });

  it("fit() defers a settled xterm and PTY pair until the same commit", () => {
    const managed = createManagedTerminal();
    managed.runtimeAgentId = "codex";
    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });
    const dataBuffer = {
      flushForTerminal: vi.fn(),
      resetForTerminal: vi.fn(),
      getQueuedBytes: vi.fn(() => 0),
      resumeFlush: vi.fn(),
    } as unknown as ResizeControllerDeps["dataBuffer"];
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer,
    });

    expect(controller.fit("term-1")).toEqual({ cols: 100, rows: 30 });
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(resizeMock).not.toHaveBeenCalled();
    expect(dataBuffer.flushForTerminal).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);

    expect(dataBuffer.flushForTerminal).toHaveBeenCalledTimes(2);
    expect(dataBuffer.flushForTerminal).toHaveBeenCalledWith("term-1");
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
  });

  it("rapid settled fit requests apply only the newest proposal", () => {
    const managed = createManagedTerminal();
    managed.runtimeAgentId = "codex";
    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });
    managed.fitAddon.proposeDimensions
      .mockReturnValueOnce({ cols: 90, rows: 28 })
      .mockReturnValueOnce({ cols: 95, rows: 29 })
      .mockReturnValueOnce({ cols: 105, rows: 31 });
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as unknown as ResizeControllerDeps["dataBuffer"],
    });

    controller.fit("term-1");
    controller.fit("term-1");
    controller.fit("term-1");
    vi.advanceTimersByTime(500);

    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(managed.terminal.resize).toHaveBeenCalledWith(105, 31);
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 105, 31);
  });

  it("settled strategy batches rapid resizes into a single PTY resize", () => {
    const managed = createManagedTerminal();
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";

    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.sendPtyResize("term-1", 100, 30);
    controller.sendPtyResize("term-1", 110, 35);
    controller.sendPtyResize("term-1", 120, 40);

    expect(resizeMock).not.toHaveBeenCalled();
    expect(managed.latestCols).toBe(120);
    expect(managed.latestRows).toBe(40);

    vi.advanceTimersByTime(500);

    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 120, 40);
    expect(managed.terminal.write).not.toHaveBeenCalled();
  });

  it("default strategy sends PTY resize immediately", () => {
    const managed = createManagedTerminal();
    managed.launchAgentId = "claude";
    managed.runtimeAgentId = "claude";

    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "default" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.sendPtyResize("term-1", 100, 30);

    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
  });

  it("clearSettledTimer cancels a pending settled resize", () => {
    const managed = createManagedTerminal();
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";

    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as any,
    });

    controller.sendPtyResize("term-1", 120, 40);
    expect(resizeMock).not.toHaveBeenCalled();

    controller.clearSettledTimer("term-1");
    vi.advanceTimersByTime(500);

    expect(resizeMock).not.toHaveBeenCalled();
  });

  it("a resize lock cancels a pending settled xterm and PTY commit", () => {
    const managed = createManagedTerminal();
    managed.runtimeAgentId = "codex";
    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as unknown as ResizeControllerDeps["dataBuffer"],
    });

    controller.applyResize("term-1", 120, 40);
    expect(controller.hasPendingResize("term-1")).toBe(true);
    controller.lockResize("term-1", true);
    expect(controller.hasPendingResize("term-1")).toBe(false);
    vi.advanceTimersByTime(500);

    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(resizeMock).not.toHaveBeenCalled();
  });

  it("forceImmediateResize sends an immediate resize and cancels pending settled timer", () => {
    const managed = createManagedTerminal();
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";
    managed.latestCols = 132;
    managed.latestRows = 41;
    const dataBuffer = {
      flushForTerminal: vi.fn(),
      resetForTerminal: vi.fn(),
      getQueuedBytes: vi.fn(() => 0),
      resumeFlush: vi.fn(),
    } as unknown as ResizeControllerDeps["dataBuffer"];

    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer,
    });

    controller.sendPtyResize("term-1", 100, 30);
    expect(resizeMock).not.toHaveBeenCalled();
    managed.latestCols = 132;
    managed.latestRows = 41;

    controller.forceImmediateResize("term-1");
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 132, 41);

    vi.advanceTimersByTime(500);
    expect(resizeMock).toHaveBeenCalledTimes(1);
  });

  it("forceImmediateResize skips invalid terminal dimensions", () => {
    const managed = createManagedTerminal();
    managed.latestCols = 0;
    managed.latestRows = 24;
    const dataBuffer = {
      flushForTerminal: vi.fn(),
      resetForTerminal: vi.fn(),
      getQueuedBytes: vi.fn(() => 0),
      resumeFlush: vi.fn(),
    } as unknown as ResizeControllerDeps["dataBuffer"];

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer,
    });

    controller.forceImmediateResize("term-1");

    expect(resizeMock).not.toHaveBeenCalled();
  });

  it("public PTY resize helpers do not bypass an active resize lock", () => {
    const managed = createManagedTerminal();
    managed.latestCols = 120;
    managed.latestRows = 40;
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as unknown as ResizeControllerDeps["dataBuffer"],
    });

    controller.lockResize("term-1", true);
    controller.sendPtyResize("term-1", 120, 40);
    controller.forceImmediateResize("term-1");

    expect(resizeMock).not.toHaveBeenCalled();
  });

  describe("getXtermCellDimensions", () => {
    function fakeTerminal(core?: unknown) {
      const t = {} as Record<string, unknown>;
      if (core !== undefined) t._core = core;
      return t as unknown as import("@xterm/xterm").Terminal;
    }

    it("returns cell dimensions when internal structure is populated", () => {
      const terminal = fakeTerminal({
        _renderService: {
          dimensions: { css: { cell: { width: 8.5, height: 17 } } },
        },
      });

      expect(getXtermCellDimensions(terminal)).toEqual({
        width: 8.5,
        height: 17,
      });
    });

    it("returns null when _core is undefined", () => {
      expect(getXtermCellDimensions(fakeTerminal())).toBeNull();
    });

    it("returns null when _renderService is undefined", () => {
      expect(getXtermCellDimensions(fakeTerminal({}))).toBeNull();
    });

    it("returns null when cell dimensions have non-number values", () => {
      const terminal = fakeTerminal({
        _renderService: {
          dimensions: {
            css: { cell: { width: "bad", height: "data" } },
          },
        },
      });

      expect(getXtermCellDimensions(terminal)).toBeNull();
    });

    it("returns null when accessing _core throws", () => {
      const terminal = {} as Record<string, unknown>;
      Object.defineProperty(terminal, "_core", {
        get() {
          throw new Error("exploded");
        },
      });

      expect(
        getXtermCellDimensions(terminal as unknown as import("@xterm/xterm").Terminal)
      ).toBeNull();
    });

    it("returns null for NaN dimensions", () => {
      expect(
        getXtermCellDimensions(
          fakeTerminal({
            _renderService: { dimensions: { css: { cell: { width: NaN, height: 17 } } } },
          })
        )
      ).toBeNull();
    });

    it("returns null for negative dimensions", () => {
      expect(
        getXtermCellDimensions(
          fakeTerminal({
            _renderService: { dimensions: { css: { cell: { width: 8, height: -1 } } } },
          })
        )
      ).toBeNull();
    });

    it("returns null for Infinity dimensions", () => {
      expect(
        getXtermCellDimensions(
          fakeTerminal({
            _renderService: { dimensions: { css: { cell: { width: Infinity, height: 17 } } } },
          })
        )
      ).toBeNull();
    });

    it("returns null when intermediate levels are null", () => {
      expect(
        getXtermCellDimensions(
          fakeTerminal({
            _renderService: { dimensions: { css: null } },
          })
        )
      ).toBeNull();
      expect(
        getXtermCellDimensions(
          fakeTerminal({
            _renderService: { dimensions: null },
          })
        )
      ).toBeNull();
    });
  });

  describe("scheduleIdleResize and clearResizeJob", () => {
    function mockDataBuffer(): ResizeControllerDeps["dataBuffer"] {
      return {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as unknown as ResizeControllerDeps["dataBuffer"];
    }

    function attachCellDims(
      managed: ReturnType<typeof createManagedTerminal>,
      cell: { width: number; height: number } = { width: 10, height: 20 }
    ) {
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell } } } },
      });
    }

    it("scheduleIdleResize stores an AbortController on managed.resizeJob", () => {
      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 900);

      expect(managed.resizeJob).toBeInstanceOf(AbortController);
      expect((global as any).scheduler.postTask).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ priority: "background" })
      );
    });

    it("clearResizeJob aborts the AbortController and prevents the task from running", async () => {
      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;

      const dataBuffer = mockDataBuffer();
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer,
      });

      controller.resize("term-1", 1200, 900);

      const abortController = managed.resizeJob as AbortController;
      expect(abortController).toBeInstanceOf(AbortController);
      expect(abortController.signal.aborted).toBe(false);

      controller.clearResizeJob(managed);

      expect(abortController.signal.aborted).toBe(true);
      expect(managed.resizeJob).toBeUndefined();

      // Task in queue should not run since signal is aborted
      await flushPostTasks();
      expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
      expect(managed.terminal.resize).not.toHaveBeenCalled();
    });

    it("flushResize applies resize when resizeJob is pending", async () => {
      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;
      managed.latestCols = 100;
      managed.latestRows = 30;

      const dataBuffer = mockDataBuffer();
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer,
      });

      controller.resize("term-1", 1200, 900);
      expect(managed.resizeJob).toBeInstanceOf(AbortController);

      controller.flushResize("term-1");

      expect(managed.resizeJob).toBeUndefined();
      expect(dataBuffer.flushForTerminal).toHaveBeenCalled();
      expect(dataBuffer.resetForTerminal).toHaveBeenCalled();
    });

    it("flushResize applies resize when resizeDebounceTimer is pending", () => {
      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = true;
      managed.terminal.buffer.active.length = 300;
      managed.latestCols = 100;
      managed.latestRows = 30;

      const dataBuffer = mockDataBuffer();
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer,
      });

      controller.resize("term-1", 1200, 900);
      expect(managed.resizeDebounceTimer).toBeDefined();

      controller.flushResize("term-1");

      expect(managed.resizeDebounceTimer).toBeUndefined();
      expect(dataBuffer.flushForTerminal).toHaveBeenCalled();
    });

    it("flushResize immediately commits a pending settled xterm and PTY pair", () => {
      const managed = createManagedTerminal();
      managed.runtimeAgentId = "codex";
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.applyResize("term-1", 120, 40);
      expect(controller.hasPendingResize("term-1")).toBe(true);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();

      controller.flushResize("term-1");

      expect(controller.hasPendingResize("term-1")).toBe(false);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(managed.terminal.resize).toHaveBeenCalledWith(120, 40);
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 120, 40);
      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledTimes(1);
    });

    it("flushResize commits a pending background-tier settled pair atomically", () => {
      // Draining the settled timer early must not resurrect the PTY-only split:
      // a flushed request carries the same paired commit the timer would have
      // run, just sooner.
      const managed = createManagedTerminal();
      managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      managed.isFocused = false;
      managed.isVisible = false;
      managed.runtimeAgentId = "codex";
      attachCellDims(managed);
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      const order: string[] = [];
      managed.terminal.resize.mockImplementationOnce(function (
        this: { cols: number; rows: number },
        cols: number,
        rows: number
      ) {
        order.push("xterm");
        this.cols = cols;
        this.rows = rows;
      });
      resizeMock.mockImplementationOnce(() => {
        order.push("pty");
      });

      controller.resize("term-1", 1200, 800);
      expect(controller.hasPendingResize("term-1")).toBe(true);
      expect(order).toEqual([]);

      controller.flushResize("term-1");

      expect(controller.hasPendingResize("term-1")).toBe(false);
      expect(order).toEqual(["xterm", "pty"]);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1200), 40);
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1200), 40);

      // The drained timer must not fire a second commit behind the flush.
      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledTimes(1);
    });

    it("cancelPendingResize drops a pending settled commit", () => {
      const managed = createManagedTerminal();
      managed.runtimeAgentId = "codex";
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.applyResize("term-1", 120, 40);
      controller.cancelPendingResize("term-1");
      vi.advanceTimersByTime(500);

      expect(controller.hasPendingResize("term-1")).toBe(false);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("a direct default PTY target supersedes an older debounce job", () => {
      const managed = createManagedTerminal();
      managed.isFocused = false;
      managed.terminal.buffer.active.length = 300;
      attachCellDims(managed);
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 800);
      expect(managed.resizeDebounceTimer).toBeDefined();
      controller.sendPtyResize("term-1", 140, 45);
      vi.advanceTimersByTime(100);

      expect(managed.resizeDebounceTimer).toBeUndefined();
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 140, 45);
    });

    it("a direct settled target supersedes an older debounce job", () => {
      const managed = createManagedTerminal();
      managed.runtimeAgentId = "codex";
      managed.isFocused = false;
      managed.terminal.buffer.active.length = 300;
      attachCellDims(managed);
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 800);
      controller.sendPtyResize("term-1", 140, 45);
      vi.advanceTimersByTime(499);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(managed.terminal.resize).toHaveBeenCalledWith(140, 45);
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 140, 45);
    });

    it("a background target supersedes an older debounce job and lands exactly once", () => {
      const managed = createManagedTerminal();
      managed.isFocused = false;
      managed.terminal.buffer.active.length = 300;
      attachCellDims(managed);
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 800);
      controller.applyBackgroundResize("term-1", 1500, 800);
      vi.advanceTimersByTime(100);

      // The superseded 1200px job must not fire afterwards: both grids sit at
      // the newer target, applied once.
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1500), 40);
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1500), 40);
    });

    it("forceImmediateResize supersedes an older debounce job", () => {
      const managed = createManagedTerminal();
      managed.isFocused = false;
      managed.terminal.buffer.active.length = 300;
      attachCellDims(managed);
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 800);
      managed.latestCols = 140;
      managed.latestRows = 45;
      controller.forceImmediateResize("term-1");
      vi.advanceTimersByTime(100);

      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 140, 45);
    });

    it("debounceResize stores timer in resizeDebounceTimer, not resizeJob", () => {
      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = true;
      managed.terminal.buffer.active.length = 300;

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 900);

      expect(managed.resizeJob).toBeUndefined();
      expect(managed.resizeDebounceTimer).toBeDefined();
    });

    it("scheduleIdleResize falls back to setTimeout when scheduler is unavailable", () => {
      (global as any).scheduler = undefined;

      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 900);

      expect(managed.resizeJob).toBeUndefined();
      expect(managed.resizeDebounceTimer).toBeDefined();
    });

    it("scheduleIdleResize does not queue a second timer when fallback timer already pending", () => {
      (global as any).scheduler = undefined;

      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 900);
      const firstTimerCount = setTimeoutSpy.mock.calls.length;

      // Second resize while timer pending — should not queue another timer
      controller.resize("term-1", 1300, 950);
      expect(setTimeoutSpy.mock.calls.length).toBe(firstTimerCount);
    });

    it("postTask callback applies resize and clears resizeJob", async () => {
      const managed = createManagedTerminal();
      // width:10, height:20 → (1200-15)/10 = 118 cols (scrollbar reserved), 900/20 = 45 rows
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;

      const dataBuffer = mockDataBuffer();
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer,
      });

      controller.resize("term-1", 1200, 900);
      expect(managed.resizeJob).toBeInstanceOf(AbortController);

      await flushPostTasks();

      expect(managed.resizeJob).toBeUndefined();
      expect(dataBuffer.flushForTerminal).toHaveBeenCalledWith("term-1");
      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1200), 45);
    });
  });

  describe("resize cell-dimension paths", () => {
    function mockDataBuffer(): ResizeControllerDeps["dataBuffer"] {
      return {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as unknown as ResizeControllerDeps["dataBuffer"];
    }

    function attachCellDims(
      managed: ReturnType<typeof createManagedTerminal>,
      cell: { width: number; height: number }
    ) {
      Object.assign(managed.terminal, {
        _core: {
          _renderService: { dimensions: { css: { cell } } },
        },
      });
    }

    it("computes cols/rows from cell dims without calling fitAddon.fit()", () => {
      const managed = createManagedTerminal();
      attachCellDims(managed, { width: 10, height: 20 });

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      const result = controller.resize("term-1", 1000, 500);

      expect(result).toEqual({ cols: colsFor(1000), rows: 25 });
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1000), 25);
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1000), 25);
    });

    it("uses FitAddon's proposal when cell dims are null", () => {
      const managed = createManagedTerminal();

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      const result = controller.resize("term-1", 1200, 900);

      expect(result).toEqual({ cols: 100, rows: 30 });
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
    });

    it("uses FitAddon's proposal when cell dims are zero", () => {
      const managed = createManagedTerminal();
      attachCellDims(managed, { width: 0, height: 0 });

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      const result = controller.resize("term-1", 1200, 900);

      expect(result).toEqual({ cols: 100, rows: 30 });
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
    });

    it("returns null without mutating cache when proposeDimensions returns undefined", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions.mockReturnValue(undefined);

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      const result = controller.resize("term-1", 1200, 900);

      expect(result).toBeNull();
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.lastWidth).toBe(800);
      expect(managed.lastHeight).toBe(600);
    });

    it("does not suppress later resize after proposeDimensions initially returns undefined", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions.mockReturnValue(undefined);

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      // First call: proposeDimensions undefined → null, cache unchanged
      const result1 = controller.resize("term-1", 1200, 900);
      expect(result1).toBeNull();
      expect(managed.lastWidth).toBe(800);
      expect(managed.lastHeight).toBe(600);

      // Second call: proposeDimensions now returns valid result
      managed.fitAddon.proposeDimensions.mockReturnValue({ cols: 120, rows: 45 });
      const result2 = controller.resize("term-1", 1200, 900);

      // Should NOT be suppressed by dedup guard since lastWidth was never updated
      expect(result2).not.toBeNull();
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      expect(managed.terminal.resize).toHaveBeenCalledWith(120, 45);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 120, 45);
    });

    it("returns null when proposeDimensions returns degenerate 1x1", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions.mockReturnValue({ cols: 1, rows: 1 });

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      const result = controller.resize("term-1", 1200, 900);

      expect(result).toBeNull();
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
    });
  });

  /**
   * A pixel box small enough to be a transient rather than layout used to
   * succeed rather than fail: the column and row math floors at FitAddon's own
   * 2x1, so a few-pixel box produced a valid-looking grid and both halves
   * adopted it. A cached pane parses every byte through that, and xterm re-wraps
   * committed scrollback to two columns on the way — damage no later reflow
   * undoes, leaving the history a vertical strip until it scrolls away (#11900).
   *
   * `applyBackgroundWindowResize` generates exactly that box: it scales every
   * pane's origin by the ratio of Main's forwarded content bounds, so one
   * transient near-zero bound during a minimize or view detach shrinks every
   * backgrounded terminal at once.
   *
   * The guards sit at the entry points rather than at the shared cached-metrics
   * helper alone, which is what the last two cases here pin down: by the time
   * that helper runs, `applyBackgroundResize` has already cancelled queued work,
   * and `resize`'s measured branch never reaches it at all.
   */
  describe("minimum viable resize box (#11900)", () => {
    function mockDataBuffer(): ResizeControllerDeps["dataBuffer"] {
      return {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 0),
        resumeFlush: vi.fn(),
      } as unknown as ResizeControllerDeps["dataBuffer"];
    }

    function attachCellDims(managed: ReturnType<typeof createManagedTerminal>) {
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: CELL } } } },
      });
    }

    function makeController(managed: ReturnType<typeof createManagedTerminal>) {
      return new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });
    }

    /**
     * The four fields a rejected box must leave alone. Captured from the fixture
     * and compared to itself rather than asserted against literals, so the seed
     * values stay the fixture's business.
     */
    const geometryOf = (managed: ReturnType<typeof createManagedTerminal>) => ({
      lastWidth: managed.lastWidth,
      lastHeight: managed.lastHeight,
      latestCols: managed.latestCols,
      latestRows: managed.latestRows,
    });

    it("refuses a sub-viable box on the cached-metrics branch without moving either grid", () => {
      const managed = createManagedTerminal();
      managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      managed.isFocused = false;
      managed.isVisible = false;
      attachCellDims(managed);
      const controller = makeController(managed);
      const before = geometryOf(managed);

      expect(controller.resize("term-1", 5, 5)).toBeNull();
      // Either axis alone is enough to disqualify the box.
      expect(controller.resize("term-1", 1600, 5)).toBeNull();
      expect(controller.resize("term-1", 5, 800)).toBeNull();

      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(geometryOf(managed)).toEqual(before);
    });

    it("refuses a sub-viable box on the measured branch a cached view's stale isVisible routes it down", () => {
      // A backgrounded project view leaves `isVisible` true from before the
      // detach, so the tier is BACKGROUND but the branch taken is the measured
      // one — which never touches the cached-metrics helper. Reverting only
      // `resize`'s own guard fails this test while the helper backstop remains.
      const managed = createManagedTerminal();
      managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      managed.isFocused = false;
      managed.isVisible = true;
      attachCellDims(managed);
      const controller = makeController(managed);
      const before = geometryOf(managed);

      expect(controller.resize("term-1", 5, 5)).toBeNull();

      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(managed.fitAddon.proposeDimensions).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(geometryOf(managed)).toEqual(before);
    });

    it("applies the next viable box after refusing a sub-viable one", () => {
      // Refusal must not stamp the box into the pixel cache: the dedup gate
      // compares against it, so a poisoned cache would swallow the recovery
      // measurement that arrives when real layout returns.
      const managed = createManagedTerminal();
      attachCellDims(managed);
      const controller = makeController(managed);

      expect(controller.resize("term-1", 5, 5)).toBeNull();
      expect(controller.resize("term-1", 1200, 700)).toEqual({ cols: colsFor(1200), rows: 35 });

      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1200), 35);
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1200), 35);
    });

    it("refuses a sub-viable background box without cancelling queued foreground work", () => {
      // `applyBackgroundResize` cancels pending work before it derives a grid,
      // so a guard placed in the shared helper instead of at the top would drop
      // this debounced resize on the way to rejecting the box.
      const managed = createManagedTerminal();
      managed.isFocused = false;
      managed.terminal.buffer.active.length = 300;
      attachCellDims(managed);
      const controller = makeController(managed);

      controller.resize("term-1", 1200, 800);
      expect(controller.applyBackgroundResize("term-1", 5, 5)).toBeNull();
      vi.advanceTimersByTime(100);

      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1200), 40);
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1200), 40);
    });

    it("refuses a sub-viable background box without overwriting a stashed viable one", () => {
      // Same ordering requirement one branch over: the lock stash is written
      // before the grid is derived, so a late guard would replace real geometry
      // with the transient and replay it on unlock.
      const managed = createManagedTerminal();
      managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      managed.isFocused = false;
      managed.isVisible = false;
      attachCellDims(managed);
      const controller = makeController(managed);

      controller.lockResize("term-1", true);
      controller.applyBackgroundResize("term-1", 1600, 800);
      expect(controller.applyBackgroundResize("term-1", 5, 5)).toBeNull();
      expect(managed.pendingBackgroundResize).toEqual({ width: 1600, height: 800 });

      controller.lockResize("term-1", false);

      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);
    });
  });

  describe("applyBackgroundResize", () => {
    function makeController(managed: ReturnType<typeof createManagedTerminal> | undefined) {
      return new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: {
          flushForTerminal: vi.fn(),
          resetForTerminal: vi.fn(),
          getQueuedBytes: vi.fn(() => 0),
          resumeFlush: vi.fn(),
        } as any,
      });
    }

    it("moves xterm and the PTY to the same grid, xterm first", () => {
      // The grids must never disagree while the view is cached: bytes keep
      // being written, so a PTY-only resize would land the app's
      // cursor-addressed output on the wrong rows (#11443). Ordering matters
      // too — SIGWINCH must not reach the app for a grid the parser hasn't
      // adopted. No DOM measurement is involved; a detached view has none.
      const managed = createManagedTerminal();
      managed.isFocused = true;
      managed.isVisible = true;
      managed.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });

      const order: string[] = [];
      vi.mocked(managed.terminal.resize).mockImplementation(() => {
        order.push("xterm");
      });
      resizeMock.mockImplementation(() => {
        order.push("pty");
      });

      const controller = makeController(managed);
      const result = controller.applyBackgroundResize("term-1", 1600, 800);

      expect(result).toEqual({ cols: colsFor(1600), rows: 40 });
      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1600), 40);
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);
      expect(order).toEqual(["xterm", "pty"]);
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      expect(managed.latestCols).toBe(colsFor(1600));
      expect(managed.latestRows).toBe(40);
      expect(managed.lastWidth).toBe(1600);
      expect(managed.lastHeight).toBe(800);
    });

    it("refuses an alt-screen pane outright, leaving both grids untouched", () => {
      const managed = createManagedTerminal();
      managed.isAltBuffer = true;
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });

      const controller = makeController(managed);

      expect(controller.applyBackgroundResize("term-1", 1600, 800)).toBeNull();
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.lastWidth).toBe(800);
      expect(managed.lastHeight).toBe(600);
    });

    it("drops a lock-stashed resize when the pane entered the alternate screen meanwhile", () => {
      // The stash outlives the buffer-mode change, so re-checking only at the
      // caller would replay a resize onto a live TUI at unlock (#11443).
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      const controller = makeController(managed);

      controller.lockResize("term-1", true);
      expect(controller.applyBackgroundResize("term-1", 1600, 800)).toBeNull();
      expect(managed.pendingBackgroundResize).toEqual({ width: 1600, height: 800 });

      managed.isAltBuffer = true;
      controller.lockResize("term-1", false);

      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.pendingBackgroundResize).toBeUndefined();
    });

    it("replays a lock-stashed resize for a pane still on the main buffer", () => {
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      const controller = makeController(managed);

      controller.lockResize("term-1", true);
      controller.applyBackgroundResize("term-1", 1600, 800);
      controller.lockResize("term-1", false);

      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1600), 40);
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);
    });

    it("returns null for a missing instance", () => {
      const controller = makeController(undefined);
      expect(controller.applyBackgroundResize("term-1", 1600, 800)).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("respects an active resize lock", () => {
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      const controller = makeController(managed);
      controller.lockResize("term-1", true);

      expect(controller.applyBackgroundResize("term-1", 1600, 800)).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("dedups when pixel dimensions are unchanged", () => {
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      const controller = makeController(managed);

      controller.applyBackgroundResize("term-1", 1600, 800);
      expect(resizeMock).toHaveBeenCalledTimes(1);

      expect(controller.applyBackgroundResize("term-1", 1600, 800)).toBeNull();
      expect(resizeMock).toHaveBeenCalledTimes(1);
    });

    it("commits a cancelled settled target to both grids when the box is redundant", () => {
      // latestCols/latestRows here describe the target the cancelled settled job
      // was going to apply, NOT the grid xterm currently holds — it is still at
      // the pre-resize size. Reasserting only the PTY half would background the
      // pane into exactly the split #11628 is about, so the cancelled work is
      // committed rather than discarded.
      const managed = createManagedTerminal();
      managed.launchAgentId = "codex";
      managed.runtimeAgentId = "codex";
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });
      const controller = makeController(managed);

      controller.resize("term-1", 1600, 800);
      expect(controller.hasPendingResize("term-1")).toBe(true);
      expect(resizeMock).not.toHaveBeenCalled();
      // The settled job has not fired, so xterm is still on the old grid.
      expect(managed.terminal.resize).not.toHaveBeenCalled();

      const order: string[] = [];
      managed.terminal.resize.mockImplementationOnce(function (
        this: { cols: number; rows: number },
        cols: number,
        rows: number
      ) {
        order.push("xterm");
        this.cols = cols;
        this.rows = rows;
      });
      resizeMock.mockImplementationOnce(() => {
        order.push("pty");
      });

      expect(controller.applyBackgroundResize("term-1", 1600, 800)).toBeNull();

      expect(controller.hasPendingResize("term-1")).toBe(false);
      expect(order).toEqual(["xterm", "pty"]);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1600), 40);
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);

      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledTimes(1);
    });

    it("updates pixel cache without re-notifying the PTY when cols/rows are unchanged", () => {
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      const controller = makeController(managed);

      controller.applyBackgroundResize("term-1", 1600, 800);
      expect(resizeMock).toHaveBeenCalledTimes(1);

      // Grow the container to the widest pixel that still yields the same column
      // count — under one cell, so cols/rows don't move, but the cache must
      // track the new pixels so the next delta computes against them. Derived
      // from the gutter rather than hardcoded: now that the scrollbar is
      // reserved before the division (#11095), a fixed "+5px" would cross a cell
      // boundary and silently stop testing the dedup path it was written for.
      const subCellWidth = 1600 + (CELL.width - 1 - ((1600 - SCROLLBAR_PX) % CELL.width));
      expect(colsFor(subCellWidth)).toBe(colsFor(1600));

      const second = controller.applyBackgroundResize("term-1", subCellWidth, 800);
      expect(second).toBeNull();
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(managed.lastWidth).toBe(subCellWidth);
    });

    it("returns null without poisoning the dedup cache when cell dims are unavailable", () => {
      const managed = createManagedTerminal();
      const controller = makeController(managed);

      expect(controller.applyBackgroundResize("term-1", 1600, 800)).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.lastWidth).toBe(800);
      expect(managed.lastHeight).toBe(600);
    });

    it("rejects degenerate pixel dimensions without touching state", () => {
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      const controller = makeController(managed);

      expect(controller.applyBackgroundResize("term-1", Number.NaN, 800)).toBeNull();
      expect(controller.applyBackgroundResize("term-1", 1600, Number.POSITIVE_INFINITY)).toBeNull();
      expect(controller.applyBackgroundResize("term-1", 0, 800)).toBeNull();
      expect(controller.applyBackgroundResize("term-1", -100, 800)).toBeNull();
      // Positive but far too small to be layout: the column math floors at 2, so
      // this used to resize both grids to a 2-column strip rather than fail
      // (#11900).
      expect(controller.applyBackgroundResize("term-1", 5, 5)).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.lastWidth).toBe(800);
      expect(managed.latestCols).toBe(80);
    });

    it("delivers an atomic xterm and PTY resize immediately for settled-strategy agents", () => {
      const managed = createManagedTerminal();
      managed.launchAgentId = "codex";
      managed.runtimeAgentId = "codex";
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });

      const controller = makeController(managed);
      const result = controller.applyBackgroundResize("term-1", 1600, 800);

      expect(result).toEqual({ cols: colsFor(1600), rows: 40 });
      // Direct delivery — not deferred behind the settled 500ms timer, whose
      // whole purpose (coalescing a live drag) is moot for a burst Main has
      // already debounced to resize-end.
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);

      // Nothing lands a second time when the settled window elapses.
      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledTimes(1);
    });

    it("applies a box whose grid equals a stranded settled target", () => {
      // The #11639 split through the direct-commit caller. The settled request
      // stamped `latestCols`/`latestRows` before anything committed, and
      // `lockResize` then dropped the timer — so the target names a grid xterm
      // never adopted. Deduping the next box against it returns null and stamps
      // the pixel box processed, which `isRedundantResize` honours from then on:
      // the pane stays on the old grid permanently.
      const managed = createManagedTerminal();
      managed.launchAgentId = "codex";
      managed.runtimeAgentId = "codex";
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: CELL } } } },
      });
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });
      const controller = makeController(managed);

      controller.resize("term-1", 1600, 800);
      expect(controller.hasPendingResize("term-1")).toBe(true);
      controller.lockResize("term-1", true);
      controller.lockResize("term-1", false);

      expect(controller.hasPendingResize("term-1")).toBe(false);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(managed.terminal.cols).toBe(80);
      expect(managed.latestCols).toBe(colsFor(1600));

      // A new pixel box — past the pixel gate — landing on the grid the
      // stranded target already names.
      const [retryWidth, retryHeight] = sameGridBox(1600, 800);
      expect(colsFor(retryWidth)).toBe(colsFor(1600));
      const order: string[] = [];
      managed.terminal.resize.mockImplementationOnce(function (
        this: { cols: number; rows: number },
        cols: number,
        rows: number
      ) {
        order.push("xterm");
        this.cols = cols;
        this.rows = rows;
      });
      resizeMock.mockImplementationOnce(() => {
        order.push("pty");
      });

      expect(controller.applyBackgroundResize("term-1", retryWidth, retryHeight)).toEqual({
        cols: colsFor(1600),
        rows: 40,
      });

      expect(order).toEqual(["xterm", "pty"]);
      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1600), 40);
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);
      expect(managed.lastWidth).toBe(retryWidth);
      expect(managed.lastHeight).toBe(retryHeight);

      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledTimes(1);
    });

    it("re-asserts the PTY when the grid already converged but the cache ran ahead", () => {
      // Panel spawn sizes the PTY directly, before xterm has ever been fit, so
      // `latestCols`/`latestRows` can name a grid only the PTY is on. Finding
      // xterm already correct means there is no reflow to run — it does NOT
      // mean the two halves agree, and the pixel box is stamped processed on
      // the way out, so nothing revisits it. The PTY half gets re-asserted
      // alone; sending it through the settled timer would reflow a hidden
      // renderer, which is what this path exists to avoid.
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: CELL } } } },
      });
      const controller = makeController(managed);

      controller.sendPtyResize("term-1", 100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
      expect(managed.terminal.cols).toBe(80);
      expect(managed.terminal.rows).toBe(24);
      resizeMock.mockClear();

      // 820x480 computes to 80x24 — the grid xterm holds, not the 100x30 the
      // PTY was told.
      expect(colsFor(820)).toBe(80);
      expect(controller.applyBackgroundResize("term-1", 820, 480)).toBeNull();

      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledWith("term-1", 80, 24);
      expect(managed.latestCols).toBe(80);
      expect(managed.latestRows).toBe(24);

      // Now that both halves agree, a fresh box on the same grid converges with
      // nothing to re-assert — neither half is touched. Widened past the pixel
      // gate deliberately: an identical box would exit at `isRedundantResize`
      // and prove only that pixel dedup works.
      const [sameGridWidth, sameGridHeight] = sameGridBox(820, 480);
      expect(colsFor(sameGridWidth)).toBe(colsFor(820));
      resizeMock.mockClear();

      expect(controller.applyBackgroundResize("term-1", sameGridWidth, sameGridHeight)).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.terminal.resize).not.toHaveBeenCalled();
    });

    it("records a restore target rather than converging on the replay grid", () => {
      // The direct-commit twin of the measured path's restore case: xterm is
      // parked at the capture grid, so matching it is not convergence — the box
      // still has to reach resizeTerminal to become the geometry the replay
      // normalizes to (#11552).
      const managed = createManagedTerminal();
      managed.isSerializedRestoreInProgress = true;
      managed.pendingRestoreGeometry = { cols: 100, rows: 30 };
      managed.latestCols = 100;
      managed.latestRows = 30;
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: CELL } } } },
      });
      const controller = makeController(managed);

      // Derived from the parked grid on both axes, so neither the column nor
      // the row half can drift into a coincidence if the fixture changes.
      const parkedCols = managed.terminal.cols;
      const parkedRows = managed.terminal.rows;
      const parkedWidth = SCROLLBAR_PX + parkedCols * CELL.width;
      const parkedHeight = parkedRows * CELL.height;

      expect(controller.applyBackgroundResize("term-1", parkedWidth, parkedHeight)).toEqual({
        cols: parkedCols,
        rows: parkedRows,
      });
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(managed.pendingRestoreGeometry).toEqual({ cols: parkedCols, rows: parkedRows });
      expect(resizeMock).toHaveBeenCalledWith("term-1", parkedCols, parkedRows);
    });

    it("supersedes a pending settled timer scheduled before backgrounding", () => {
      const managed = createManagedTerminal();
      managed.launchAgentId = "codex";
      managed.runtimeAgentId = "codex";
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });

      const controller = makeController(managed);
      // A pre-background resize armed the settled timer with stale geometry.
      controller.sendPtyResize("term-1", 120, 30);
      expect(resizeMock).not.toHaveBeenCalled();

      controller.applyBackgroundResize("term-1", 1600, 800);
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);

      vi.advanceTimersByTime(500);
      // The stale timer must not fire its 120x30 resize into either grid.
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1600), 40);
    });
  });

  describe("reconcileGeometryFresh (project-switch reveal)", () => {
    function makeController(managed: ReturnType<typeof createManagedTerminal> | undefined) {
      return new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: {
          flushForTerminal: vi.fn(),
          resetForTerminal: vi.fn(),
          getQueuedBytes: vi.fn(() => 0),
          resumeFlush: vi.fn(),
        } as any,
      });
    }

    it("reflows xterm AND the PTY atomically from a fresh DOM measurement", () => {
      const managed = createManagedTerminal();
      // DOM box proposes 100x30; xterm grid is stale at 80x24.
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(true);
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
      expect(managed.latestCols).toBe(100);
      expect(managed.latestRows).toBe(30);
      // Must NOT route through fitAddon.fit() — that resizes xterm before the PTY
      // and would break settled-strategy atomicity.
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      // The reveal-path reflow re-pins a bottom-following pane — the missing
      // pin that left docked terminals parked above the bottom (#11316).
      expect(managed.terminal.scrollToBottom).toHaveBeenCalledOnce();
    });

    it("clamps the measurement itself so the target cache stays reachable", () => {
      const managed = createManagedTerminal();
      // An absurd box (hostile serialized geometry, a compositor reporting a
      // nonsense rect). Clamping only where the number is APPLIED would leave
      // latestCols at the raw measurement while xterm and the PTY both landed
      // on the ceiling — and every `terminal.cols === latestCols` convergence
      // check (forceGeometryResync's circuit-breaker re-arm, the reveal
      // controller's drift probe) would then be unsatisfiable forever (#11641).
      managed.fitAddon.proposeDimensions = vi.fn(() => ({
        cols: MAX_TERMINAL_GRID_DIMENSION + 500,
        rows: MAX_TERMINAL_GRID_DIMENSION + 500,
      }));

      const controller = makeController(managed);
      expect(controller.reconcileGeometryFresh("term-1")).toBe(true);

      expect(managed.terminal.cols).toBeLessThanOrEqual(MAX_TERMINAL_GRID_DIMENSION);
      expect(managed.terminal.rows).toBeLessThanOrEqual(MAX_TERMINAL_GRID_DIMENSION);
      expect(managed.latestCols).toBe(managed.terminal.cols);
      expect(managed.latestRows).toBe(managed.terminal.rows);
      expect(resizeMock).toHaveBeenCalledWith(
        "term-1",
        managed.terminal.cols,
        managed.terminal.rows
      );
    });

    it("preserves a deliberately user-scrolled viewport across a fresh reflow", () => {
      const managed = createManagedTerminal();
      // Grid drifts (box proposes 100x30, xterm is 80x24) so a real reflow runs,
      // but the user had scrolled up before hiding — the reveal must not yank the
      // viewport back to the bottom (#11316).
      managed.isUserScrolledBack = true;
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(true);
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
      expect(managed.terminal.scrollToBottom).not.toHaveBeenCalled();
    });

    it("does NOT reflow a live alt-screen TUI even when the grid drifted (OpenCode clobber regression)", () => {
      const managed = createManagedTerminal();
      managed.isAltBuffer = true;
      // Same stale-grid setup as above (box proposes 100x30, grid is 80x24): a
      // main-buffer pane gets reflowed, but an alt-screen pane must be left
      // untouched — an out-of-band xterm resize mangles its absolutely-positioned
      // frame (the "settled OpenCode goes weird on click" corruption, #10632).
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      // Reports success so the reveal repaint does not retry-loop, but resizes
      // neither xterm nor the PTY.
      expect(ok).toBe(true);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
      // The alt-buffer early return sits above the pin — never scroll a live
      // full-screen TUI (#11316).
      expect(managed.terminal.scrollToBottom).not.toHaveBeenCalled();
    });

    it("defers a grid-changing reflow while the pane is still streaming output (#10863)", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      // A write landed just now — the CLI is mid-paint.
      (managed as { lastWriteAt?: number }).lastWriteAt = Date.now();

      const controller = makeController(managed);
      const before = {
        latestCols: managed.latestCols,
        latestRows: managed.latestRows,
        lastWidth: managed.lastWidth,
        lastHeight: managed.lastHeight,
      };
      const ok = controller.reconcileGeometryFresh("term-1");

      // Reports "not paintable yet" so the reveal sweep retries later, and
      // must not have re-wrapped xterm, resized the PTY, or poisoned the dim
      // caches (applyDeferredResize's cache==current check relies on them).
      expect(ok).toBe(false);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.latestCols).toBe(before.latestCols);
      expect(managed.latestRows).toBe(before.latestRows);
      expect(managed.lastWidth).toBe(before.lastWidth);
      expect(managed.lastHeight).toBe(before.lastHeight);
    });

    it("defers a grid-changing reflow while a write batch is still parsing (pendingWrites)", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      // First-ever batch queued but not yet parsed: lastWriteAt is unset (its
      // stamp rides the write-buffer completion callback), so recency alone
      // would wave this through and re-wrap mid-first-paint.
      (managed as { pendingWrites?: number }).pendingWrites = 1;

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(false);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("applies the deferred reflow once the pane has gone write-quiescent", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      (managed as { lastWriteAt?: number }).lastWriteAt = Date.now();

      const controller = makeController(managed);
      expect(controller.reconcileGeometryFresh("term-1")).toBe(false);

      vi.advanceTimersByTime(REVEAL_REWRAP_QUIESCENT_MS + 1);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(true);
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
    });

    it("converges a still-streaming diverged grid when the caller forces it (#11638)", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      // Both streaming signals live at once — a busy agent's steady state. The
      // point of the force flag is that no amount of waiting would clear this.
      (managed as { lastWriteAt?: number }).lastWriteAt = Date.now();
      (managed as { pendingWrites?: number }).pendingWrites = 3;

      const controller = makeController(managed);

      // Same pane, same instant: the unforced call is the deferral this issue
      // is about, and the forced call is the fix. Asserting both against one
      // fixture is what proves force is doing the work, not the clock.
      expect(controller.reconcileGeometryFresh("term-1")).toBe(false);
      expect(managed.terminal.resize).not.toHaveBeenCalled();

      const ok = controller.reconcileGeometryFresh("term-1", { force: true });

      expect(ok).toBe(true);
      // xterm and the PTY land on the SAME freshly proposed geometry — the
      // atomicity that makes this safe for a settled-strategy agent.
      const proposal = managed.fitAddon.proposeDimensions();
      expect(managed.terminal.resize).toHaveBeenCalledWith(proposal.cols, proposal.rows);
      expect(resizeMock).toHaveBeenCalledWith("term-1", proposal.cols, proposal.rows);
      expect(managed.latestCols).toBe(proposal.cols);
      expect(managed.latestRows).toBe(proposal.rows);
      // Never via fitAddon.fit() — that resizes xterm ahead of the PTY.
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
    });

    it("drains held ingest bytes at the OUTGOING grid before a forced re-wrap", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      (managed as { pendingWrites?: number }).pendingWrites = 3;

      const order: string[] = [];
      const dataBuffer = {
        flushForTerminal: vi.fn(() => order.push("flush")),
        resetForTerminal: vi.fn(),
        getQueuedBytes: vi.fn(() => 1024),
        resumeFlush: vi.fn(() => order.push("resume")),
      };
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: dataBuffer as any,
      });
      (managed.terminal.resize as ReturnType<typeof vi.fn>).mockImplementation(() =>
        order.push("resize")
      );

      expect(controller.reconcileGeometryFresh("term-1", { force: true })).toBe(true);

      // Bytes held by backpressure were emitted for the OLD grid. Parsing them
      // after xterm adopts the new one puts their cursor moves and erases on
      // the wrong rows, and no later reflow undoes that.
      expect(order).toEqual(["flush", "resize"]);
    });

    it("resumes an over-budget backlog only AFTER the forced resize", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      (managed as { pendingWrites?: number }).pendingWrites = 3;

      const order: string[] = [];
      const dataBuffer = {
        flushForTerminal: vi.fn(() => order.push("flush")),
        resetForTerminal: vi.fn(),
        // Past the sync-flush budget: the backlog stays queued rather than
        // being drained inline.
        getQueuedBytes: vi.fn(() => 64 * 1024 * 1024),
        resumeFlush: vi.fn(() => order.push("resume")),
      };
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: dataBuffer as any,
      });
      (managed.terminal.resize as ReturnType<typeof vi.fn>).mockImplementation(() =>
        order.push("resize")
      );

      expect(controller.reconcileGeometryFresh("term-1", { force: true })).toBe(true);

      // Never flushed inline (that is what the budget is for), and resumed only
      // after the resize. Resuming first would drain the backlog into xterm and
      // then let resize()'s synchronous flushSync keep consuming what
      // notifyWriteComplete appends behind it — one unyielding task.
      expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
      expect(order).toEqual(["resize", "resume"]);
    });

    it("force does not reflow a live alt-screen TUI (#10805 survives the bypass)", () => {
      const managed = createManagedTerminal();
      managed.isAltBuffer = true;
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      (managed as { pendingWrites?: number }).pendingWrites = 3;

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1", { force: true });

      // force buys past write-quiescence and nothing else: the alt-buffer early
      // return sits ABOVE the streaming gate, so a full-screen TUI's frame is
      // still never mangled out from under its own SIGWINCH redraw.
      expect(ok).toBe(true);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.terminal.scrollToBottom).not.toHaveBeenCalled();
    });

    it("force still reports failure on an unmeasurable host box", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      (managed as { pendingWrites?: number }).pendingWrites = 3;
      // Transitional/occluded layout: below the >=50px floor the fresh
      // measurement is meaningless, and forcing must not fabricate one.
      managed.hostElement.getBoundingClientRect = vi.fn(() => ({
        left: 0,
        width: 10,
        height: 10,
      })) as any;

      const controller = makeController(managed);

      expect(controller.reconcileGeometryFresh("term-1", { force: true })).toBe(false);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("still re-asserts the PTY during streaming when the grid has not drifted", () => {
      const managed = createManagedTerminal();
      managed.terminal.cols = 100;
      managed.terminal.rows = 30;
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      (managed as { lastWriteAt?: number }).lastWriteAt = Date.now();

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      // No re-wrap is involved, so streaming doesn't defer the dedupe-safe
      // PTY re-assert.
      expect(ok).toBe(true);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
      // Streaming only blocks a grid-CHANGING reflow; a successful no-drift
      // reconcile still self-heals bottom-follow (#11316).
      expect(managed.terminal.scrollToBottom).toHaveBeenCalledOnce();
    });

    it("ignores an active resize lock without clearing it (the reveal exception)", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));

      const controller = makeController(managed);
      controller.lockResize("term-1", true);
      // Under the same lock a normal fit() no-ops.
      expect(controller.fit("term-1")).toBeNull();
      expect(managed.terminal.resize).not.toHaveBeenCalled();

      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(true);
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
      // The shared lock survives so ResizeObserver-storm damping keeps working.
      expect(controller.isResizeLocked("term-1")).toBe(true);
    });

    it("applies atomically for a settled-strategy agent with no 500ms deferral", () => {
      const managed = createManagedTerminal();
      managed.runtimeAgentId = "codex";
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });

      const controller = makeController(managed);
      controller.lockResize("term-1", true);

      // Arm a pending settled (500ms) PTY resize carrying STALE dims; the
      // one-shot reveal reconcile must cancel it so that geometry never lands.
      controller.sendPtyResize("term-1", 50, 10);
      expect(resizeMock).not.toHaveBeenCalled();

      controller.reconcileGeometryFresh("term-1");

      // xterm + PTY both move now to the FRESH dims — not deferred behind 500ms.
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);

      vi.advanceTimersByTime(500);
      // The stale settled timer was cancelled — no 50x10 resize fires afterward.
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(managed.terminal.resize).not.toHaveBeenCalledWith(50, 10);
    });

    it("uses fresh DOM dims even when cached latestCols equals the current grid", () => {
      const managed = createManagedTerminal();
      // Cache matches the stale xterm grid (80x24) — applyDeferredResize would
      // early-return here — but the live box actually grew to 100x30.
      managed.latestCols = 80;
      managed.latestRows = 24;
      managed.terminal.cols = 80;
      managed.terminal.rows = 24;
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));

      const controller = makeController(managed);
      controller.reconcileGeometryFresh("term-1");

      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
    });

    it("re-asserts only the PTY when the grid is already correct", () => {
      const managed = createManagedTerminal();
      managed.terminal.cols = 100;
      managed.terminal.rows = 30;
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(true);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
      // Even with no xterm reflow, a successful main-buffer reconcile re-pins a
      // bottom-following pane — this self-heals a viewport left off-bottom by an
      // earlier silent reflow, and is a no-op when already at bottom (#11316).
      expect(managed.terminal.scrollToBottom).toHaveBeenCalledOnce();
    });

    it("falls back to cell-metric math when no proposable dimensions exist", () => {
      const managed = createManagedTerminal();
      // host box is 1000x700; cell is 10x20 → (1000-15)/10 = 98 cols x 35 rows.
      // The fallback reserves the same scrollbar gutter the primary
      // proposeDimensions() branch would, so the two agree (#11095).
      managed.fitAddon.proposeDimensions = vi.fn(() => undefined);
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(true);
      expect(managed.terminal.resize).toHaveBeenCalledWith(colsFor(1000), 35);
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1000), 35);
    });

    it("returns false (retry next frame) when the box is not measurable yet", () => {
      const managed = createManagedTerminal();
      // No proposable dims and no cell metrics → unmeasurable transitional box.
      managed.fitAddon.proposeDimensions = vi.fn(() => undefined);

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(false);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("returns false for a zero/too-small layout box", () => {
      const managed = createManagedTerminal();
      managed.hostElement.getBoundingClientRect = vi.fn(() => ({
        left: 0,
        width: 10,
        height: 10,
      })) as any;

      const controller = makeController(managed);
      expect(controller.reconcileGeometryFresh("term-1")).toBe(false);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("returns false when the host is not visible", () => {
      const managed = createManagedTerminal();
      managed.hostElement.checkVisibility = vi.fn(() => false);

      const controller = makeController(managed);
      expect(controller.reconcileGeometryFresh("term-1")).toBe(false);
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("returns false for a missing instance", () => {
      const controller = makeController(undefined);
      expect(controller.reconcileGeometryFresh("term-1")).toBe(false);
      expect(resizeMock).not.toHaveBeenCalled();
    });
  });

  describe("background resize lock replay + custom TTL", () => {
    function makeManagedWithMetrics() {
      const managed = createManagedTerminal();
      managed.isFocused = false;
      managed.isVisible = false;
      managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      return managed;
    }

    function makeCtl(managed: ReturnType<typeof createManagedTerminal>) {
      return new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: {
          flushForTerminal: vi.fn(),
          resetForTerminal: vi.fn(),
          getQueuedBytes: vi.fn(() => 0),
          resumeFlush: vi.fn(),
        } as any,
      });
    }

    it("stashes a background resize that lands while the resize lock is held instead of dropping it", () => {
      const managed = makeManagedWithMetrics();
      const controller = makeCtl(managed);

      controller.lockResize("term-1", true);
      const result = controller.applyBackgroundResize("term-1", 1600, 800);

      // Locked: the PTY is not resized now, but the geometry is preserved.
      expect(result).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.pendingBackgroundResize).toEqual({ width: 1600, height: 800 });
    });

    it("replays the stashed background resize when the lock releases", () => {
      const managed = makeManagedWithMetrics();
      const controller = makeCtl(managed);

      controller.lockResize("term-1", true);
      controller.applyBackgroundResize("term-1", 1600, 800);
      expect(resizeMock).not.toHaveBeenCalled();

      controller.lockResize("term-1", false);

      // The held geometry is delivered to the PTY once on unlock, stash cleared.
      expect(resizeMock).toHaveBeenCalledWith("term-1", colsFor(1600), 40);
      expect(managed.pendingBackgroundResize).toBeUndefined();
    });

    it("releasing the lock with no stashed resize is a no-op", () => {
      const managed = makeManagedWithMetrics();
      const controller = makeCtl(managed);

      controller.lockResize("term-1", true);
      controller.lockResize("term-1", false);

      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.pendingBackgroundResize).toBeUndefined();
    });

    it("honors a custom lock TTL longer than the default", () => {
      const managed = makeManagedWithMetrics();
      const controller = makeCtl(managed);

      // 10s custom TTL — the project-switch suppression window.
      controller.lockResize("term-1", true, 10_000);

      // Past the 5s default lock TTL, a custom-TTL lock is still held.
      vi.advanceTimersByTime(6_000);
      expect(controller.isResizeLocked("term-1")).toBe(true);

      // Past the 10s custom TTL, the lock has expired.
      vi.advanceTimersByTime(4_001);
      expect(controller.isResizeLocked("term-1")).toBe(false);
    });
  });

  describe("viewport scroll-cache invalidation after a re-pin (#11709)", () => {
    /**
     * A managed terminal whose `_core` carries the private viewport shape, and
     * which records the cached `_latestYDisp` each collaborator OBSERVES rather
     * than only that it was called. Ordering is the contract under test: the
     * public pin has to run while the cache is still primed, and the queued sync
     * has to run after it was cleared.
     */
    /**
     * A container whose width divides to exactly the fixture's 80 columns, so
     * the shrink below moves rows and ONLY rows — the condition under which
     * xterm's reflow never runs and the relative pin has a zero delta.
     */
    const ROWS_ONLY_WIDTH = SCROLLBAR_PX + 80 * CELL.width;
    const BASELINE_HEIGHT = 600;
    const BASELINE_ROWS = BASELINE_HEIGHT / CELL.height;

    /**
     * @param rendererRows the row count the renderer's canvas currently
     * measures. Defaults to tracking the terminal (an unpaused renderer that
     * adopted the resize); pass a fixed number to model a PAUSED renderer whose
     * canvas still describes the pre-resize size.
     */
    function makeManagedWithViewport(primedYDisp = 42, rendererRows?: () => number) {
      const managed = createManagedTerminal();
      // The shared fixture's rows (24) do not correspond to its lastHeight
      // (600px / 20px = 30). Align them, or "one row shorter" is a grow.
      managed.terminal.rows = BASELINE_ROWS;
      managed.latestRows = BASELINE_ROWS;
      const observed: Array<{ by: string; latestYDisp: number | undefined }> = [];
      const viewport = {
        _latestYDisp: primedYDisp as number | undefined,
        // Mirrors xterm: a queueSync CARRYING a ydisp writes it back into the
        // cache, which would re-prime what we just cleared. Emulating that is
        // what makes a `queueSync(staleYDisp)` regression observable here.
        queueSync: vi.fn((ydisp?: number) => {
          if (ydisp !== undefined) viewport._latestYDisp = ydisp;
          observed.push({ by: "queueSync", latestYDisp: viewport._latestYDisp });
        }),
      };
      const rowsForCanvas = rendererRows ?? (() => managed.terminal.rows);
      Object.assign(managed.terminal, {
        _core: {
          _renderService: {
            dimensions: {
              css: {
                cell: CELL,
                get canvas() {
                  return { height: rowsForCanvas() * CELL.height };
                },
              },
            },
          },
          _viewport: viewport,
        },
        scrollToBottom: vi.fn(() => {
          observed.push({ by: "scrollToBottom", latestYDisp: viewport._latestYDisp });
        }),
      });
      return { managed, viewport, observed };
    }

    function makeCtl(managed: ReturnType<typeof createManagedTerminal>) {
      return new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: {
          flushForTerminal: vi.fn(),
          resetForTerminal: vi.fn(),
          getQueuedBytes: vi.fn(() => 0),
          resumeFlush: vi.fn(),
        } as any,
      });
    }

    /** A rows-only shrink: same width, one cell row shorter. */
    const shrinkOneRow = (controller: TerminalResizeController) =>
      controller.resize("term-1", ROWS_ONLY_WIDTH, BASELINE_HEIGHT - CELL.height);

    it("clears the primed cache and re-queues a sync, in that order, after a rows-only shrink", () => {
      const { managed, viewport, observed } = makeManagedWithViewport();
      const colsBefore = managed.terminal.cols;
      const controller = makeCtl(managed);

      const result = shrinkOneRow(controller);

      // Rows-only: the column count is untouched, so xterm's reflow never runs
      // and the relative pin below has a zero delta to apply.
      expect(result?.cols).toBe(colsBefore);
      expect(result?.rows).toBe(BASELINE_ROWS - 1);

      // The public pin must observe the cache STILL primed — it can emit an
      // onScroll that re-primes, so clearing first would be undone.
      expect(observed.map((o) => o.by)).toEqual(["scrollToBottom", "queueSync"]);
      expect(observed[0]?.latestYDisp).toBe(42);
      // ...and the queued sync must observe it cleared, which is what makes
      // `_sync` fall through to buffer.ydisp instead of skipping.
      expect(observed[1]?.latestYDisp).toBeUndefined();
      expect(viewport._latestYDisp).toBeUndefined();
      expect(viewport.queueSync).toHaveBeenCalledTimes(1);
      // No argument: passing one writes it straight back into the cache, which
      // would restore the stale value the clear above just removed.
      expect(viewport.queueSync).toHaveBeenCalledWith();
    });

    it("completes the resize when queueSync throws", () => {
      const { managed, viewport } = makeManagedWithViewport();
      viewport.queueSync.mockImplementation(() => {
        throw new Error("viewport disposed mid-resize");
      });
      const controller = makeCtl(managed);

      // The DOM repair is best-effort; a disposed or renamed internal must not
      // take the resize (or the PTY notification) down with it.
      expect(() => shrinkOneRow(controller)).not.toThrow();
      expect(managed.terminal.scrollToBottom).toHaveBeenCalledOnce();
      expect(resizeMock).toHaveBeenCalled();
    });

    it("leaves a deliberately scrolled-back viewport's cache alone", () => {
      const { managed, viewport, observed } = makeManagedWithViewport();
      managed.isUserScrolledBack = true;
      const controller = makeCtl(managed);

      shrinkOneRow(controller);

      // The guard owns both halves: no pin, no invalidation, and the user's own
      // scroll position stays cached.
      expect(observed).toEqual([]);
      expect(viewport._latestYDisp).toBe(42);
      expect(viewport.queueSync).not.toHaveBeenCalled();
    });

    it("holds off while a paused renderer's canvas still measures the old row count", () => {
      // A backgrounded pane defers its renderer resize to an idle task, so the
      // canvas height _sync clamps against is a row (or more) too tall. Forcing
      // the sync there lands short and the resulting scroll event drags the
      // buffer back — the exact failure this repairs. Freeze the canvas at the
      // pre-resize row count to model that.
      const { managed, viewport, observed } = makeManagedWithViewport(42, () => BASELINE_ROWS);
      const controller = makeCtl(managed);

      shrinkOneRow(controller);

      // The public pin is unconditional; only the DOM-side repair waits.
      expect(observed.map((o) => o.by)).toEqual(["scrollToBottom"]);
      expect(viewport.queueSync).not.toHaveBeenCalled();
      expect(viewport._latestYDisp).toBe(42);
    });

    it("still pins when the private viewport shape is missing", () => {
      // createManagedTerminal() has no `_core._viewport` — the shape xterm would
      // present before open(), and the shape every other suite's mock has. The
      // fix must degrade to the public pin rather than throw through the resize.
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: CELL } } } },
      });
      const controller = makeCtl(managed);

      expect(() => shrinkOneRow(controller)).not.toThrow();
      expect(managed.terminal.scrollToBottom).toHaveBeenCalledOnce();
    });
  });
});
