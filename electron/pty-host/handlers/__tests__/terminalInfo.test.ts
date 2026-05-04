import { describe, it, expect, vi } from "vitest";
import { mapTerminalInfo, narrowDetectedAgentId } from "../terminalInfo.js";
import type { HostContext } from "../types.js";

function createCtx(overrides: Partial<HostContext> = {}): HostContext {
  const ptyManager = {
    isInTrash: vi.fn(() => false),
    getActivityTier: vi.fn(() => "active" as const),
  } as unknown as HostContext["ptyManager"];

  return {
    ptyManager,
    // The mapper only touches `ptyManager`; the rest of the surface is irrelevant
    // for these tests but must satisfy the structural type.
    processTreeCache: {} as HostContext["processTreeCache"],
    terminalResourceMonitor: {} as HostContext["terminalResourceMonitor"],
    backpressureManager: {} as HostContext["backpressureManager"],
    ipcQueueManager: {} as HostContext["ipcQueueManager"],
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

function makeTerminal(overrides: Record<string, unknown> = {}) {
  return {
    id: "term-1",
    projectId: "proj-1",
    kind: "terminal",
    launchAgentId: undefined,
    title: "bash",
    cwd: "/tmp",
    agentState: "idle",
    waitingReason: undefined,
    lastStateChange: 0,
    spawnedAt: 0,
    isTrashed: undefined,
    trashExpiresAt: undefined,
    wasKilled: false,
    isExited: false,
    agentSessionId: undefined,
    agentLaunchFlags: undefined,
    agentModelId: undefined,
    agentPresetId: undefined,
    agentPresetColor: undefined,
    originalAgentPresetId: undefined,
    everDetectedAgent: false,
    detectedAgentId: undefined,
    detectedProcessIconId: undefined,
    ...overrides,
  } as Parameters<typeof mapTerminalInfo>[0];
}

describe("mapTerminalInfo", () => {
  it("derives isTrashed from ptyManager.isInTrash, not the raw record", () => {
    // Lesson #4753: the in-memory TerminalInfo object never carries a
    // populated `isTrashed` field; trash status lives in PtyManager's
    // separate registry. Reading the raw field always yielded undefined,
    // so the bug surfaced as "trashed terminals appear live".
    const isInTrash = vi.fn((id: string) => id === "term-1");
    const ctx = createCtx({
      ptyManager: {
        isInTrash,
        getActivityTier: vi.fn(() => "active" as const),
      } as unknown as HostContext["ptyManager"],
    });

    const t = makeTerminal({ id: "term-1", isTrashed: undefined });
    const result = mapTerminalInfo(t, ctx);

    expect(result.isTrashed).toBe(true);
    expect(isInTrash).toHaveBeenCalledWith("term-1");
  });

  it("ignores a stale isTrashed flag on the raw terminal record", () => {
    // Even if the raw record carries a misleading `isTrashed: true`, the
    // mapper must defer to the PtyManager registry so the IPC payload
    // matches actual flow-control state.
    const ctx = createCtx({
      ptyManager: {
        isInTrash: vi.fn(() => false),
        getActivityTier: vi.fn(() => "active" as const),
      } as unknown as HostContext["ptyManager"],
    });

    const t = makeTerminal({ isTrashed: true });
    const result = mapTerminalInfo(t, ctx);

    expect(result.isTrashed).toBe(false);
  });

  it("computes hasPty from the kill/exit flags", () => {
    const ctx = createCtx();
    expect(mapTerminalInfo(makeTerminal({ wasKilled: false, isExited: false }), ctx).hasPty).toBe(
      true
    );
    expect(mapTerminalInfo(makeTerminal({ wasKilled: true, isExited: false }), ctx).hasPty).toBe(
      false
    );
    expect(mapTerminalInfo(makeTerminal({ wasKilled: false, isExited: true }), ctx).hasPty).toBe(
      false
    );
  });

  it("looks up activityTier per-terminal via ptyManager", () => {
    const getActivityTier = vi.fn(() => "background" as const);
    const ctx = createCtx({
      ptyManager: {
        isInTrash: vi.fn(() => false),
        getActivityTier,
      } as unknown as HostContext["ptyManager"],
    });

    const result = mapTerminalInfo(makeTerminal({ id: "term-42" }), ctx);

    expect(result.activityTier).toBe("background");
    expect(getActivityTier).toHaveBeenCalledWith("term-42");
  });

  it("narrows detectedAgentId to BuiltInAgentId, dropping unknown values", () => {
    const ctx = createCtx();
    expect(mapTerminalInfo(makeTerminal({ detectedAgentId: "claude" }), ctx).detectedAgentId).toBe(
      "claude"
    );
    expect(
      mapTerminalInfo(makeTerminal({ detectedAgentId: "not-an-agent" }), ctx).detectedAgentId
    ).toBeUndefined();
  });
});

describe("narrowDetectedAgentId", () => {
  it("returns the value when it is a built-in agent id", () => {
    expect(narrowDetectedAgentId("claude")).toBe("claude");
  });

  it("returns undefined for unknown values", () => {
    expect(narrowDetectedAgentId("definitely-not-real")).toBeUndefined();
    expect(narrowDetectedAgentId(42)).toBeUndefined();
    expect(narrowDetectedAgentId(undefined)).toBeUndefined();
  });
});
