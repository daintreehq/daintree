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
    startProcessDetectorForTerminal: vi.fn(),
    kill: vi.fn(),
    trash: vi.fn(),
    restore: vi.fn(),
    killByProject: vi.fn(() => 0),
    gracefulKill: vi.fn(async () => ({ sessionId: null })),
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
    analysisWorkerPool: null,
    ptyManager,
    pluginPtyManager: {} as HostContext["pluginPtyManager"],
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

  it("kill does not track when PID is 0 (Windows ConPTY transient, #10787)", () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>).mockReturnValue(termInfo(0));
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "kill", id: "t1", reason: "test" });

    expect(ctx.ptyManager.kill).toHaveBeenCalledWith("t1", "test");
    expect(ctx.resourceGovernor.trackKilledPid).not.toHaveBeenCalled();
  });

  it("kill-by-project skips PID 0 and undefined, tracks only valid PIDs (#10787)", () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminalsForProject as ReturnType<typeof vi.fn>).mockReturnValue([
      "t1",
      "t2",
      "t3",
    ]);
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(termInfo(0)) // transient ConPTY PID
      .mockReturnValueOnce(termInfo(500))
      .mockReturnValueOnce(termInfo()); // no PID
    (ctx.ptyManager.killByProject as ReturnType<typeof vi.fn>).mockReturnValue(3);
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "kill-by-project", projectId: "proj-1", requestId: "r1" });

    expect(ctx.resourceGovernor.trackKilledPid).toHaveBeenCalledTimes(1);
    expect(ctx.resourceGovernor.trackKilledPid).toHaveBeenCalledWith(500);
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
    (ctx.ptyManager.gracefulKill as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "sess-1",
    });
    const dispatch = createPtyHostMessageDispatcher(ctx);

    await dispatch({ type: "graceful-kill", id: "t1", requestId: "r1" });

    expect(ctx.ptyManager.gracefulKill).toHaveBeenCalledWith("t1");
    expect(ctx.resourceGovernor.trackKilledPid).toHaveBeenCalledWith(5678);
  });

  it("graceful-kill does not track when PID is undefined", async () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>).mockReturnValue(termInfo());
    (ctx.ptyManager.gracefulKill as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "sess-1",
    });
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

describe("lifecycle spawn — terminal-pid gating and deferred retry (#10787)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function getMock(ctx: HostContext) {
    return ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>;
  }

  it("emits terminal-pid immediately when the PID is valid (no retry)", () => {
    const ctx = makeCtx();
    getMock(ctx).mockReturnValue(termInfo(1234));
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: {} });

    expect(ctx.sendEvent).toHaveBeenCalledWith({ type: "terminal-pid", id: "t1", pid: 1234 });
    // Detector is started by the spawn path itself, not the deferred retry.
    expect(ctx.ptyManager.startProcessDetectorForTerminal).not.toHaveBeenCalled();
  });

  it("does not emit terminal-pid with a transient 0 PID; defers instead", () => {
    const ctx = makeCtx();
    getMock(ctx).mockReturnValue(termInfo(0));
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: {} });

    expect(ctx.sendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "terminal-pid" })
    );
  });

  it("recovers the real PID via deferred retry, then emits and starts detection", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    getMock(ctx)
      .mockReturnValueOnce(termInfo(0)) // synchronous spawn read
      .mockReturnValueOnce(termInfo(0)) // retry attempt 0 — still resolving
      .mockReturnValue(termInfo(4321)); // retry attempt 1 — ConPTY resolved
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: {} });
    await vi.runAllTimersAsync();

    expect(ctx.sendEvent).toHaveBeenCalledWith({ type: "terminal-pid", id: "t1", pid: 4321 });
    expect(ctx.ptyManager.startProcessDetectorForTerminal).toHaveBeenCalledTimes(1);
    expect(ctx.ptyManager.startProcessDetectorForTerminal).toHaveBeenCalledWith("t1");
    // The transient 0 must never have been emitted at any point.
    const pidEvents = (ctx.sendEvent as ReturnType<typeof vi.fn>).mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "terminal-pid");
    expect(pidEvents).toEqual([{ type: "terminal-pid", id: "t1", pid: 4321 }]);
  });

  it("abandons the retry if the terminal disappears before the PID resolves", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    getMock(ctx)
      .mockReturnValueOnce(termInfo(0)) // synchronous spawn read
      .mockReturnValue(undefined); // killed/trashed before retry fires
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: {} });
    await vi.runAllTimersAsync();

    expect(ctx.sendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "terminal-pid" })
    );
    expect(ctx.ptyManager.startProcessDetectorForTerminal).not.toHaveBeenCalled();
  });

  it("gives up after the retry cap when the PID never resolves", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    getMock(ctx).mockReturnValue(termInfo(0)); // never resolves
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: {} });
    await vi.runAllTimersAsync();

    expect(ctx.sendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "terminal-pid" })
    );
    expect(ctx.ptyManager.startProcessDetectorForTerminal).not.toHaveBeenCalled();
    // Bounded: spawn read + at most PID_RETRY_MAX_ATTEMPTS (20) polls.
    expect(getMock(ctx).mock.calls.length).toBeLessThanOrEqual(21);
  });
});

describe("lifecycle spawn — failed-to-start synthesizes an exit for launched agents (#10816)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sentEvents(ctx: HostContext) {
    return (ctx.sendEvent as ReturnType<typeof vi.fn>).mock.calls.map(([event]) => event);
  }

  it("emits agent-spawned then agent-state(exited) then spawn-result when launchAgentId is set", () => {
    const ctx = makeCtx();
    (ctx.ptyManager.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("ENOENT: command not found");
    });
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: { launchAgentId: "claude" } });

    const events = sentEvents(ctx);
    const spawned = events.find((e) => e.type === "agent-spawned");
    const state = events.find((e) => e.type === "agent-state");
    const result = events.find((e) => e.type === "spawn-result");

    expect(spawned).toMatchObject({
      type: "agent-spawned",
      payload: { agentId: "claude", terminalId: "t1" },
    });
    expect(state).toMatchObject({
      type: "agent-state",
      id: "t1",
      agentId: "claude",
      state: "exited",
      previousState: "working",
      trigger: "exit",
    });
    expect(result).toMatchObject({ type: "spawn-result", id: "t1" });

    expect((result as { result: { success: boolean } }).result.success).toBe(false);

    // Order: agent-spawned resets store state before agent-state writes "exited",
    // and both precede spawn-result.
    const order = events
      .map((e) => e.type)
      .filter((t) => t === "agent-spawned" || t === "agent-state" || t === "spawn-result");
    expect(order).toEqual(["agent-spawned", "agent-state", "spawn-result"]);
  });

  it("emits only spawn-result on a failed plain-shell spawn (no launchAgentId)", () => {
    const ctx = makeCtx();
    (ctx.ptyManager.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: {} });

    const events = sentEvents(ctx);
    expect(events.find((e) => e.type === "agent-spawned")).toBeUndefined();
    expect(events.find((e) => e.type === "agent-state")).toBeUndefined();
    expect(events.find((e) => e.type === "spawn-result")).toMatchObject({
      type: "spawn-result",
      id: "t1",
    });
  });

  it("does not synthesize exit events on a successful spawn", () => {
    const ctx = makeCtx();
    getMockTerminal(ctx).mockReturnValue(termInfo(1234));
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: { launchAgentId: "claude" } });

    const events = sentEvents(ctx);
    expect(events.find((e) => e.type === "agent-spawned")).toBeUndefined();
    expect(events.find((e) => e.type === "agent-state")).toBeUndefined();
  });

  function getMockTerminal(ctx: HostContext) {
    return ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>;
  }
});

describe("lifecycle spawn — TERMINAL_ALREADY_LIVE rejection protects the live owner (#11341)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sentEvents(ctx: HostContext) {
    return (ctx.sendEvent as ReturnType<typeof vi.fn>).mock.calls.map(([event]) => event);
  }

  function throwAlreadyLive(ctx: HostContext) {
    (ctx.ptyManager.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const error = new Error("Terminal t1 already has a live owner") as NodeJS.ErrnoException;
      error.code = "TERMINAL_ALREADY_LIVE";
      throw error;
    });
  }

  it("preserves the TERMINAL_ALREADY_LIVE code on spawn-result", () => {
    const ctx = makeCtx();
    throwAlreadyLive(ctx);
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: {} });

    const result = sentEvents(ctx).find((e) => e.type === "spawn-result") as {
      result: { success: boolean; error?: { code: string } };
    };
    expect(result.result.success).toBe(false);
    expect(result.result.error?.code).toBe("TERMINAL_ALREADY_LIVE");
  });

  it("does not synthesize an agent exit for a live-collision rejection", () => {
    const ctx = makeCtx();
    throwAlreadyLive(ctx);
    const dispatch = createPtyHostMessageDispatcher(ctx);

    // launchAgentId is set, but the pre-existing agent is still running, so a
    // synthetic "exited" would falsely mark the live agent dead.
    dispatch({ type: "spawn", id: "t1", options: { launchAgentId: "claude" } });

    const events = sentEvents(ctx);
    expect(events.find((e) => e.type === "agent-spawned")).toBeUndefined();
    expect(events.find((e) => e.type === "agent-state")).toBeUndefined();
  });

  it("keeps the live owner's pause coordinator on a rejection", () => {
    const forceReleaseAll = vi.fn();
    const pauseCoordinators = new Map([
      ["t1", { forceReleaseAll }],
    ]) as unknown as HostContext["pauseCoordinators"];
    const ctx = makeCtx({ pauseCoordinators });
    throwAlreadyLive(ctx);
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: {} });

    // The retirement lives in the success path, so a rejected spawn never tears
    // down the still-running terminal's coordinator.
    expect(forceReleaseAll).not.toHaveBeenCalled();
    expect(pauseCoordinators.has("t1")).toBe(true);
  });

  it("retires the stale coordinator and creates a fresh one on a successful respawn", () => {
    const forceReleaseAll = vi.fn();
    const pauseCoordinators = new Map([
      ["t1", { forceReleaseAll }],
    ]) as unknown as HostContext["pauseCoordinators"];
    const ctx = makeCtx({ pauseCoordinators });
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>).mockReturnValue(termInfo(1234));
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: {} });

    // A real respawn (dead/preserved entry replaced) still tears down the stale
    // coordinator and eagerly creates the successor's — but only after the spawn
    // committed, so the retirement can never strand a live owner.
    expect(forceReleaseAll).toHaveBeenCalledTimes(1);
    expect(pauseCoordinators.has("t1")).toBe(false);
    expect(ctx.getOrCreatePauseCoordinator).toHaveBeenCalledWith("t1");
    const spawnOrder = (ctx.ptyManager.spawn as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const retireOrder = forceReleaseAll.mock.invocationCallOrder[0];
    expect(spawnOrder).toBeLessThan(retireOrder);
  });

  it("does not inject postSpawnInput into the pre-existing live PTY", () => {
    const ctx = makeCtx();
    throwAlreadyLive(ctx);
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: { postSpawnInput: "claude\r" } });

    expect(ctx.ptyManager.write).not.toHaveBeenCalled();
  });

  it("delivers postSpawnInput once on a successful spawn", () => {
    const ctx = makeCtx();
    (ctx.ptyManager.getTerminal as ReturnType<typeof vi.fn>).mockReturnValue(termInfo(1234));
    const dispatch = createPtyHostMessageDispatcher(ctx);

    dispatch({ type: "spawn", id: "t1", options: { postSpawnInput: "claude\r" } });

    expect(ctx.ptyManager.write).toHaveBeenCalledTimes(1);
    expect(ctx.ptyManager.write).toHaveBeenCalledWith("t1", "claude\r");
  });
});
