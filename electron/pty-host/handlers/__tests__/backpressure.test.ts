import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBackpressureHandlers } from "../backpressure.js";
import type { HostContext, RendererConnection } from "../types.js";

function makeCoordinator() {
  const coord = {
    pause: vi.fn(),
    resume: vi.fn(),
    forceReleaseAll: vi.fn(),
    isPaused: false,
  };
  return coord;
}

function makeRendererConnection(): RendererConnection {
  return {
    port: {
      postMessage: vi.fn(),
    } as unknown as RendererConnection["port"],
    handler: vi.fn(),
    portQueueManager: {
      clearQueue: vi.fn(),
    } as unknown as RendererConnection["portQueueManager"],
    batcher: {} as RendererConnection["batcher"],
  };
}

function makeCtx(overrides: Partial<HostContext> = {}): HostContext {
  return {
    analysisWorkerPool: null,
    ptyManager: {
      getTerminal: vi.fn(() => undefined),
      getAll: vi.fn(() => []),
      setActivityMonitorTier: vi.fn(),
      acknowledgeData: vi.fn(),
      getSerializedStateAsync: vi.fn(async () => null),
      getSerializedState: vi.fn(() => null),
    } as unknown as HostContext["ptyManager"],
    pluginPtyManager: {} as HostContext["pluginPtyManager"],
    processTreeCache: {} as HostContext["processTreeCache"],
    terminalResourceMonitor: {} as HostContext["terminalResourceMonitor"],
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
      getActivityTier: vi.fn(() => "active"),
      stats: { pauseCount: 0, resumeCount: 0, suspendCount: 0, forceResumeCount: 0 },
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
    windowFocusedTerminalMap: new Map(),
    ipcDataMirrorTerminals: new Set(),
    visualBuffers: [],
    visualSignalView: null,
    analysisBuffer: null,
    ptyPool: null,
    initialPoolWarmDeferred: false,
    sendEvent: vi.fn(),
    getPauseCoordinator: vi.fn(),
    getOrCreatePauseCoordinator: vi.fn(),
    disconnectWindow: vi.fn(),
    recomputeActivityTiers: vi.fn(),
    tryReplayAndResume: vi.fn(),
    resumePausedTerminal: vi.fn(),
    createPortQueueManager: vi.fn(),
    createTerminalWorkerPortQueueManager: vi.fn(),
    terminalWorkerConnections: new Map(),
    disconnectTerminalWorkerPort: vi.fn(),
    getPausedDurationsSnapshot: vi.fn(() => []),
    getDropTallySnapshot: vi.fn(() => []),
    ...overrides,
    consoleObservationHub:
      overrides.consoleObservationHub ?? ({} as HostContext["consoleObservationHub"]),
  };
}

describe("force-resume handler", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drains every per-window portQueueManager so port-path pause holds don't leak (#7008)", () => {
    // disconnectWindow handles the normal lifecycle by calling resumeAll +
    // dispose on each connection's manager. force-resume bypasses that path
    // and previously cleared only ipcQueueManager state, leaving stale
    // pausedTerminals + queuedBytes in every per-window port queue manager.
    const coord = makeCoordinator();
    const conn1 = makeRendererConnection();
    const conn2 = makeRendererConnection();
    const rendererConnections = new Map<number, RendererConnection>([
      [1, conn1],
      [2, conn2],
    ]);
    const ctx = makeCtx({
      rendererConnections,
      getPauseCoordinator: vi.fn(() => coord as never),
    });

    const handlers = createBackpressureHandlers(ctx);
    handlers["force-resume"]({ type: "force-resume", id: "term-1" });

    expect(coord.forceReleaseAll).toHaveBeenCalledTimes(1);
    expect(ctx.ipcQueueManager.clearQueue).toHaveBeenCalledWith("term-1");
    expect(conn1.portQueueManager.clearQueue).toHaveBeenCalledWith("term-1");
    expect(conn2.portQueueManager.clearQueue).toHaveBeenCalledWith("term-1");
  });

  it("calls portQueueManager.clearQueue on every connection even when none currently track the terminal", () => {
    // clearQueue is a no-op for terminals not in the manager's maps, so the
    // handler iterates unconditionally rather than tracking which manager
    // owns which terminal.
    const coord = makeCoordinator();
    const conn = makeRendererConnection();
    const ctx = makeCtx({
      rendererConnections: new Map([[1, conn]]),
      getPauseCoordinator: vi.fn(() => coord as never),
    });

    const handlers = createBackpressureHandlers(ctx);
    handlers["force-resume"]({ type: "force-resume", id: "untracked-terminal" });

    expect(conn.portQueueManager.clearQueue).toHaveBeenCalledWith("untracked-terminal");
  });

  it("increments forceResumeCount once per successful force-resume (the counter was previously dead)", () => {
    const coord = makeCoordinator();
    const ctx = makeCtx({
      rendererConnections: new Map([[1, makeRendererConnection()]]),
      getPauseCoordinator: vi.fn(() => coord as never),
    });
    const handlers = createBackpressureHandlers(ctx);

    handlers["force-resume"]({ type: "force-resume", id: "term-1" });
    handlers["force-resume"]({ type: "force-resume", id: "term-2" });

    expect(ctx.backpressureManager.stats.forceResumeCount).toBe(2);
  });

  it("does not increment forceResumeCount when the pause coordinator is missing (early return)", () => {
    const ctx = makeCtx({
      rendererConnections: new Map([[1, makeRendererConnection()]]),
      getPauseCoordinator: vi.fn(() => undefined),
    });
    const handlers = createBackpressureHandlers(ctx);

    handlers["force-resume"]({ type: "force-resume", id: "term-1" });

    expect(ctx.backpressureManager.stats.forceResumeCount).toBe(0);
  });

  it("returns early when the pause coordinator is missing", () => {
    const conn = makeRendererConnection();
    const ctx = makeCtx({
      rendererConnections: new Map([[1, conn]]),
      getPauseCoordinator: vi.fn(() => undefined),
    });

    const handlers = createBackpressureHandlers(ctx);
    handlers["force-resume"]({ type: "force-resume", id: "term-1" });

    expect(ctx.ipcQueueManager.clearQueue).not.toHaveBeenCalled();
    expect(conn.portQueueManager.clearQueue).not.toHaveBeenCalled();
  });

  it("never mutates the activity-tier map — force-resume releases pause holds, not tier state (#9800)", () => {
    // force-resume is a user-driven "unblock this terminal now" escape hatch:
    // it forceReleaseAll()s the coordinator and drains queue state, but the
    // activity tier (active/background) is owned exclusively by set-active-tier
    // / set-active-project recompute. A regression that folded a setActivityTier
    // call into force-resume would silently flip a backgrounded terminal to
    // active, desyncing it from the host's authoritative tier map (the #9778
    // failure class). Assert the tier map is left untouched.
    const coord = makeCoordinator();
    const conn = makeRendererConnection();
    const ctx = makeCtx({
      rendererConnections: new Map([[1, conn]]),
      getPauseCoordinator: vi.fn(() => coord as never),
    });

    const handlers = createBackpressureHandlers(ctx);
    handlers["force-resume"]({ type: "force-resume", id: "term-1" });

    // The pause path ran (proving the handler executed past the early return)...
    expect(coord.forceReleaseAll).toHaveBeenCalledTimes(1);
    // ...but the tier map was never written — neither directly via setActivityTier
    // nor indirectly via a recompute, both of which would desync the tier state.
    expect(ctx.backpressureManager.setActivityTier).not.toHaveBeenCalled();
    expect(ctx.recomputeActivityTiers).not.toHaveBeenCalled();
  });
});
