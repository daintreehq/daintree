import { describe, it, expect, expectTypeOf, vi } from "vitest";
import { mapTerminalInfo, narrowDetectedAgentId } from "../terminalInfo.js";
import type { HostContext } from "../types.js";
import type { PtyHostTerminalInfo } from "../../../../shared/types/pty-host.js";

function createCtx(overrides: Partial<HostContext> = {}): HostContext {
  const ptyManager = {
    isInTrash: vi.fn(() => false),
    getActivityTier: vi.fn(() => "active" as const),
  } as unknown as HostContext["ptyManager"];

  return {
    analysisWorkerPool: null,
    ptyManager,
    // The mapper only touches `ptyManager`; the rest of the surface is irrelevant
    // for these tests but must satisfy the structural type.
    pluginPtyManager: {} as HostContext["pluginPtyManager"],
    processTreeCache: {} as HostContext["processTreeCache"],
    terminalResourceMonitor: {} as HostContext["terminalResourceMonitor"],
    backpressureManager: {} as HostContext["backpressureManager"],
    ipcQueueManager: {} as HostContext["ipcQueueManager"],
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
    lastInputTime: 0,
    lastOutputTime: 0,
    spawnedAt: 0,
    isTrashed: undefined,
    trashExpiresAt: undefined,
    wasKilled: false,
    isExited: false,
    agentSessionId: undefined,
    agentLaunchFlags: undefined,
    agentModelId: undefined,
    worktreeId: undefined,
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
  it("reports the assistant stamp back to main", () => {
    // #10927: a spawn-time field present in four of five layers still vanishes
    // silently. Main's teardown and hydration paths only ever see the record
    // through this mapper, so dropping it here would quietly restore #12183.
    const ctx = createCtx();
    expect(mapTerminalInfo(makeTerminal({ isAssistantTerminal: true }), ctx)).toMatchObject({
      isAssistantTerminal: true,
    });
    expect(mapTerminalInfo(makeTerminal(), ctx).isAssistantTerminal).toBeUndefined();
  });

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

  it("forwards lastInputTime/lastOutputTime so idle detection can run (#10054)", () => {
    // IdleTerminalNotificationService reads these off get-all-terminals; if the
    // mapper drops them, idle computation falls back to "unknown activity" and
    // notifications never fire.
    const ctx = createCtx();
    const result = mapTerminalInfo(makeTerminal({ lastInputTime: 111, lastOutputTime: 222 }), ctx);
    expect(result.lastInputTime).toBe(111);
    expect(result.lastOutputTime).toBe(222);
  });

  it("forwards worktreeId so fleet rows keep their worktree attribution (#12078)", () => {
    // FleetSnapshotService copies worktreeId onto every FleetRunRow and the
    // palette groups on it; a dropped field files every agent under the single
    // "No worktree" heading no matter which worktree it actually runs in.
    const ctx = createCtx();
    const t = makeTerminal({ worktreeId: "/repo/.worktrees/feature" });

    expect(mapTerminalInfo(t, ctx).worktreeId).toBe(t.worktreeId);
  });

  it("leaves a worktree-less terminal unattributed rather than guessing from cwd", () => {
    const ctx = createCtx();
    const result = mapTerminalInfo(makeTerminal({ cwd: "/repo" }), ctx);

    expect(result.worktreeId).toBeUndefined();
  });

  it("emits exactly the field set the host response type declares", () => {
    // Compile-time only. Nearly every field on PtyHostTerminalInfo is optional,
    // so dropping one from the mapper still type-checks at all four call sites
    // — which is how #12078 shipped. Equality (not a subset check) is the point:
    // it also catches the mapper growing a field the wire type never declared,
    // which is how `lastObservedTitle` rode across undeclared for as long as it
    // did.
    expectTypeOf<keyof ReturnType<typeof mapTerminalInfo>>().toEqualTypeOf<
      keyof PtyHostTerminalInfo
    >();
  });

  it("reports the pty handle's live grid so restore can rebuild on it (#11718)", () => {
    // A renderer rebuilding a pane after a view eviction constructs its xterm at
    // 80×24 and has no other way to learn where the surviving PTY sits.
    const ctx = createCtx();
    const result = mapTerminalInfo(makeTerminal({ ptyProcess: { cols: 203, rows: 51 } }), ctx);
    expect(result.ptyCols).toBe(203);
    expect(result.ptyRows).toBe(51);
  });

  it("reports no grid for a dead record, whose last grid is not a live one", () => {
    const ctx = createCtx();
    const exited = mapTerminalInfo(
      makeTerminal({ isExited: true, ptyProcess: { cols: 203, rows: 51 } }),
      ctx
    );
    expect(exited.ptyCols).toBeUndefined();
    const killed = mapTerminalInfo(
      makeTerminal({ wasKilled: true, ptyProcess: { cols: 203, rows: 51 } }),
      ctx
    );
    expect(killed.ptyCols).toBeUndefined();
  });

  it("survives a throwing native dimension getter instead of failing the query", () => {
    // The getters are native and can throw once the pty is torn down. An
    // uncaught throw would take out the whole response: `get-terminal` degrades
    // to null (the record vanishes from restore) and the batch families lose an
    // entire shard.
    const ctx = createCtx();
    const throwing = makeTerminal({
      ptyProcess: {
        get cols(): number {
          throw new Error("pty gone");
        },
        get rows(): number {
          throw new Error("pty gone");
        },
      },
    });
    const result = mapTerminalInfo(throwing, ctx);
    expect(result.ptyCols).toBeUndefined();
    // The rest of the payload must still map — one dead field is not a dead record.
    expect(result.id).toBe("term-1");
    expect(result.hasPty).toBe(true);
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
