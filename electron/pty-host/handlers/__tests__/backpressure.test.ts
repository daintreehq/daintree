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
      getActivityTier: vi.fn(() => "active"),
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
      setTimeout(() => {}, 60_000) as never
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
      setTimeout(() => {}, 60_000) as never
    );

    const handlers = createBackpressureHandlers(ctx);
    await handlers["wake-terminal"]({ type: "wake-terminal", id: "term-1", requestId: "req-1" });

    expect(coord.resume).toHaveBeenCalledExactlyOnceWith("backpressure");
    expect(ctx.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "wake-result", id: "term-1", state: "fallback" })
    );
  });

  it("resumes the hold and sends wake-result when the serializer resolves null", async () => {
    // TerminalSerializerService catches internally and resolves null rather
    // than rejecting — the production failure path is a null resolve.
    const coord = makeCoordinator();
    const ptyManager = makeWakePtyManager([]);
    vi.mocked(ptyManager.getSerializedStateAsync).mockResolvedValue(null);
    const ctx = makeCtx({
      ptyManager,
      getPauseCoordinator: vi.fn(() => coord as never),
    });
    vi.mocked(ctx.backpressureManager.getPausedInterval).mockReturnValue(
      setTimeout(() => {}, 60_000) as never
    );

    const handlers = createBackpressureHandlers(ctx);
    await handlers["wake-terminal"]({ type: "wake-terminal", id: "term-1", requestId: "req-1" });

    expect(coord.resume).toHaveBeenCalledExactlyOnceWith("backpressure");
    expect(ctx.ptyManager.getSerializedState).not.toHaveBeenCalled();
    expect(ctx.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "wake-result", id: "term-1", state: null })
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
      expect.objectContaining({ type: "wake-result", id: "term-1", state: "snapshot" })
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

describe("wake-terminal handler — late-wake tier reconciliation (#9906)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-demotes the host and broadcasts a tier-changed correction when a stale wake lands on a backgrounded terminal", async () => {
    // The renderer backgrounded the pane, but a trailing-edge rate-limited wake
    // fired afterwards and reached the host. Without reconciliation the host
    // stays at "active" (50ms polling) streaming into a hidden terminal, and the
    // renderer's setActivityTier dedup (lastBackendTier === "background") can
    // never re-send the correction. The handler must detect preWakeTier ===
    // "background" and push the host + renderer back to background.
    const coord = makeCoordinator();
    const conn = makeRendererConnection();
    const ctx = makeCtx({
      rendererConnections: new Map([[1, conn]]),
      windowProjectMap: new Map([[1, "proj-a"]]),
      getPauseCoordinator: vi.fn(() => coord as never),
    });
    (ctx.backpressureManager.getActivityTier as ReturnType<typeof vi.fn>).mockReturnValue(
      "background"
    );
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "term-1",
      projectId: "proj-a",
    });

    const handlers = createBackpressureHandlers(ctx);
    await handlers["wake-terminal"]({ type: "wake-terminal", id: "term-1", requestId: "r1" });

    // The wake promoted to active first (snapshot path), then the correction
    // re-demoted with the dedicated reason.
    expect(ctx.backpressureManager.setActivityTier).toHaveBeenCalledWith(
      "term-1",
      "active",
      "wake-terminal"
    );
    expect(ctx.backpressureManager.setActivityTier).toHaveBeenCalledWith(
      "term-1",
      "background",
      "wake-terminal-correction"
    );
    // ActivityMonitor returned to the 500ms background cadence.
    expect(ctx.ptyManager.setActivityMonitorTier).toHaveBeenCalledWith("term-1", 500);
    // The renderer's dedup baseline is reset via the tier-changed broadcast.
    expect(conn.port.postMessage).toHaveBeenCalledWith({
      type: "tier-changed",
      id: "term-1",
      tier: "background",
    });
  });

  it("does not post a correction when the wake lands on an already-active terminal", async () => {
    // A normal wake of a visible/active terminal must not be re-demoted — the
    // correction is strictly for the stale background-desync case.
    const coord = makeCoordinator();
    const conn = makeRendererConnection();
    const ctx = makeCtx({
      rendererConnections: new Map([[1, conn]]),
      windowProjectMap: new Map([[1, "proj-a"]]),
      getPauseCoordinator: vi.fn(() => coord as never),
    });
    (ctx.backpressureManager.getActivityTier as ReturnType<typeof vi.fn>).mockReturnValue("active");
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "term-1",
      projectId: "proj-a",
    });

    const handlers = createBackpressureHandlers(ctx);
    await handlers["wake-terminal"]({ type: "wake-terminal", id: "term-1", requestId: "r2" });

    expect(ctx.backpressureManager.setActivityTier).not.toHaveBeenCalledWith(
      "term-1",
      "background",
      "wake-terminal-correction"
    );
    expect(conn.port.postMessage).not.toHaveBeenCalled();
  });

  it("project-filters the correction broadcast to windows that own the terminal", async () => {
    // The tier-changed broadcast must follow the same project filter as the data
    // path: a window viewing a different project never receives the correction.
    const coord = makeCoordinator();
    const ownerConn = makeRendererConnection();
    const otherConn = makeRendererConnection();
    const ctx = makeCtx({
      rendererConnections: new Map([
        [1, ownerConn],
        [2, otherConn],
      ]),
      windowProjectMap: new Map([
        [1, "proj-a"],
        [2, "proj-b"],
      ]),
      getPauseCoordinator: vi.fn(() => coord as never),
    });
    (ctx.backpressureManager.getActivityTier as ReturnType<typeof vi.fn>).mockReturnValue(
      "background"
    );
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "term-1",
      projectId: "proj-a",
    });

    const handlers = createBackpressureHandlers(ctx);
    await handlers["wake-terminal"]({ type: "wake-terminal", id: "term-1", requestId: "r3" });

    expect(ownerConn.port.postMessage).toHaveBeenCalledWith({
      type: "tier-changed",
      id: "term-1",
      tier: "background",
    });
    expect(otherConn.port.postMessage).not.toHaveBeenCalled();
  });
});
