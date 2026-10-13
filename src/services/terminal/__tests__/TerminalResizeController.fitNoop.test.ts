import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";

const { resizeMock, getEffectiveAgentConfigMock } = vi.hoisted(() => ({
  resizeMock: vi.fn(),
  getEffectiveAgentConfigMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  terminalClient: { resize: resizeMock },
}));

vi.mock("@shared/config/agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/config/agentRegistry")>();
  return { ...actual, getEffectiveAgentConfig: getEffectiveAgentConfigMock };
});

import { TerminalResizeController, type ResizeControllerDeps } from "../TerminalResizeController";

const PROPOSAL = { cols: 100, rows: 30 };

function createManaged() {
  return {
    terminal: {
      cols: 80,
      rows: 24,
      options: { scrollback: 1000, scrollbar: { width: 14 } },
      buffer: { active: { baseY: 0, viewportY: 0, length: 20 } },
      resize: vi.fn(function (this: { cols: number; rows: number }, cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
      }),
      write: vi.fn(),
      scrollToBottom: vi.fn(),
    },
    fitAddon: { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ ...PROPOSAL })) },
    hostElement: {
      style: { width: "100%" },
      checkVisibility: vi.fn(() => true),
      getBoundingClientRect: vi.fn(() => ({ left: 0, width: 1000, height: 700 })),
      querySelector: vi.fn(() => null),
    },
    isFocused: true,
    isVisible: true,
    lastAppliedTier: TerminalRefreshTier.FOCUSED,
    getRefreshTier: vi.fn(() => TerminalRefreshTier.FOCUSED),
    lastWidth: 0,
    lastHeight: 0,
    resizeJob: undefined,
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    isUserScrolledBack: false,
    isAltBuffer: false,
  } as any;
}

function createDataBuffer() {
  return {
    flushForTerminal: vi.fn(),
    resetForTerminal: vi.fn(),
    getQueuedBytes: vi.fn(() => 0),
    resumeFlush: vi.fn(),
  };
}

function setup(count = 1) {
  const panes = new Map<string, any>();
  for (let i = 0; i < count; i++) panes.set(`term-${i}`, createManaged());
  const dataBuffer = createDataBuffer();
  const controller = new TerminalResizeController({
    getInstance: vi.fn((id: string) => panes.get(id)),
    dataBuffer: dataBuffer as unknown as ResizeControllerDeps["dataBuffer"],
  });
  return { panes, dataBuffer, controller };
}

/**
 * fit() on a host whose grid already matches the proposal (#fit-noop). Bulk
 * refit callers — resetRenderer, repairFontGrid, prewarm, the project-switch
 * suppression clear — hit this on every pane, and each commit costs a sync
 * ingest flush, a PTY resize round trip and a scroll pin for no grid change.
 */
describe("TerminalResizeController fit() on an unchanged grid", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizeMock.mockReset();
    getEffectiveAgentConfigMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits nothing when N fits land on the grid xterm and the PTY already hold", () => {
    const N = 100;
    const { panes, dataBuffer, controller } = setup();
    const managed = panes.get("term-0");

    // First fit is a real grid change and must commit.
    expect(controller.fit("term-0")).toEqual(PROPOSAL);
    resizeMock.mockClear();
    dataBuffer.flushForTerminal.mockClear();
    managed.terminal.scrollToBottom.mockClear();
    managed.terminal.resize.mockClear();

    for (let i = 0; i < N; i++) {
      expect(controller.fit("term-0")).toEqual(PROPOSAL);
    }

    const metrics = {
      fits: N,
      ptyResize: resizeMock.mock.calls.length,
      flushForTerminal: dataBuffer.flushForTerminal.mock.calls.length,
      scrollPins: managed.terminal.scrollToBottom.mock.calls.length,
      xtermResize: managed.terminal.resize.mock.calls.length,
    };
    process.stderr.write(`[bench:fit-noop] ${JSON.stringify(metrics)}` + "\n");

    expect(metrics.ptyResize).toBe(0);
    expect(metrics.flushForTerminal).toBe(0);
    expect(metrics.scrollPins).toBe(0);
    expect(metrics.xtermResize).toBe(0);
    expect(managed.latestCols).toBe(PROPOSAL.cols);
    expect(managed.latestRows).toBe(PROPOSAL.rows);
    expect(managed.lastWidth).toBe(1000);
    expect(managed.lastHeight).toBe(700);
  });

  it("still commits when the grid changes", () => {
    const { panes, controller } = setup();
    const managed = panes.get("term-0");
    controller.fit("term-0");
    resizeMock.mockClear();

    managed.fitAddon.proposeDimensions.mockReturnValue({ cols: 120, rows: 30 });
    expect(controller.fit("term-0")).toEqual({ cols: 120, rows: 30 });
    expect(managed.terminal.resize).toHaveBeenLastCalledWith(120, 30);
    expect(resizeMock).toHaveBeenCalledWith("term-0", 120, 30);
  });

  it("re-asserts when the PTY was last sent a grid other than xterm's", () => {
    // forceImmediateResize asserts the target cache to the PTY without moving
    // xterm; an observer tick on the same box then re-points the cache at
    // xterm's grid without sending anything. The PTY is still elsewhere.
    const { panes, controller } = setup();
    const managed = panes.get("term-0");
    controller.fit("term-0");
    managed.latestCols = 90;
    controller.forceImmediateResize("term-0");
    expect(resizeMock).toHaveBeenLastCalledWith("term-0", 90, PROPOSAL.rows);
    managed.latestCols = PROPOSAL.cols;
    resizeMock.mockClear();

    controller.fit("term-0");
    expect(resizeMock).toHaveBeenCalledWith("term-0", PROPOSAL.cols, PROPOSAL.rows);
  });

  it("keeps an invalidated PTY grid owed across a resize lock", () => {
    const { controller } = setup();
    controller.fit("term-0");
    resizeMock.mockClear();

    controller.invalidatePtyGrid("term-0");
    controller.lockResize("term-0", true);
    expect(controller.fit("term-0")).toBeNull();
    controller.lockResize("term-0", false);
    expect(resizeMock).not.toHaveBeenCalled();

    controller.fit("term-0");
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-0", PROPOSAL.cols, PROPOSAL.rows);

    controller.fit("term-0");
    expect(resizeMock).toHaveBeenCalledTimes(1);
  });

  it("takes the full path while a serialized restore holds its own target", () => {
    const { panes, controller } = setup();
    const managed = panes.get("term-0");
    controller.fit("term-0");
    managed.isSerializedRestoreInProgress = true;
    managed.pendingRestoreGeometry = { cols: 120, rows: 30 };

    controller.fit("term-0");
    expect(managed.pendingRestoreGeometry).toEqual(PROPOSAL);
  });

  it("re-pins the viewport without a PTY resize when the box cache was cleared", () => {
    // updateOptions/repairFontGrid zero the box cache after a text-metric
    // change: the cell count can survive while the pixel geometry does not.
    const { panes, dataBuffer, controller } = setup();
    const managed = panes.get("term-0");
    controller.fit("term-0");
    resizeMock.mockClear();
    dataBuffer.flushForTerminal.mockClear();
    managed.terminal.scrollToBottom.mockClear();

    managed.lastWidth = 0;
    managed.lastHeight = 0;
    controller.fit("term-0");
    expect(managed.terminal.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(resizeMock).not.toHaveBeenCalled();
    expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
  });

  it("does not skip while a queued resize could still move the grid", () => {
    const { panes, controller } = setup();
    const managed = panes.get("term-0");
    controller.fit("term-0");
    resizeMock.mockClear();

    const abort = vi.fn();
    managed.resizeJob = { abort };
    controller.fit("term-0");
    expect(abort).toHaveBeenCalled();
    expect(managed.resizeJob).toBeUndefined();
    expect(resizeMock).toHaveBeenCalledWith("term-0", PROPOSAL.cols, PROPOSAL.rows);
  });

  it("supersedes a pending settled resize instead of letting it fire", () => {
    getEffectiveAgentConfigMock.mockReturnValue({ capabilities: { resizeStrategy: "settled" } });
    const { panes, controller } = setup();
    const managed = panes.get("term-0");
    managed.runtimeAgentId = "codex";
    managed.terminal.cols = PROPOSAL.cols;
    managed.terminal.rows = PROPOSAL.rows;
    managed.latestCols = PROPOSAL.cols;
    managed.latestRows = PROPOSAL.rows;
    managed.ptyCols = PROPOSAL.cols;
    managed.ptyRows = PROPOSAL.rows;

    managed.fitAddon.proposeDimensions.mockReturnValueOnce({ cols: 90, rows: 30 });
    controller.fit("term-0");
    expect(controller.hasPendingResize("term-0")).toBe(true);

    controller.fit("term-0");
    vi.advanceTimersByTime(1000);
    expect(managed.terminal.resize).not.toHaveBeenCalledWith(90, 30);
    expect(managed.terminal.cols).toBe(PROPOSAL.cols);
  });
});

/**
 * A pane held while another view draws its terminal at that view's own size
 * (Canopy's live pane): nothing in this pane may take the PTY back, including
 * the lock-exempt reveal reconcile, until the last hold is released.
 */
describe("TerminalResizeController geometry hold", () => {
  beforeEach(() => {
    resizeMock.mockReset();
    getEffectiveAgentConfigMock.mockReset();
  });

  it("neither fits nor sends a size while held, not even from the reveal reconcile", () => {
    const { panes, controller } = setup();
    const managed = panes.get("term-0");
    controller.holdGeometry("term-0");

    expect(controller.fit("term-0")).toBeNull();
    controller.sendPtyResize("term-0", 100, 30);
    // Reported as done, so a reveal sweep doesn't retry it frame after frame.
    expect(controller.reconcileGeometryFresh("term-0")).toBe(true);

    expect(resizeMock).not.toHaveBeenCalled();
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(managed.terminal.cols).toBe(80);
  });

  it("outlasts a layout transition's unlock", () => {
    const { controller } = setup();
    controller.holdGeometry("term-0");
    controller.lockResize("term-0", true, 1_000);
    controller.lockResize("term-0", false);

    expect(controller.isResizeLocked("term-0")).toBe(true);
    expect(controller.fit("term-0")).toBeNull();
    expect(resizeMock).not.toHaveBeenCalled();
  });

  it("lets go only at the last release, and then the pane fits and sends again", () => {
    const { controller } = setup();
    controller.holdGeometry("term-0");
    controller.holdGeometry("term-0");

    expect(controller.releaseGeometry("term-0")).toBe(false);
    expect(controller.fit("term-0")).toBeNull();

    expect(controller.releaseGeometry("term-0")).toBe(true);
    expect(controller.fit("term-0")).toEqual(PROPOSAL);
    expect(resizeMock).toHaveBeenCalledWith("term-0", PROPOSAL.cols, PROPOSAL.rows);
  });

  it("asks for no re-measure when released under another lock, or never held", () => {
    const { controller } = setup();
    expect(controller.releaseGeometry("term-0")).toBe(false);

    controller.holdGeometry("term-0");
    controller.lockResize("term-0", true, 1_000);
    expect(controller.releaseGeometry("term-0")).toBe(false);
    expect(controller.isResizeLocked("term-0")).toBe(true);
  });

  describe("adopting the PTY's grid while another frontend drives (#13282)", () => {
    it("puts xterm on the PTY's grid without sending anything to the PTY", () => {
      const { panes, dataBuffer, controller } = setup();
      const managed = panes.get("term-0");
      controller.holdGeometry("term-0");

      controller.adoptPtyGeometry("term-0", 200, 50);

      expect(managed.terminal.resize).toHaveBeenCalledWith(200, 50);
      expect(managed.terminal.cols).toBe(200);
      expect(managed.terminal.rows).toBe(50);
      expect(managed.targetCols).toBe(200);
      expect(managed.targetRows).toBe(50);
      expect(dataBuffer.flushForTerminal).toHaveBeenCalledWith("term-0");
      expect(resizeMock).not.toHaveBeenCalled();
      // Still held: the pane's own box can't take the grid back.
      expect(controller.fit("term-0")).toBeNull();
      expect(managed.terminal.cols).toBe(200);
    });

    it("leaves an unheld pane to its own fit", () => {
      const { panes, controller } = setup();
      controller.adoptPtyGeometry("term-0", 200, 50);

      expect(panes.get("term-0").terminal.resize).not.toHaveBeenCalled();
    });

    it("doesn't reflow a pane already on that grid", () => {
      const { panes, dataBuffer, controller } = setup();
      controller.holdGeometry("term-0");

      controller.adoptPtyGeometry("term-0", 80, 24);

      expect(panes.get("term-0").terminal.resize).not.toHaveBeenCalled();
      expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
    });

    it("parks the grid for a serialized restore to normalize to", () => {
      const { panes, controller } = setup();
      const managed = panes.get("term-0");
      managed.isSerializedRestoreInProgress = true;
      controller.holdGeometry("term-0");

      controller.adoptPtyGeometry("term-0", 200, 50);

      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(managed.pendingRestoreGeometry).toEqual({ cols: 200, rows: 50 });
    });

    it("keeps an over-budget backlog queued and resumes it after the resize", () => {
      const { panes, dataBuffer, controller } = setup();
      dataBuffer.getQueuedBytes.mockReturnValue(Number.MAX_SAFE_INTEGER);
      controller.holdGeometry("term-0");

      controller.adoptPtyGeometry("term-0", 200, 50);

      expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
      expect(dataBuffer.resumeFlush).toHaveBeenCalledWith("term-0");
      expect(panes.get("term-0").terminal.resize).toHaveBeenCalledWith(200, 50);
    });
  });

  describe("sending the pane's grid after a watch ends (#13282)", () => {
    // A pane already fit to its box, whose next measurement converges.
    function converged(visible: boolean) {
      const { panes, controller } = setup();
      const managed = panes.get("term-0");
      managed.terminal._core = {
        _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } },
      };
      if (!visible) {
        managed.isVisible = false;
        managed.isFocused = false;
        managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      }
      controller.resize("term-0", 1000, 700, { immediate: true });
      expect(resizeMock).toHaveBeenCalled();
      resizeMock.mockReset();
      managed.lastWidth = 0;
      managed.lastHeight = 0;
      return { managed, controller };
    }

    it.each([
      ["a visible", true],
      ["a background", false],
    ])("sends %s pane's unchanged grid only while the PTY is owed it", (_label, visible) => {
      const { managed, controller } = converged(visible);
      const grid = [managed.terminal.cols, managed.terminal.rows];

      controller.resize("term-0", 1000, 700, { immediate: true });
      expect(resizeMock).not.toHaveBeenCalled();

      managed.lastWidth = 0;
      managed.lastHeight = 0;
      managed.reassertPtyGrid = true;
      controller.resize("term-0", 1000, 700, { immediate: true });

      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledWith("term-0", grid[0], grid[1]);
      expect(managed.reassertPtyGrid).toBeUndefined();
    });
  });
});

// An unfocused, visible pane with a deep buffer: the shape the large-buffer
// debounce applies to.
function createDeepBufferManaged() {
  return {
    terminal: {
      cols: 80,
      rows: 24,
      options: { scrollback: 1000, scrollbar: { width: 14 } },
      buffer: { active: { baseY: 0, viewportY: 0, length: 5000 } },
      resize: vi.fn(function (this: { cols: number; rows: number }, cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
      }),
      write: vi.fn(),
      scrollToBottom: vi.fn(),
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    },
    fitAddon: { fit: vi.fn(), proposeDimensions: vi.fn(() => undefined) },
    hostElement: {
      style: { width: "100%" },
      checkVisibility: vi.fn(() => true),
      getBoundingClientRect: vi.fn(() => ({ left: 0, width: 1000, height: 700 })),
      querySelector: vi.fn(() => null),
    },
    isFocused: false,
    isVisible: true,
    lastAppliedTier: TerminalRefreshTier.VISIBLE,
    getRefreshTier: vi.fn(() => TerminalRefreshTier.VISIBLE),
    lastWidth: 0,
    lastHeight: 0,
    resizeJob: undefined,
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    isUserScrolledBack: false,
    isAltBuffer: false,
  } as any;
}

function setupDeepBuffer() {
  const managed = createDeepBufferManaged();
  const controller = new TerminalResizeController({
    getInstance: vi.fn(() => managed),
    dataBuffer: {
      flushForTerminal: vi.fn(),
      resetForTerminal: vi.fn(),
      getQueuedBytes: vi.fn(() => 0),
      resumeFlush: vi.fn(),
    } as unknown as ResizeControllerDeps["dataBuffer"],
  });
  return { managed, controller };
}

describe("TerminalResizeController immediate request for an already-queued box", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizeMock.mockReset();
    getEffectiveAgentConfigMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the observer's debounced job now instead of deduping the request away", () => {
    const { managed, controller } = setupDeepBuffer();

    // The pane's own observer measures the new box first and is debounced.
    controller.resize("t", 620, 420);
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(controller.hasPendingResize("t")).toBe(true);

    // The grid's leading pass then asks for the same box, immediately.
    controller.resize("t", 620, 420, { immediate: true });

    // (620 - 14px scrollbar) / 10px cells, 420 / 20px rows.
    expect(managed.terminal.resize).toHaveBeenCalledWith(60, 21);
    expect(resizeMock).toHaveBeenCalledWith("t", 60, 21);
    expect(controller.hasPendingResize("t")).toBe(false);

    vi.advanceTimersByTime(500);
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
  });

  it("leaves a debounced job alone when the repeat request is not immediate", () => {
    const { managed, controller } = setupDeepBuffer();
    controller.resize("t", 620, 420);
    controller.resize("t", 620, 420);
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
  });

  describe("a settled-strategy agent", () => {
    function settledSetup() {
      getEffectiveAgentConfigMock.mockReturnValue({ capabilities: { resizeStrategy: "settled" } });
      const ctx = setupDeepBuffer();
      ctx.managed.runtimeAgentId = "codex";
      ctx.managed.isFocused = true;
      return ctx;
    }

    it("still waits for a stable grid when the box may still be moving", () => {
      const { managed, controller } = settledSetup();
      controller.resize("t", 620, 420);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    });

    it("moves both grids at once for a box known to be final", () => {
      const { managed, controller } = settledSetup();
      controller.resize("t", 620, 420, { immediate: true });
      expect(managed.terminal.resize).toHaveBeenCalledWith(60, 21);
      expect(resizeMock).toHaveBeenLastCalledWith("t", 60, 21);
      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    });

    it("commits an already-waiting settle when the final box is confirmed", () => {
      const { managed, controller } = settledSetup();
      controller.resize("t", 620, 420);
      controller.resize("t", 620, 420, { immediate: true });
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    });
  });
});
