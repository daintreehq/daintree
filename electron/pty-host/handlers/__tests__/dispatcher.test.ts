import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPtyHostMessageDispatcher } from "../index.js";
import type { HostContext } from "../types.js";

function makeCtx(overrides: Partial<HostContext> = {}): HostContext {
  const ptyManager = {
    getTerminal: vi.fn(() => undefined),
    getAvailableTerminals: vi.fn(() => []),
    getTerminalsByState: vi.fn(() => []),
    getAll: vi.fn(() => []),
    getTerminalsForProject: vi.fn(() => []),
    getTerminalInfo: vi.fn(() => ({})),
    getAllTerminalSnapshots: vi.fn(() => []),
    getSerializedStateAsync: vi.fn(async () => "state-payload"),
    getSerializedState: vi.fn(() => "state-payload"),
    isInTrash: vi.fn(() => false),
    getActivityTier: vi.fn(() => "active" as const),
    setAnalysisEnabled: vi.fn(),
    setSabMode: vi.fn(),
    isSabMode: vi.fn(() => false),
    write: vi.fn(),
    submit: vi.fn(),
    resize: vi.fn(),
    spawn: vi.fn(),
    kill: vi.fn(),
    trash: vi.fn(),
    restore: vi.fn(),
    killByProject: vi.fn(() => 0),
    gracefulKill: vi.fn(async () => undefined),
    gracefulKillByProject: vi.fn(async () => []),
    getProjectStats: vi.fn(() => ({
      terminalCount: 0,
      processIds: [],
      terminalTypes: [],
    })),
    markChecked: vi.fn(),
    updateObservedTitle: vi.fn(),
    transitionState: vi.fn(() => true),
    trimScrollback: vi.fn(),
    setActivityMonitorTier: vi.fn(),
    setProcessTreeCache: vi.fn(),
    setPtyPool: vi.fn(),
    acknowledgeData: vi.fn(),
    flushAgentSnapshot: vi.fn(),
    tryWrite: vi.fn(() => ({ ok: true })),
    on: vi.fn(),
  } as unknown as HostContext["ptyManager"];

  return {
    ptyManager,
    processTreeCache: { setPollInterval: vi.fn() } as unknown as HostContext["processTreeCache"],
    terminalResourceMonitor: {
      setEnabled: vi.fn(),
    } as unknown as HostContext["terminalResourceMonitor"],
    backpressureManager: {
      isPaused: vi.fn(() => false),
      hasPendingSegments: vi.fn(() => false),
      setActivityTier: vi.fn(),
      clearSuspended: vi.fn(),
      clearPendingVisual: vi.fn(),
      getPausedInterval: vi.fn(() => undefined),
      deletePausedInterval: vi.fn(),
      getPauseStartTime: vi.fn(() => undefined),
      deletePauseStartTime: vi.fn(),
      emitTerminalStatus: vi.fn(),
      emitReliabilityMetric: vi.fn(),
    } as unknown as HostContext["backpressureManager"],
    ipcQueueManager: {
      removeBytes: vi.fn(),
      tryResume: vi.fn(),
      clearQueue: vi.fn(),
    } as unknown as HostContext["ipcQueueManager"],
    resourceGovernor: {} as HostContext["resourceGovernor"],
    packetFramer: {} as HostContext["packetFramer"],
    pauseCoordinators: new Map(),
    rendererConnections: new Map(),
    windowProjectMap: new Map(),
    ipcDataMirrorTerminals: new Set(),
    visualBuffers: [],
    visualSignalView: null,
    analysisBuffer: null,
    ptyPool: null,
    sendEvent: vi.fn(),
    getPauseCoordinator: vi.fn(),
    getOrCreatePauseCoordinator: vi.fn(),
    disconnectWindow: vi.fn(),
    recomputeActivityTiers: vi.fn(),
    tryReplayAndResume: vi.fn(),
    resumePausedTerminal: vi.fn(),
    createPortQueueManager: vi.fn(),
    ...overrides,
  };
}

describe("createPtyHostMessageDispatcher", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes a known message type to the matching handler", () => {
    const ctx = makeCtx();
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "write", id: "term-1", data: "hello", traceId: "t-1" });

    expect(ctx.ptyManager.write).toHaveBeenCalledWith("term-1", "hello", "t-1");
  });

  it("logs a warning and returns nothing for unknown message types", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx();
    const dispatch = createPtyHostMessageDispatcher(ctx);

    const result = dispatch({ type: "no-such-message" });

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[PtyHost] Unknown message type:", "no-such-message");
  });

  it("treats prototype-chain keys as unknown message types", () => {
    // The handler map is built with Object.create(null) so that message
    // types colliding with Object.prototype methods ("constructor",
    // "toString", "hasOwnProperty", "__proto__") don't silently dispatch
    // to an inherited function instead of falling through to the warning.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx();
    const dispatch = createPtyHostMessageDispatcher(ctx);

    for (const type of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      warn.mockClear();
      const result = dispatch({ type });
      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledWith("[PtyHost] Unknown message type:", type);
    }
  });

  it("returns synchronously for fire-and-forget get-serialized-state", async () => {
    // get-serialized-state intentionally fires an internal IIFE that the
    // handler does NOT await. The dispatcher therefore returns immediately
    // (returning undefined, not a Promise), so subsequent messages are not
    // blocked while serialization runs.
    const ctx = makeCtx();
    let resolveSerialization: (value: string) => void = () => {};
    ctx.ptyManager.getSerializedStateAsync = vi.fn(
      () => new Promise<string>((resolve) => (resolveSerialization = resolve))
    );

    const dispatch = createPtyHostMessageDispatcher(ctx);
    const ret = dispatch({ type: "get-serialized-state", id: "term-1", requestId: 99 });

    // The handler returns void (not a Promise) because the dispatcher does
    // not capture the inner IIFE.
    expect(ret).toBeUndefined();
    // The send has not happened yet because serialization is still pending.
    expect(ctx.sendEvent).not.toHaveBeenCalled();

    resolveSerialization("payload");
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.sendEvent).toHaveBeenCalledWith({
      type: "serialized-state",
      requestId: 99,
      id: "term-1",
      state: "payload",
    });
  });

  it("returns a promise for handlers that perform real async work", async () => {
    const ctx = makeCtx();
    ctx.ptyManager.gracefulKill = vi.fn(async () => "session-42");

    const dispatch = createPtyHostMessageDispatcher(ctx);
    const ret = dispatch({ type: "graceful-kill", id: "term-1", requestId: 7 });

    expect(ret).toBeInstanceOf(Promise);
    await ret;
    expect(ctx.sendEvent).toHaveBeenCalledWith({
      type: "graceful-kill-result",
      requestId: 7,
      id: "term-1",
      agentSessionId: "session-42",
    });
  });
});
