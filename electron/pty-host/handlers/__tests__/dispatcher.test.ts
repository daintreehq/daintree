import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPtyHostMessageDispatcher } from "../index.js";
import type { HostContext } from "../types.js";
import type { SerializedTerminalSnapshot } from "../../../../shared/types/terminal.js";

// Snapshots cross the pty-host boundary with their capture grid (#11552).
const STATE_PAYLOAD: SerializedTerminalSnapshot = { data: "state-payload", cols: 80, rows: 24 };
import { clearPluginAgentRegistryForTests } from "../../../../shared/config/pluginAgentRegistry.js";
import { getEffectiveAgentConfig } from "../../../../shared/config/agentRegistry.js";
import { clearPluginProcessToolRegistryForTests } from "../../../../shared/config/pluginProcessToolRegistry.js";
import { buildDetectedCandidate } from "../../../services/ProcessDetector/candidateHelpers.js";

function makeCtx(overrides: Partial<HostContext> = {}): HostContext {
  const ptyManager = {
    getTerminal: vi.fn(() => undefined),
    getAvailableTerminals: vi.fn(() => []),
    getTerminalsByState: vi.fn(() => []),
    getAll: vi.fn(() => []),
    getTerminalsForProject: vi.fn(() => []),
    getTerminalInfo: vi.fn(() => ({})),
    getAllTerminalSnapshots: vi.fn(() => []),
    getSerializedStateAsync: vi.fn(async () => STATE_PAYLOAD),
    getSerializedState: vi.fn(() => STATE_PAYLOAD),
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
    let resolveSerialization: (value: SerializedTerminalSnapshot) => void = () => {};
    ctx.ptyManager.getSerializedStateAsync = vi.fn(
      () => new Promise<SerializedTerminalSnapshot>((resolve) => (resolveSerialization = resolve))
    );

    const dispatch = createPtyHostMessageDispatcher(ctx);
    const ret = dispatch({ type: "get-serialized-state", id: "term-1", requestId: 99 });

    // The handler returns void (not a Promise) because the dispatcher does
    // not capture the inner IIFE.
    expect(ret).toBeUndefined();
    // The send has not happened yet because serialization is still pending.
    expect(ctx.sendEvent).not.toHaveBeenCalled();

    resolveSerialization({ data: "payload", cols: 80, rows: 24 });
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.sendEvent).toHaveBeenCalledWith({
      type: "serialized-state",
      requestId: 99,
      id: "term-1",
      state: { data: "payload", cols: 80, rows: 24 },
    });
  });

  it("mirrors the plugin-agent registry into this process (#10587)", () => {
    clearPluginAgentRegistryForTests();
    try {
      const ctx = makeCtx();
      const dispatch = createPtyHostMessageDispatcher(ctx);

      // Before the sync, the pty-host process has no knowledge of the agent.
      expect(getEffectiveAgentConfig("plugin-agent")).toBeUndefined();

      dispatch({
        type: "set-plugin-agent-registry",
        registry: {
          "plugin-agent": {
            id: "plugin-agent",
            name: "Plugin Agent",
            command: "plugin-agent",
            color: "#3366ff",
            iconId: "terminal",
            supportsContextInjection: false,
            detection: { primaryPatterns: ["thinking"] },
          },
        },
      });

      // After the sync, getEffectiveAgentConfig resolves the agent and its
      // detection patterns — exactly what the activity monitor needs at spawn.
      const config = getEffectiveAgentConfig("plugin-agent");
      expect(config).toBeDefined();
      expect(config?.detection?.primaryPatterns).toEqual(["thinking"]);
    } finally {
      clearPluginAgentRegistryForTests();
    }
  });

  it("replaces the plugin-agent registry wholesale on a later sync (#10587)", () => {
    clearPluginAgentRegistryForTests();
    try {
      const ctx = makeCtx();
      const dispatch = createPtyHostMessageDispatcher(ctx);
      const entry = (id: string) => ({
        id,
        name: id,
        command: id,
        color: "#3366ff",
        iconId: "terminal",
        supportsContextInjection: false,
      });

      dispatch({ type: "set-plugin-agent-registry", registry: { "plugin-a": entry("plugin-a") } });
      expect(getEffectiveAgentConfig("plugin-a")).toBeDefined();

      // A subsequent sync (e.g. plugin A unloaded, plugin B loaded) replaces the
      // snapshot wholesale — the absent agent is gone.
      dispatch({ type: "set-plugin-agent-registry", registry: { "plugin-b": entry("plugin-b") } });
      expect(getEffectiveAgentConfig("plugin-a")).toBeUndefined();
      expect(getEffectiveAgentConfig("plugin-b")).toBeDefined();
    } finally {
      clearPluginAgentRegistryForTests();
    }
  });

  it("ignores a malformed plugin-agent registry shape without crashing (#10587)", () => {
    clearPluginAgentRegistryForTests();
    try {
      const ctx = makeCtx();
      const dispatch = createPtyHostMessageDispatcher(ctx);
      // null and array are not valid Record shapes — the handler must no-op them
      // rather than corrupt the snapshot.
      expect(() =>
        dispatch({ type: "set-plugin-agent-registry", registry: null as never })
      ).not.toThrow();
      expect(() =>
        dispatch({ type: "set-plugin-agent-registry", registry: [] as never })
      ).not.toThrow();
      expect(getEffectiveAgentConfig("anything")).toBeUndefined();
    } finally {
      clearPluginAgentRegistryForTests();
    }
  });

  it("mirrors the plugin process-tool registry so detection resolves it (#11613)", () => {
    clearPluginProcessToolRegistryForTests();
    try {
      const ctx = makeCtx();
      const dispatch = createPtyHostMessageDispatcher(ctx);

      // Before the sync this process has never heard of the command, so the
      // detector declines to build a candidate at all.
      expect(buildDetectedCandidate("acme-cli", undefined, 0)).toBeNull();

      dispatch({
        type: "set-plugin-process-tool-registry",
        registry: { "acme-cli": "sparkles" },
      });

      expect(buildDetectedCandidate("acme-cli", undefined, 0)?.processIconId).toBe("sparkles");
    } finally {
      clearPluginProcessToolRegistryForTests();
    }
  });

  it("replaces the plugin process-tool registry wholesale on a later sync (#11613)", () => {
    clearPluginProcessToolRegistryForTests();
    try {
      const ctx = makeCtx();
      const dispatch = createPtyHostMessageDispatcher(ctx);

      dispatch({ type: "set-plugin-process-tool-registry", registry: { "acme-cli": "sparkles" } });
      expect(buildDetectedCandidate("acme-cli", undefined, 0)).not.toBeNull();

      // Plugin A unloaded, plugin B loaded — the absent command stops resolving,
      // which also proves the merged detector map is not a stale module const.
      dispatch({ type: "set-plugin-process-tool-registry", registry: { "other-cli": "globe" } });
      expect(buildDetectedCandidate("acme-cli", undefined, 0)).toBeNull();
      expect(buildDetectedCandidate("other-cli", undefined, 0)?.processIconId).toBe("globe");
    } finally {
      clearPluginProcessToolRegistryForTests();
    }
  });

  it("never lets a mirrored plugin command shadow a built-in tool (#11613)", () => {
    clearPluginProcessToolRegistryForTests();
    try {
      const ctx = makeCtx();
      const dispatch = createPtyHostMessageDispatcher(ctx);

      // The manifest schema rejects this collision at parse time; the merge
      // order is the defense in depth for anything that bypasses the schema.
      dispatch({ type: "set-plugin-process-tool-registry", registry: { vite: "sparkles" } });

      expect(buildDetectedCandidate("vite", undefined, 0)?.processIconId).toBe("vite");
    } finally {
      clearPluginProcessToolRegistryForTests();
    }
  });

  it("ignores a malformed plugin process-tool registry shape without crashing (#11613)", () => {
    clearPluginProcessToolRegistryForTests();
    try {
      const ctx = makeCtx();
      const dispatch = createPtyHostMessageDispatcher(ctx);
      expect(() =>
        dispatch({ type: "set-plugin-process-tool-registry", registry: null as never })
      ).not.toThrow();
      expect(() =>
        dispatch({ type: "set-plugin-process-tool-registry", registry: [] as never })
      ).not.toThrow();
      expect(buildDetectedCandidate("acme-cli", undefined, 0)).toBeNull();
    } finally {
      clearPluginProcessToolRegistryForTests();
    }
  });

  it("returns a promise for handlers that perform real async work", async () => {
    const ctx = makeCtx();
    ctx.ptyManager.gracefulKill = vi.fn(async () => ({ sessionId: "session-42" }));

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
