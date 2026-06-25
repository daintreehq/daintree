import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { routeHostEvent, type PtyEventRouterDeps } from "../PtyEventRouter.js";
import { events } from "../../events.js";
import type {
  PtyHostEvent,
  PtyHostSpawnOptions,
  SpawnResult,
} from "../../../../shared/types/pty-host.js";

interface BrokerCall {
  requestId: string;
  result: unknown;
}

function makeDeps(
  overrides: Partial<PtyEventRouterDeps> = {},
  callbackOverrides: { onTerminalPid?: (id: string, pid: number) => void } = {}
): {
  deps: PtyEventRouterDeps;
  emitter: EventEmitter;
  brokerCalls: BrokerCall[];
  state: PtyEventRouterDeps["state"];
  callbacks: {
    onReadyCount: number;
    onPongCount: number;
    trashIdsRemoved: string[];
    terminalPidCalls: Array<{ id: string; pid: number }>;
  };
} {
  const emitter = new EventEmitter();
  const brokerCalls: BrokerCall[] = [];
  const state: PtyEventRouterDeps["state"] = {
    pendingSpawns: new Map(),
    pendingKillCount: new Map(),
    terminalPids: new Map(),
  };
  const callbacks = {
    onReadyCount: 0,
    onPongCount: 0,
    trashIdsRemoved: [] as string[],
    terminalPidCalls: [] as Array<{ id: string; pid: number }>,
  };
  const deps: PtyEventRouterDeps = {
    isDisposed: () => false,
    broker: {
      resolve: <T>(requestId: string, result: T) => {
        brokerCalls.push({ requestId, result });
        return true;
      },
    },
    emitter,
    state,
    callbacks: {
      onReady: () => {
        callbacks.onReadyCount++;
      },
      onPong: () => {
        callbacks.onPongCount++;
      },
      onTerminalRemovedFromTrash: (id) => {
        callbacks.trashIdsRemoved.push(id);
      },
      onTerminalPid:
        callbackOverrides.onTerminalPid ??
        ((id, pid) => {
          callbacks.terminalPidCalls.push({ id, pid });
        }),
    },
    logWarn: vi.fn(),
    ...overrides,
  };
  return { deps, emitter, brokerCalls, state, callbacks };
}

describe("routeHostEvent", () => {
  afterEach(() => {
    events.removeAllListeners();
  });

  it("returns true and skips routing when disposed", () => {
    const { deps, emitter } = makeDeps({ isDisposed: () => true });
    const dataListener = vi.fn();
    emitter.on("data", dataListener);

    const handled = routeHostEvent({ type: "data", id: "t1", data: "hello" }, deps);

    expect(handled).toBe(true);
    expect(dataListener).not.toHaveBeenCalled();
  });

  it("forwards heapMb and externalMb on host-memory-warning", () => {
    const { deps, emitter } = makeDeps();
    const warningListener = vi.fn();
    emitter.on("host-memory-warning", warningListener);

    const handled = routeHostEvent(
      {
        type: "host-memory-warning",
        isWarning: true,
        utilizationPercent: 75,
        heapMb: 300,
        externalMb: 276,
        timestamp: 1000,
      } as PtyHostEvent,
      deps
    );

    expect(handled).toBe(true);
    expect(warningListener).toHaveBeenCalledWith({
      isWarning: true,
      utilizationPercent: 75,
      heapMb: 300,
      externalMb: 276,
      timestamp: 1000,
    });
  });

  it("delegates domain events to bridgePtyEvent first", () => {
    const { deps } = makeDeps();
    const agentStateEvents: unknown[] = [];
    events.on("agent:state-changed", (payload) => {
      agentStateEvents.push(payload);
    });

    const handled = routeHostEvent(
      {
        type: "agent-state",
        id: "t1",
        state: "working",
        previousState: "idle",
        timestamp: 1000,
        trigger: "activity",
        confidence: 1,
      } as PtyHostEvent,
      deps
    );

    expect(handled).toBe(true);
    expect(agentStateEvents).toHaveLength(1);
  });

  it("emits transport-level data/exit/error events on the emitter", () => {
    const { deps, emitter } = makeDeps();
    const dataListener = vi.fn();
    const exitListener = vi.fn();
    const errorListener = vi.fn();
    emitter.on("data", dataListener);
    emitter.on("exit", exitListener);
    emitter.on("error", errorListener);

    routeHostEvent({ type: "data", id: "t1", data: "x" }, deps);
    routeHostEvent({ type: "exit", id: "t1", exitCode: 0 }, deps);
    routeHostEvent({ type: "error", id: "t1", error: "boom" }, deps);

    expect(dataListener).toHaveBeenCalledWith("t1", "x");
    expect(exitListener).toHaveBeenCalledWith("t1", 0, undefined);
    expect(errorListener).toHaveBeenCalledWith("t1", "boom");
  });

  it("calls onReady when the host emits ready", () => {
    const { deps, callbacks } = makeDeps();
    routeHostEvent({ type: "ready" }, deps);
    expect(callbacks.onReadyCount).toBe(1);
  });

  it("calls onPong when the host emits pong", () => {
    const { deps, callbacks } = makeDeps();
    routeHostEvent({ type: "pong" }, deps);
    expect(callbacks.onPongCount).toBe(1);
  });

  it("decrements pendingKillCount on exit when a kill was queued", () => {
    const { deps, state } = makeDeps();
    state.pendingSpawns.set("t1", { cwd: "/", cols: 80, rows: 24 } as PtyHostSpawnOptions);
    state.pendingKillCount.set("t1", 2);
    state.terminalPids.set("t1", 999);

    routeHostEvent({ type: "exit", id: "t1", exitCode: 0 }, deps);

    expect(state.pendingKillCount.get("t1")).toBe(1);
    // pendingSpawns NOT cleared — kill was queued
    expect(state.pendingSpawns.has("t1")).toBe(true);
    expect(state.terminalPids.has("t1")).toBe(false);
  });

  it("clears pendingSpawns on exit when no kill was queued", () => {
    const { deps, state } = makeDeps();
    state.pendingSpawns.set("t1", { cwd: "/", cols: 80, rows: 24 } as PtyHostSpawnOptions);

    routeHostEvent({ type: "exit", id: "t1", exitCode: 0 }, deps);

    expect(state.pendingSpawns.has("t1")).toBe(false);
  });

  it("removes the pendingKillCount entry once it reaches zero", () => {
    const { deps, state } = makeDeps();
    state.pendingKillCount.set("t1", 1);

    routeHostEvent({ type: "exit", id: "t1", exitCode: 0 }, deps);

    expect(state.pendingKillCount.has("t1")).toBe(false);
  });

  it("notifies the trash tracker on exit via callback", () => {
    const { deps, callbacks } = makeDeps();
    routeHostEvent({ type: "exit", id: "t1", exitCode: 0 }, deps);
    expect(callbacks.trashIdsRemoved).toEqual(["t1"]);
  });

  it("resolves broker for snapshot events", () => {
    const { deps, brokerCalls } = makeDeps();
    routeHostEvent({ type: "snapshot", id: "t1", requestId: "req-1", snapshot: null }, deps);
    expect(brokerCalls).toEqual([{ requestId: "req-1", result: null }]);
  });

  it("resolves broker with the snapshot for flow-control-snapshot events", () => {
    const { deps, brokerCalls } = makeDeps();
    const snapshot = {
      timestamp: 1,
      terminals: [],
      queueDepth: [],
      totalPendingBytes: 0,
      stats: { pauseCount: 0, resumeCount: 0, suspendCount: 0, forceResumeCount: 0 },
      resourceGovernor: {
        isThrottling: false,
        isWarning: false,
        activeProfile: "balanced" as const,
        smoothedUtilizationPercent: null,
        throttleDurationMs: 0,
      },
    };
    routeHostEvent({ type: "flow-control-snapshot", requestId: "req-fc", snapshot }, deps);
    expect(brokerCalls).toEqual([{ requestId: "req-fc", result: snapshot }]);
  });

  it("resolves broker with terminalIds default for terminals-for-project", () => {
    const { deps, brokerCalls } = makeDeps();
    routeHostEvent(
      { type: "terminals-for-project", requestId: "req-2", terminalIds: ["a", "b"] },
      deps
    );
    expect(brokerCalls).toEqual([{ requestId: "req-2", result: ["a", "b"] }]);
  });

  it("resolves broker with default snapshots empty array when missing", () => {
    const { deps, brokerCalls } = makeDeps();
    routeHostEvent({ type: "all-snapshots", requestId: "req-3", snapshots: [] }, deps);
    expect(brokerCalls).toEqual([{ requestId: "req-3", result: [] }]);
  });

  it("resolves broker for wake-result with state and warnings", () => {
    const { deps, brokerCalls } = makeDeps();
    routeHostEvent(
      {
        type: "wake-result",
        id: "t1",
        requestId: "req-w",
        state: "working",
        warnings: ["slow"],
      },
      deps
    );
    expect(brokerCalls).toEqual([
      { requestId: "req-w", result: { state: "working", warnings: ["slow"] } },
    ]);
  });

  it("preserves the legacy terminalTypes fallback shape on missing project-stats", () => {
    const { deps, brokerCalls } = makeDeps();
    routeHostEvent(
      // Force a missing-stats path by spreading a partial shape — the runtime can
      // observe `event.stats === undefined` even though the type forbids it.
      {
        type: "project-stats",
        requestId: "req-ps",
        stats: undefined as unknown as {
          terminalCount: number;
          processIds: number[];
          detectedAgents: Record<string, number>;
        },
      },
      deps
    );
    expect(brokerCalls[0]?.result).toEqual({
      terminalCount: 0,
      processIds: [],
      terminalTypes: {},
    });
  });

  it("records terminal-pid on the shared state map", () => {
    const { deps, state } = makeDeps();
    routeHostEvent({ type: "terminal-pid", id: "t1", pid: 12345 }, deps);
    expect(state.terminalPids.get("t1")).toBe(12345);
  });

  it("ignores a non-positive terminal-pid without storing or notifying (#10787)", () => {
    const logWarn = vi.fn();
    const { deps, state, callbacks } = makeDeps({ logWarn });

    for (const pid of [0, -1]) {
      const handled = routeHostEvent({ type: "terminal-pid", id: "t1", pid }, deps);
      expect(handled).toBe(true);
    }

    expect(state.terminalPids.has("t1")).toBe(false);
    expect(callbacks.terminalPidCalls).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("invalid terminal-pid"));
  });

  it("stores a valid terminal-pid arriving after a prior invalid one (#10787)", () => {
    const { deps, state, callbacks } = makeDeps();

    routeHostEvent({ type: "terminal-pid", id: "t1", pid: 0 }, deps);
    routeHostEvent({ type: "terminal-pid", id: "t1", pid: 777 }, deps);

    expect(state.terminalPids.get("t1")).toBe(777);
    expect(callbacks.terminalPidCalls).toEqual([{ id: "t1", pid: 777 }]);
  });

  it("invokes onTerminalPid with id and pid after updating the state map (#7526)", () => {
    const { deps, state, callbacks } = makeDeps();
    routeHostEvent({ type: "terminal-pid", id: "t1", pid: 4242 }, deps);
    expect(state.terminalPids.get("t1")).toBe(4242);
    expect(callbacks.terminalPidCalls).toEqual([{ id: "t1", pid: 4242 }]);
  });

  it("swallows a throwing onTerminalPid and logs without breaking routing (#7526)", () => {
    const logWarn = vi.fn();
    const { deps, state } = makeDeps(
      { logWarn },
      {
        onTerminalPid: () => {
          throw new Error("boom");
        },
      }
    );

    const handled = routeHostEvent({ type: "terminal-pid", id: "t1", pid: 42 }, deps);

    expect(handled).toBe(true);
    expect(state.terminalPids.get("t1")).toBe(42);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("onTerminalPid threw"));
  });

  it("does not throw when onTerminalPid is omitted from callbacks", () => {
    const emitter = new EventEmitter();
    const state: PtyEventRouterDeps["state"] = {
      pendingSpawns: new Map(),
      pendingKillCount: new Map(),
      terminalPids: new Map(),
    };
    const deps: PtyEventRouterDeps = {
      isDisposed: () => false,
      broker: { resolve: () => true },
      emitter,
      state,
      callbacks: {
        onReady: () => {},
        onPong: () => {},
        onTerminalRemovedFromTrash: () => {},
      },
      logWarn: vi.fn(),
    };

    expect(() => routeHostEvent({ type: "terminal-pid", id: "t1", pid: 99 }, deps)).not.toThrow();
    expect(state.terminalPids.get("t1")).toBe(99);
  });

  it("emits spawn-result and clears pendingSpawns on failed spawn", () => {
    const { deps, emitter, state } = makeDeps();
    state.pendingSpawns.set("t1", { cwd: "/", cols: 80, rows: 24 } as PtyHostSpawnOptions);
    const spawnListener = vi.fn();
    emitter.on("spawn-result", spawnListener);

    const failedResult: SpawnResult = {
      success: false,
      id: "t1",
      error: { code: "ENOENT", message: "shell not found" },
    };
    routeHostEvent({ type: "spawn-result", id: "t1", result: failedResult }, deps);

    expect(state.pendingSpawns.has("t1")).toBe(false);
    expect(spawnListener).toHaveBeenCalledWith("t1", failedResult);
  });

  it("emits spawn-result and keeps pendingSpawns intact on successful spawn", () => {
    const { deps, emitter, state } = makeDeps();
    state.pendingSpawns.set("t1", { cwd: "/", cols: 80, rows: 24 } as PtyHostSpawnOptions);
    const spawnListener = vi.fn();
    emitter.on("spawn-result", spawnListener);

    routeHostEvent(
      {
        type: "spawn-result",
        id: "t1",
        result: { success: true, id: "t1" },
      },
      deps
    );

    expect(state.pendingSpawns.has("t1")).toBe(true);
    expect(spawnListener).toHaveBeenCalled();
  });

  it("emits fd-leak-warning and returns true", () => {
    const { deps, emitter } = makeDeps();
    const listener = vi.fn();
    emitter.on("fd-leak-warning", listener);

    const handled = routeHostEvent(
      {
        type: "fd-leak-warning",
        fdCount: 50,
        activeTerminals: 5,
        estimatedLeaked: 30,
        orphanedPids: [],
        ptmxLimit: 511,
        timestamp: 1000,
      },
      deps
    );

    expect(handled).toBe(true);
    expect(listener).toHaveBeenCalledWith({
      fdCount: 50,
      activeTerminals: 5,
      estimatedLeaked: 30,
      orphanedPids: [],
      ptmxLimit: 511,
      timestamp: 1000,
    });
  });

  it("emits resource-metrics with timestamp", () => {
    const { deps, emitter } = makeDeps();
    const listener = vi.fn();
    emitter.on("resource-metrics", listener);

    routeHostEvent(
      {
        type: "resource-metrics",
        metrics: { t1: { cpuPercent: 5, memoryKb: 1000, breakdown: [] } },
        timestamp: 12345,
      },
      deps
    );

    expect(listener).toHaveBeenCalledWith(
      { t1: { cpuPercent: 5, memoryKb: 1000, breakdown: [] } },
      12345
    );
  });

  it("forwards droppedBytes on data-loss terminal-status events", () => {
    const { deps, emitter } = makeDeps();
    const listener = vi.fn();
    emitter.on("terminal-status", listener);

    const handled = routeHostEvent(
      {
        type: "terminal-status",
        id: "t1",
        status: "data-loss",
        bufferUtilization: 100,
        droppedBytes: 2048,
        timestamp: 12345,
      } as PtyHostEvent,
      deps
    );

    expect(handled).toBe(true);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "t1",
        status: "data-loss",
        droppedBytes: 2048,
        bufferUtilization: 100,
        timestamp: 12345,
      })
    );
  });

  it("logs and returns false for unknown event types", () => {
    const logWarn = vi.fn();
    const { deps } = makeDeps({ logWarn });
    const handled = routeHostEvent({ type: "totally-unknown" } as unknown as PtyHostEvent, deps);
    expect(handled).toBe(false);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("totally-unknown"));
  });
});
