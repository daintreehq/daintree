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
    port: {} as RendererConnection["port"],
    handler: vi.fn(),
    portQueueManager: {
      clearQueue: vi.fn(),
    } as unknown as RendererConnection["portQueueManager"],
    batcher: {} as RendererConnection["batcher"],
  };
}

function makeCtx(overrides: Partial<HostContext> = {}): HostContext {
  return {
    ptyManager: {
      getTerminal: vi.fn(() => undefined),
      getAll: vi.fn(() => []),
      setActivityMonitorTier: vi.fn(),
      acknowledgeData: vi.fn(),
      getSerializedStateAsync: vi.fn(async () => null),
      getSerializedState: vi.fn(() => null),
    } as unknown as HostContext["ptyManager"],
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

describe("wake-terminal handler", () => {
  function makeWakePtyManager(order: string[], opts: { asyncThrows?: boolean } = {}) {
    return {
      getTerminal: vi.fn(() => undefined),
      getAll: vi.fn(() => []),
      setActivityMonitorTier: vi.fn(),
      acknowledgeData: vi.fn(),
      getSerializedStateAsync: vi.fn(async () => {
        if (opts.asyncThrows) {
          throw new Error("serialize failed");
        }
        order.push("serialized");
        return "snapshot";
      }),
      getSerializedState: vi.fn(() => "fallback"),
    } as unknown as HostContext["ptyManager"];
  }

  it("releases the backpressure hold only after the snapshot is serialized (#9897)", async () => {
    // Resuming the PTY before serialization lets bytes emitted in the gap
    // land in both the snapshot and the live stream — the renderer then
    // replays them twice after restore.
    const order: string[] = [];
    const coord = makeCoordinator();
    coord.resume.mockImplementation(() => {
      order.push("resumed");
    });
    const ctx = makeCtx({
      ptyManager: makeWakePtyManager(order),
      getPauseCoordinator: vi.fn(() => coord as never),
    });
    vi.mocked(ctx.backpressureManager.getPausedInterval).mockReturnValue(
      setTimeout(() => {}, 60_000) as never,
    );

    const handlers = createBackpressureHandlers(ctx);
    await handlers["wake-terminal"]({ type: "wake-terminal", id: "term-1", requestId: "req-1" });

    expect(order).toEqual(["serialized", "resumed"]);
    expect(coord.resume).toHaveBeenCalledExactlyOnceWith("backpressure");
  });

  it("still resumes the hold when async serialization throws (#9896 invariant)", async () => {
    const order: string[] = [];
    const coord = makeCoordinator();
    const ctx = makeCtx({
      ptyManager: makeWakePtyManager(order, { asyncThrows: true }),
      getPauseCoordinator: vi.fn(() => coord as never),
    });
    vi.mocked(ctx.backpressureManager.getPausedInterval).mockReturnValue(
      setTimeout(() => {}, 60_000) as never,
    );

    const handlers = createBackpressureHandlers(ctx);
    await handlers["wake-terminal"]({ type: "wake-terminal", id: "term-1", requestId: "req-1" });

    expect(coord.resume).toHaveBeenCalledExactlyOnceWith("backpressure");
    expect(ctx.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "wake-result", id: "term-1", state: "fallback" }),
    );
  });

  it("does not resume the coordinator when no backpressure pause was active", async () => {
    const coord = makeCoordinator();
    const ctx = makeCtx({
      ptyManager: makeWakePtyManager([]),
      getPauseCoordinator: vi.fn(() => coord as never),
    });

    const handlers = createBackpressureHandlers(ctx);
    await handlers["wake-terminal"]({ type: "wake-terminal", id: "term-1", requestId: "req-1" });

    expect(coord.resume).not.toHaveBeenCalled();
    expect(ctx.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "wake-result", id: "term-1", state: "snapshot" }),
    );
  });
});

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
