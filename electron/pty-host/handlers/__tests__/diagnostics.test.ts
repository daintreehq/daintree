import { describe, it, expect, vi } from "vitest";
import { createDiagnosticsHandlers } from "../diagnostics.js";
import type { HostContext, RendererConnection } from "../types.js";
import type { FlowControlSnapshot } from "../../../../shared/types/pty-host.js";

function makePortConnection(
  snapshot: {
    totalPendingBytes: number;
    perTerminal: Array<{ terminalId: string; pendingBytes: number }>;
  } = {
    totalPendingBytes: 0,
    perTerminal: [],
  }
): RendererConnection {
  return {
    port: {} as RendererConnection["port"],
    handler: vi.fn(),
    portQueueManager: {
      getQueueSnapshot: vi.fn(() => snapshot),
    } as unknown as RendererConnection["portQueueManager"],
    batcher: {} as RendererConnection["batcher"],
  };
}

function makeCtx(overrides: Partial<HostContext> = {}): HostContext {
  return {
    ptyManager: {} as HostContext["ptyManager"],
    processTreeCache: {} as HostContext["processTreeCache"],
    terminalResourceMonitor: {} as HostContext["terminalResourceMonitor"],
    backpressureManager: {
      terminalStatusesMap: new Map(),
      suspendedSet: new Set(),
      pauseStartTimesMap: new Map(),
      getPauseStartTime: vi.fn(() => undefined),
      isSuspended: vi.fn(() => false),
      getActivityTier: vi.fn(() => "active"),
      stats: { pauseCount: 3, resumeCount: 2, suspendCount: 1, forceResumeCount: 0 },
    } as unknown as HostContext["backpressureManager"],
    ipcQueueManager: {
      getQueueSnapshot: vi.fn(() => ({ totalPendingBytes: 0, perTerminal: [] })),
    } as unknown as HostContext["ipcQueueManager"],
    resourceGovernor: {
      getSnapshot: vi.fn(() => ({
        isThrottling: false,
        isWarning: false,
        activeProfile: "balanced",
        smoothedUtilizationPercent: null,
        throttleDurationMs: 0,
      })),
    } as unknown as HostContext["resourceGovernor"],
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
    getPauseCoordinator: vi.fn(() => undefined),
    getOrCreatePauseCoordinator: vi.fn(),
    disconnectWindow: vi.fn(),
    recomputeActivityTiers: vi.fn(),
    tryReplayAndResume: vi.fn(),
    resumePausedTerminal: vi.fn(),
    createPortQueueManager: vi.fn(),
    getPausedDurationsSnapshot: vi.fn(() => []),
    ...overrides,
  };
}

function runSnapshot(ctx: HostContext): FlowControlSnapshot {
  const handlers = createDiagnosticsHandlers(ctx);
  handlers["get-flow-control-snapshot"]({ type: "get-flow-control-snapshot", requestId: "req-1" });
  const sendEvent = ctx.sendEvent as unknown as ReturnType<typeof vi.fn>;
  expect(sendEvent).toHaveBeenCalledTimes(1);
  const event = sendEvent.mock.calls[0][0];
  expect(event.type).toBe("flow-control-snapshot");
  // requestId MUST be top-level (not nested in snapshot) or the broker never
  // resolves the registered promise and every diagnostics pull silently times out.
  expect(event.requestId).toBe("req-1");
  return event.snapshot as FlowControlSnapshot;
}

describe("get-flow-control-snapshot handler", () => {
  it("unions terminal ids across status, suspended, held-duration, and coordinator maps", () => {
    const ctx = makeCtx({
      backpressureManager: {
        terminalStatusesMap: new Map([["a", "running"]]),
        suspendedSet: new Set(["b"]),
        isSuspended: vi.fn((id: string) => id === "b"),
        getActivityTier: vi.fn(() => "active"),
        stats: { pauseCount: 0, resumeCount: 0, suspendCount: 0, forceResumeCount: 0 },
      } as unknown as HostContext["backpressureManager"],
      // "c" is known only to the cross-source held-duration map (live IPC/port
      // pause path) — it must still surface in the union.
      getPausedDurationsSnapshot: vi.fn(() => [{ terminalId: "c", heldDurationMs: 42 }]),
      pauseCoordinators: new Map([["d", {} as never]]),
    });

    const snapshot = runSnapshot(ctx);
    const ids = snapshot.terminals.map((t) => t.terminalId);

    expect(ids).toEqual(["a", "b", "c", "d"]); // unioned and sorted
    expect(snapshot.terminals.find((t) => t.terminalId === "b")?.isSuspended).toBe(true);
    expect(snapshot.terminals.find((t) => t.terminalId === "a")?.flowStatus).toBe("running");
    expect(snapshot.terminals.find((t) => t.terminalId === "c")?.pausedDurationMs).toBe(42);
  });

  it("reads pausedDurationMs from the cross-source held-duration snapshot, null otherwise", () => {
    const ctx = makeCtx({
      backpressureManager: {
        // "paused" holds an ipc-queue token but has NO entry in the SAB-only
        // pauseStartTimes map; "running" is just streaming. Only the
        // cross-source snapshot can supply the duration.
        terminalStatusesMap: new Map([
          ["paused", "paused-backpressure"],
          ["running", "running"],
        ]),
        suspendedSet: new Set(),
        isSuspended: vi.fn(() => false),
        getActivityTier: vi.fn(() => "active"),
        stats: { pauseCount: 0, resumeCount: 0, suspendCount: 0, forceResumeCount: 0 },
      } as unknown as HostContext["backpressureManager"],
      getPausedDurationsSnapshot: vi.fn(() => [{ terminalId: "paused", heldDurationMs: 500 }]),
    });

    const snapshot = runSnapshot(ctx);
    expect(snapshot.terminals.find((t) => t.terminalId === "paused")?.pausedDurationMs).toBe(500);
    expect(snapshot.terminals.find((t) => t.terminalId === "running")?.pausedDurationMs).toBeNull();
  });

  it("isolates a throwing port queue manager so the snapshot still ships partial data", () => {
    const goodConn = makePortConnection({
      totalPendingBytes: 30,
      perTerminal: [{ terminalId: "t1", pendingBytes: 30 }],
    });
    const badConn: RendererConnection = {
      port: {} as RendererConnection["port"],
      handler: vi.fn(),
      portQueueManager: {
        getQueueSnapshot: vi.fn(() => {
          throw new Error("disposed connection");
        }),
      } as unknown as RendererConnection["portQueueManager"],
      batcher: {} as RendererConnection["batcher"],
    };
    const ctx = makeCtx({
      ipcQueueManager: {
        getQueueSnapshot: vi.fn(() => ({
          totalPendingBytes: 20,
          perTerminal: [{ terminalId: "t0", pendingBytes: 20 }],
        })),
      } as unknown as HostContext["ipcQueueManager"],
      rendererConnections: new Map([
        [1, badConn],
        [2, goodConn],
      ]),
    });

    const snapshot = runSnapshot(ctx);

    // The bad connection contributes nothing; IPC + the good connection stand.
    expect(snapshot.totalPendingBytes).toBe(50);
    expect(snapshot.queueDepth).toEqual([
      { terminalId: "t0", layer: "ipc", pendingBytes: 20 },
      { terminalId: "t1", layer: "port", pendingBytes: 30 },
    ]);
  });

  it("includes sorted held tokens from the pause coordinator", () => {
    const ctx = makeCtx({
      pauseCoordinators: new Map([["t1", {} as never]]),
      getPauseCoordinator: vi.fn(() => ({
        heldTokens: new Set(["resource-governor", "backpressure"]),
      })) as unknown as HostContext["getPauseCoordinator"],
    });

    const snapshot = runSnapshot(ctx);
    expect(snapshot.terminals[0].heldTokens).toEqual(["backpressure", "resource-governor"]);
  });

  it("aggregates IPC and per-window port queue depths and totals only positive entries", () => {
    const ctx = makeCtx({
      ipcQueueManager: {
        getQueueSnapshot: vi.fn(() => ({
          totalPendingBytes: 100,
          perTerminal: [
            { terminalId: "t1", pendingBytes: 100 },
            { terminalId: "t2", pendingBytes: 0 },
          ],
        })),
      } as unknown as HostContext["ipcQueueManager"],
      rendererConnections: new Map([
        [
          1,
          makePortConnection({
            totalPendingBytes: 50,
            perTerminal: [{ terminalId: "t1", pendingBytes: 50 }],
          }),
        ],
      ]),
    });

    const snapshot = runSnapshot(ctx);

    expect(snapshot.totalPendingBytes).toBe(150);
    expect(snapshot.queueDepth).toEqual([
      { terminalId: "t1", layer: "ipc", pendingBytes: 100 },
      { terminalId: "t1", layer: "port", pendingBytes: 50 },
    ]);
  });

  it("copies the stats object so later mutations don't bleed into the snapshot", () => {
    const stats = { pauseCount: 3, resumeCount: 2, suspendCount: 1, forceResumeCount: 0 };
    const ctx = makeCtx({
      backpressureManager: {
        terminalStatusesMap: new Map(),
        suspendedSet: new Set(),
        pauseStartTimesMap: new Map(),
        getPauseStartTime: vi.fn(() => undefined),
        isSuspended: vi.fn(() => false),
        getActivityTier: vi.fn(() => "active"),
        stats,
      } as unknown as HostContext["backpressureManager"],
    });

    const snapshot = runSnapshot(ctx);
    expect(snapshot.stats).toEqual({
      pauseCount: 3,
      resumeCount: 2,
      suspendCount: 1,
      forceResumeCount: 0,
    });

    stats.suspendCount = 99;
    expect(snapshot.stats.suspendCount).toBe(1); // detached copy
  });

  it("embeds the resource-governor snapshot verbatim", () => {
    const ctx = makeCtx({
      resourceGovernor: {
        getSnapshot: vi.fn(() => ({
          isThrottling: true,
          isWarning: true,
          activeProfile: "efficiency",
          smoothedUtilizationPercent: 88.2,
          throttleDurationMs: 4200,
        })),
      } as unknown as HostContext["resourceGovernor"],
    });

    const snapshot = runSnapshot(ctx);
    expect(snapshot.resourceGovernor).toEqual({
      isThrottling: true,
      isWarning: true,
      activeProfile: "efficiency",
      smoothedUtilizationPercent: 88.2,
      throttleDurationMs: 4200,
    });
  });
});
