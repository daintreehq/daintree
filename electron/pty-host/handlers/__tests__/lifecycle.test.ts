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

  const resourceGovernor = {
    trackKilledPid: vi.fn(),
  } as unknown as HostContext["resourceGovernor"];

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
    resourceGovernor,
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

function termInfo(pid?: number) {
  return { ptyProcess: { pid } };
}

describe("lifecycle kill handlers — trackKilledPid", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kill tracks PID", () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>).mockReturnValue(termInfo(1234));
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "kill", id: "t1", reason: "test" });

    expect(ctx.ptyManager.kill).toHaveBeenCalledWith("t1", "test");
    expect(ctx.resourceGovernor.trackKilledPid).toHaveBeenCalledWith(1234);
  });

  it("kill does not track when PID is undefined", () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>).mockReturnValue(termInfo());
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "kill", id: "t1", reason: "test" });

    expect(ctx.ptyManager.kill).toHaveBeenCalledWith("t1", "test");
    expect(ctx.resourceGovernor.trackKilledPid).not.toHaveBeenCalled();
  });

  it("kill-by-project tracks all PIDs", () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminalsForProject as ReturnType<typeof vi.fn>).mockReturnValue([
      "t1",
      "t2",
      "t3",
    ]);
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(termInfo(100))
      .mockReturnValueOnce(termInfo(200))
      .mockReturnValueOnce(termInfo()); // t3 has no PID
    (ctx.ptyManager.killByProject as ReturnType<typeof vi.fn>).mockReturnValue(3);
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "kill-by-project", projectId: "proj-1", requestId: "r1" });

    expect(ctx.ptyManager.killByProject).toHaveBeenCalledWith("proj-1");
    expect(ctx.resourceGovernor.trackKilledPid).toHaveBeenCalledTimes(2);
    expect(ctx.resourceGovernor.trackKilledPid).toHaveBeenCalledWith(100);
    expect(ctx.resourceGovernor.trackKilledPid).toHaveBeenCalledWith(200);
  });

  it("kill-by-project handles empty project", () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminalsForProject as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (ctx.ptyManager.killByProject as ReturnType<typeof vi.fn>).mockReturnValue(0);
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "kill-by-project", projectId: "empty-proj", requestId: "r1" });

    expect(ctx.ptyManager.killByProject).toHaveBeenCalledWith("empty-proj");
    expect(ctx.resourceGovernor.trackKilledPid).not.toHaveBeenCalled();
  });

  it("graceful-kill tracks PID", async () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>).mockReturnValue(termInfo(5678));
    (ctx.ptyManager.gracefulKill as ReturnType<typeof vi.fn>).mockResolvedValue("sess-1");
    const dispatch = createPtyHostMessageDispatcher(ctx);

    await dispatch({ type: "graceful-kill", id: "t1", requestId: "r1" });

    expect(ctx.ptyManager.gracefulKill).toHaveBeenCalledWith("t1");
    expect(ctx.resourceGovernor.trackKilledPid).toHaveBeenCalledWith(5678);
  });

  it("graceful-kill does not track when PID is undefined", async () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>).mockReturnValue(termInfo());
    (ctx.ptyManager.gracefulKill as ReturnType<typeof vi.fn>).mockResolvedValue("sess-1");
    const dispatch = createPtyHostMessageDispatcher(ctx);

    await dispatch({ type: "graceful-kill", id: "t1", requestId: "r1" });

    expect(ctx.resourceGovernor.trackKilledPid).not.toHaveBeenCalled();
  });

  it("graceful-kill-by-project tracks all PIDs", async () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminalsForProject as ReturnType<typeof vi.fn>).mockReturnValue([
      "t1",
      "t2",
    ]);
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(termInfo(300))
      .mockReturnValueOnce(termInfo(400));
    (ctx.ptyManager.gracefulKillByProject as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "t1", agentSessionId: "s1" },
      { id: "t2", agentSessionId: "s2" },
    ]);
    const dispatch = createPtyHostMessageDispatcher(ctx);

    await dispatch({ type: "graceful-kill-by-project", projectId: "proj-1", requestId: "r1" });

    expect(ctx.ptyManager.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
      preserveSession: undefined,
    });
    expect(ctx.resourceGovernor.trackKilledPid).toHaveBeenCalledTimes(2);
    expect(ctx.resourceGovernor.trackKilledPid).toHaveBeenCalledWith(300);
    expect(ctx.resourceGovernor.trackKilledPid).toHaveBeenCalledWith(400);
  });

  it("graceful-kill-by-project forwards preserveSession to the registry (#10054)", async () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminalsForProject as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (ctx.ptyManager.gracefulKillByProject as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const dispatch = createPtyHostMessageDispatcher(ctx);

    await dispatch({
      type: "graceful-kill-by-project",
      projectId: "proj-1",
      requestId: "r1",
      preserveSession: true,
    });

    expect(ctx.ptyManager.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
      preserveSession: true,
    });
  });

  it("graceful-kill-by-project handles empty project", async () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminalsForProject as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (ctx.ptyManager.gracefulKillByProject as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const dispatch = createPtyHostMessageDispatcher(ctx);

    await dispatch({ type: "graceful-kill-by-project", projectId: "empty", requestId: "r1" });

    expect(ctx.resourceGovernor.trackKilledPid).not.toHaveBeenCalled();
  });
});
