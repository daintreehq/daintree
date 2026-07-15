// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { TerminalRefreshTier } from "@/types";

const { resizeMock } = vi.hoisted(() => ({ resizeMock: vi.fn() }));

vi.mock("@/clients", () => ({
  terminalClient: { resize: resizeMock },
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { TerminalResizeController, type ResizeControllerDeps } from "../TerminalResizeController";
import {
  TerminalReconciliationWatchdog,
  WATCHDOG_INTERVAL_MS,
  type ReconciliationWatchdogDeps,
} from "../TerminalReconciliationWatchdog";
import {
  __resetSidebarHydrationLockForTests,
  __resetSidebarLayoutTransitionLockForTests,
  unlockSidebarHydration,
} from "@/lib/layoutTransitionLock";
import { getXtermOptions } from "@/config/xtermConfig";
import type { ManagedTerminal } from "../types";

/**
 * Parity between Daintree's manual pixel-to-column math and xterm's own
 * `FitAddon` (#11095).
 *
 * `TerminalResizeController` deliberately computes cols/rows from cached cell
 * metrics rather than calling `proposeDimensions()`, which reads a DOM that may
 * not reflect the ResizeObserver dimensions yet. That hand-rolled math has to
 * stay bug-for-bug identical to FitAddon's, because `TerminalReconciliationWatchdog`
 * uses FitAddon as its ground truth: any disagreement is a grid it "repairs"
 * seconds later, after the pane has painted — which is what corrupts the
 * cursor-relative inline TUIs (the Assistant sidebar) the issue describes.
 *
 * So the oracle here is the REAL FitAddon, driven off the REAL production
 * options (`getXtermOptions()`). Nothing asserts a hardcoded column count: the
 * assertions are equalities between the two implementations, which is the
 * property that actually has to hold. Before the fix, the controller floored the
 * full container width while FitAddon reserved the scrollbar, so these
 * equalities fail.
 */

/** Realistic cell metrics for a ~15px monospace font. */
const CELL = { width: 9, height: 18 };

/** Fits inside jsdom's default 1024x768 viewport, so the watchdog sees it on-screen. */
const CONTAINER = { width: 665, height: 360 };

interface Pane {
  managed: ManagedTerminal;
  terminal: {
    cols: number;
    rows: number;
    resize: ReturnType<typeof vi.fn>;
    buffer: { active: { baseY: number; viewportY: number; length: number } };
  };
  fitAddon: FitAddon;
}

function buildPane(
  container: { width: number; height: number } = CONTAINER,
  optionOverrides: {
    scrollback?: number;
    scrollbar?: { width?: number; showScrollbar?: boolean };
  } = {},
  cell: { width: number; height: number } = CELL
): Pane {
  // The container FitAddon measures (terminal.element.parentElement) is the same
  // box the ResizeObserver reports to resize() — that equivalence is the whole
  // point, so model it with one element.
  const hostElement = document.createElement("div");
  hostElement.style.width = `${container.width}px`;
  hostElement.style.height = `${container.height}px`;
  document.body.appendChild(hostElement);

  const termEl = document.createElement("div");
  hostElement.appendChild(termEl);

  hostElement.getBoundingClientRect = () =>
    ({
      width: container.width,
      height: container.height,
      top: 10,
      left: 10,
      bottom: 10 + container.height,
      right: 10 + container.width,
    }) as DOMRect;
  hostElement.checkVisibility = () => true;

  // Real production options, so the controller and FitAddon read the same
  // scrollbar/scrollback config a live terminal would be constructed with.
  const options = {
    ...getXtermOptions({
      fontSize: 15,
      fontFamily: "monospace",
      scrollback: 1000,
      performanceMode: false,
    }),
    ...optionOverrides,
  };

  const cellDims = { css: { cell: { width: cell.width, height: cell.height } } };

  const terminal = {
    cols: 80,
    rows: 24,
    element: termEl,
    options,
    // Public API FitAddon reads.
    dimensions: cellDims,
    // Private path getXtermCellDimensions() reads, plus the watchdog's pause probe.
    _core: { _renderService: { dimensions: cellDims, _isPaused: false } },
    modes: { synchronizedOutputMode: false },
    buffer: { active: { baseY: 0, viewportY: 0, length: 10 } },
    resize: vi.fn(function (this: { cols: number; rows: number }, cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }),
    scrollToBottom: vi.fn(),
    write: vi.fn(),
  };

  const fitAddon = new FitAddon();
  fitAddon.activate(terminal as unknown as Terminal);

  const managed = {
    terminal,
    fitAddon,
    hostElement,
    kind: "terminal",
    isOpened: true,
    isVisible: true,
    isFocused: true,
    isAttaching: false,
    isDetached: false,
    isResizeSuppressed: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    lastActiveTime: 0,
    // Zeroed so the pixel dedup gate never suppresses the first resize.
    lastWidth: 0,
    lastHeight: 0,
    lastAttachAt: 0,
    lastDetachAt: 0,
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    listeners: [],
    exitSubscribers: new Set(),
    agentStateSubscribers: new Set(),
    altBufferListeners: new Set(),
    writeChain: Promise.resolve(),
    restoreGeneration: 0,
    isSerializedRestoreInProgress: false,
    deferredOutput: [],
    scrollbackRestoreState: "none",
    attachGeneration: 0,
    attachRevealToken: 0,
    keyHandlerInstalled: false,
    ipcListenerCount: 0,
    lastAppliedTier: TerminalRefreshTier.FOCUSED,
    getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    pendingWrites: 0,
    lastWriteAt: 0,
  } as unknown as ManagedTerminal;

  return { managed, terminal, fitAddon };
}

function makeController(managed: ManagedTerminal): TerminalResizeController {
  return new TerminalResizeController({
    getInstance: () => managed,
    dataBuffer: {
      getQueuedBytes: vi.fn(() => 0),
      flushForTerminal: vi.fn(),
      resetForTerminal: vi.fn(),
      resumeFlush: vi.fn(),
    } as unknown as ResizeControllerDeps["dataBuffer"],
  });
}

function makeWatchdogDeps(instances: Map<string, ManagedTerminal>): ReconciliationWatchdogDeps {
  return {
    getInstances: () => instances.entries(),
    setVisible: vi.fn(),
    applyRendererPolicy: vi.fn(),
    reassertActiveBackendTier: vi.fn(),
    getBackendTier: vi.fn(() => "active" as const),
    getStalledBytes: vi.fn(() => 0),
    getQueuedBytes: vi.fn(() => 0),
    resumeFlush: vi.fn(),
    hasInFlightWake: vi.fn(() => false),
    hasPendingWake: vi.fn(() => false),
    isResizeTransitioning: vi.fn(() => false),
    isWebGLActive: vi.fn(() => true),
    shouldHaveWebGL: vi.fn(() => false),
    ensureWebGL: vi.fn(),
    forceReflow: vi.fn(),
    reconcileRevealGeometry: vi.fn(() => true),
    isStoreBackgrounded: vi.fn(() => false),
    isStoreHidden: vi.fn(() => false),
    repairStoreVisibility: vi.fn(),
  };
}

describe("TerminalResizeController ↔ FitAddon column parity (#11095)", () => {
  let watchdog: TerminalReconciliationWatchdog | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    __resetSidebarLayoutTransitionLockForTests();
    __resetSidebarHydrationLockForTests();
    unlockSidebarHydration();
  });

  afterEach(() => {
    watchdog?.dispose();
    watchdog = undefined;
    document.body.innerHTML = "";
    __resetSidebarLayoutTransitionLockForTests();
    __resetSidebarHydrationLockForTests();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("sizes a ResizeObserver-driven resize to exactly what FitAddon would propose", () => {
    const { managed, terminal, fitAddon } = buildPane();
    const controller = makeController(managed);

    const proposal = fitAddon.proposeDimensions();
    expect(proposal).toBeDefined();

    // The dimensions a ResizeObserver would hand us for that same box.
    const applied = controller.resize("t1", CONTAINER.width, CONTAINER.height);

    expect(applied).toEqual({ cols: proposal!.cols, rows: proposal!.rows });
    // ...and the grid xterm actually ends up on agrees too, which is what the
    // watchdog compares against.
    expect(terminal.cols).toBe(proposal!.cols);
    expect(terminal.rows).toBe(proposal!.rows);
    expect(resizeMock).toHaveBeenCalledWith("t1", proposal!.cols, proposal!.rows);
  });

  it("leaves the reconciliation watchdog with nothing to repair after paint", () => {
    // The issue's actual symptom: the grid settles a couple of columns wide, the
    // pane paints, and ~3s later the watchdog re-wraps it underneath a
    // cursor-relative TUI. With parity there is no divergence to detect.
    const { managed } = buildPane();
    const controller = makeController(managed);

    controller.resize("t1", CONTAINER.width, CONTAINER.height);

    // Seed a prior repair attempt as a REACH WITNESS. The watchdog zeroes this
    // only on the converged branch, so observing the reset proves the geometry
    // check actually ran — without it, this test would still pass if some
    // unrelated gate (hydration lock, visibility, render-pause) short-circuited
    // the tick before it ever compared the grids.
    managed.geometryRepairAttempts = 1;

    const instances = new Map<string, ManagedTerminal>([["t1", managed]]);
    const deps = makeWatchdogDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(managed.geometryRepairAttempts).toBe(0);
    expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
    expect(managed.lastWatchdogRepairAt).toBeUndefined();
  });

  it("keeps the watchdog out of geometry while a controller resize is pending", () => {
    const { managed, terminal, fitAddon } = buildPane();
    managed.isFocused = false;
    terminal.buffer.active.length = 500;
    const controller = makeController(managed);

    controller.resize("t1", CONTAINER.width, CONTAINER.height);
    expect(controller.hasPendingResize("t1")).toBe(true);

    const instances = new Map<string, ManagedTerminal>([["t1", managed]]);
    const deps = makeWatchdogDeps(instances);
    deps.isResizeTransitioning = (id) =>
      controller.isResizeLocked(id) || controller.hasPendingResize(id);
    watchdog = new TerminalReconciliationWatchdog(deps);
    const proposeDimensions = vi.spyOn(fitAddon, "proposeDimensions");

    watchdog.tick();

    expect(proposeDimensions).not.toHaveBeenCalled();
    expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
    expect(managed.geometryRepairAttempts).toBeUndefined();
    expect(managed.lastWatchdogRepairAt).toBeUndefined();
  });

  describe("fractional layout boxes", () => {
    // FitAddon reads the container with parseInt(getComputedStyle(...).width),
    // truncating to whole pixels — while a ResizeObserver contentRect reports the
    // fractional value a CSS grid/flex track actually produces. Dividing that raw
    // is a second, subtler way to land off xterm's grid, on both axes.
    const FRACTIONAL_CONTAINER = { width: 670.25, height: 380.25 };
    const FRACTIONAL_CELL = { width: 9.1, height: 18.1 };

    it("matches FitAddon on a fractional container with fractional cells", () => {
      const { managed, terminal, fitAddon } = buildPane(FRACTIONAL_CONTAINER, {}, FRACTIONAL_CELL);
      const controller = makeController(managed);

      const proposal = fitAddon.proposeDimensions();
      expect(proposal).toBeDefined();

      const applied = controller.resize(
        "t1",
        FRACTIONAL_CONTAINER.width,
        FRACTIONAL_CONTAINER.height
      );

      // Both axes: truncation affects rows too, and the watchdog compares both.
      expect(applied).toEqual({ cols: proposal!.cols, rows: proposal!.rows });
      expect(terminal.cols).toBe(proposal!.cols);
      expect(terminal.rows).toBe(proposal!.rows);
    });

    it("does not let a sub-pixel resize that crosses a pixel boundary go unapplied", () => {
      // The dedup hole: 671.9 → 672.1 is a 0.2px change, but FitAddon's truncated
      // width moves 671 → 672, which crosses a cell boundary and changes the grid.
      // A `< 1px` tolerance would swallow it and strand xterm a column behind the
      // container until the watchdog repaired it after paint.
      const before = { width: 671.9, height: 359.9 };
      const after = { width: 672.1, height: 360.1 };
      const cell = { width: 9, height: 18 };

      const { managed, terminal, fitAddon } = buildPane(before, {}, cell);
      const controller = makeController(managed);

      controller.resize("t1", before.width, before.height);

      // Re-measure the same pane at the new box, exactly as a ResizeObserver would.
      managed.hostElement.style.width = `${after.width}px`;
      managed.hostElement.style.height = `${after.height}px`;
      controller.resize("t1", after.width, after.height);

      const proposal = fitAddon.proposeDimensions();
      expect(proposal).toBeDefined();
      expect(terminal.cols).toBe(proposal!.cols);
      expect(terminal.rows).toBe(proposal!.rows);
    });

    it("supersedes a queued resize when the box returns to the grid xterm already has", () => {
      // Boundary reversal inside the debounce window. The container dips to
      // 671.9px (queuing a 72-column resize), then comes back to 672.1px before
      // that job fires — where xterm is still correctly at 73. The stale job must
      // not be allowed to drag xterm and the PTY down to 72 for a 73-column box.
      const wide = { width: 672.1, height: 360 };
      const narrow = { width: 671.9, height: 360 };
      const cell = { width: 9, height: 18 };

      const { managed, terminal, fitAddon } = buildPane(wide, {}, cell);
      const controller = makeController(managed);

      // Settle xterm on the wide box first.
      controller.resize("t1", wide.width, wide.height, { immediate: true });
      const settled = fitAddon.proposeDimensions();
      expect(terminal.cols).toBe(settled!.cols);

      // Now take the debounced path (unfocused + a long buffer), so the narrow
      // box only QUEUES its resize rather than applying it.
      managed.isFocused = false;
      terminal.buffer.active.length = 300;

      controller.resize("t1", narrow.width, narrow.height);
      expect(terminal.cols).toBe(settled!.cols); // still queued, not yet applied

      // Reversal: back to the wide box. The grid is already right, so this
      // returns null — but it must cancel the queued 72-column job.
      expect(controller.resize("t1", wide.width, wide.height)).toBeNull();

      vi.advanceTimersByTime(1000);

      expect(terminal.cols).toBe(settled!.cols);
      expect(managed.latestCols).toBe(settled!.cols);
      expect(resizeMock).not.toHaveBeenCalledWith("t1", 72, expect.anything());
    });

    it("still dedups a jitter that stays inside the same pixel", () => {
      // The other half of the contract: sub-pixel noise that cannot move
      // FitAddon's truncated box must not churn the PTY.
      const { managed } = buildPane({ width: 670.1, height: 360.1 });
      const controller = makeController(managed);

      controller.resize("t1", 670.1, 360.1);
      resizeMock.mockClear();

      expect(controller.resize("t1", 670.4, 360.4)).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
    });
  });

  it("keeps the PTY-only (backgrounded) path in agreement with FitAddon", () => {
    const { managed, fitAddon } = buildPane();
    const controller = makeController(managed);

    const proposal = fitAddon.proposeDimensions();
    const applied = controller.resizePtyOnly("t1", CONTAINER.width, CONTAINER.height);

    expect(applied).toEqual({ cols: proposal!.cols, rows: proposal!.rows });
  });

  it("keeps the reveal reconciler's cell-metric fallback in agreement with FitAddon", () => {
    const { managed, terminal, fitAddon } = buildPane();
    const proposal = fitAddon.proposeDimensions();
    expect(proposal).toBeDefined();

    // Force the fallback branch: the renderer hasn't published proposable
    // dimensions yet, so reconcileGeometryFresh() computes from cell metrics.
    // It must still land on the grid FitAddon would have chosen.
    const controller = makeController(managed);
    managed.fitAddon = {
      ...fitAddon,
      proposeDimensions: () => undefined,
    } as unknown as ManagedTerminal["fitAddon"];

    expect(controller.reconcileGeometryFresh("t1")).toBe(true);
    expect(terminal.cols).toBe(proposal!.cols);
    expect(terminal.rows).toBe(proposal!.rows);
  });

  describe("mirrors FitAddon's scrollbar gating", () => {
    // FitAddon only reserves the gutter when the terminal can actually scroll
    // and the scrollbar is shown. Each case is checked against the real addon
    // rather than against a value we chose.
    const cases: Array<{
      name: string;
      options: { scrollback?: number; scrollbar?: { width?: number; showScrollbar?: boolean } };
    }> = [
      { name: "a normal scrollable terminal", options: {} },
      { name: "no scrollback (gutter collapses)", options: { scrollback: 0 } },
      { name: "scrollbar explicitly hidden", options: { scrollbar: { showScrollbar: false } } },
      { name: "no configured width (xterm's default)", options: { scrollbar: {} } },
    ];

    for (const { name, options } of cases) {
      it(name, () => {
        const { managed, fitAddon } = buildPane(CONTAINER, options);
        const controller = makeController(managed);

        const proposal = fitAddon.proposeDimensions();
        const applied = controller.resize("t1", CONTAINER.width, CONTAINER.height);

        expect(applied).toEqual({ cols: proposal!.cols, rows: proposal!.rows });
      });
    }
  });

  it("clamps to FitAddon's floor when the container is thinner than the gutter", () => {
    const narrow = { width: 10, height: 360 };
    const { managed, fitAddon } = buildPane(narrow);
    const controller = makeController(managed);

    const proposal = fitAddon.proposeDimensions();
    const applied = controller.resize("t1", narrow.width, narrow.height);

    // Negative available width must not produce a negative or zero column count
    // on either side — both floor at 2.
    expect(applied).toEqual({ cols: proposal!.cols, rows: proposal!.rows });
    expect(applied!.cols).toBeGreaterThanOrEqual(2);
  });

  it("clamps to FitAddon's floor when the container is shorter than one cell", () => {
    const short = { width: 665, height: 9 };
    const { managed, fitAddon } = buildPane(short);
    const controller = makeController(managed);

    const proposal = fitAddon.proposeDimensions();
    const applied = controller.resize("t1", short.width, short.height);

    expect(applied).toEqual({ cols: proposal!.cols, rows: proposal!.rows });
    expect(applied!.rows).toBeGreaterThanOrEqual(1);
  });

  it("rejects a non-finite box instead of caching a garbage grid", () => {
    const { managed } = buildPane();
    const controller = makeController(managed);

    expect(controller.resize("t1", Number.NaN, CONTAINER.height)).toBeNull();
    expect(managed.latestCols).toBe(80); // untouched seed value
    expect(resizeMock).not.toHaveBeenCalled();
  });
});
