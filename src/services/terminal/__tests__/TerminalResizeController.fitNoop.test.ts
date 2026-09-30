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

/**
 * fit() on a host whose grid already matches the proposal (#fit-noop). Bulk
 * refit callers — resetRenderer, repairFontGrid, prewarm, the project-switch
 * suppression clear — hit this on every pane, and each commit costs a sync
 * ingest flush, a PTY resize round trip and a scroll pin for no grid change.
 */

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

  it("times a 20-terminal refit loop on a stable layout", () => {
    vi.useRealTimers();
    const TERMINALS = 20;
    const ROUNDS = 500;
    const { panes, dataBuffer, controller } = setup(TERMINALS);
    for (const id of panes.keys()) controller.fit(id);
    resizeMock.mockClear();
    dataBuffer.flushForTerminal.mockClear();

    for (let r = 0; r < 20; r++) for (const id of panes.keys()) controller.fit(id);
    resizeMock.mockClear();
    dataBuffer.flushForTerminal.mockClear();

    const start = performance.now();
    for (let r = 0; r < ROUNDS; r++) {
      for (const id of panes.keys()) controller.fit(id);
    }
    const elapsed = performance.now() - start;
    process.stderr.write(
      `[bench:fit-noop-loop] ${JSON.stringify({
        terminals: TERMINALS,
        rounds: ROUNDS,
        usPerLoop: Number(((elapsed * 1000) / ROUNDS).toFixed(2)),
        ptyResizePerLoop: resizeMock.mock.calls.length / ROUNDS,
        flushesPerLoop: dataBuffer.flushForTerminal.mock.calls.length / ROUNDS,
      })}` + "\n"
    );
    expect(resizeMock).not.toHaveBeenCalled();
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
