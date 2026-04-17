import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "events";
import type { PtyHostSpawnOptions, SpawnResult } from "../../../shared/types/pty-host.js";

const shared = vi.hoisted(() => {
  // vi.hoisted runs before module imports resolve, so use require() to load
  // the Node stdlib synchronously.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const appEmitter = new EventEmitter();
  const appMock = Object.assign(appEmitter, {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  });
  return {
    forkMock: vi.fn(),
    tracker: {
      removeTrashed: vi.fn(),
      persistTrashed: vi.fn(),
      clearAll: vi.fn(),
    },
    appMock,
  };
});

vi.mock("electron", () => ({
  utilityProcess: {
    fork: shared.forkMock,
  },
  UtilityProcess: EventEmitter,
  MessagePortMain: class {},
  app: shared.appMock,
}));

vi.mock("../TrashedPidTracker.js", () => ({
  getTrashedPidTracker: () => shared.tracker,
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

interface MockUtilityProcess extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid?: number;
}

interface MockMessagePortMain {
  close: Mock;
}

interface PtyClientPrivateAccess {
  child: MockUtilityProcess | null;
  pendingMessagePorts: Map<number, MockMessagePortMain>;
  pendingKillCount: Map<string, number>;
}

function createMockChild(): MockUtilityProcess {
  return Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 321,
  });
}

function createMockPort(): MockMessagePortMain {
  return {
    close: vi.fn(),
  };
}

describe("PtyClient adversarial", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    shared.appMock.removeAllListeners();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);

    ({ PtyClient: PtyClientClass } = await import("../PtyClient.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createReadyClient(
    config?: import("../PtyClient.js").PtyClientConfig
  ): import("../PtyClient.js").PtyClient {
    const client = new PtyClientClass(config);
    mockChild.emit("message", { type: "ready" });
    return client;
  }

  it("DOUBLE_RESUME_HANDSHAKE_COALESCES", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 1000 });

    client.pauseHealthCheck();
    mockChild.postMessage.mockClear();
    client.resumeHealthCheck();
    client.resumeHealthCheck();

    mockChild.emit("message", { type: "pong" });
    vi.advanceTimersByTime(3000);

    const healthChecks = mockChild.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "health-check"
    );
    expect(healthChecks).toHaveLength(4);
  });

  it("LATE_PONG_AFTER_HANDSHAKE_TIMEOUT_DOES_NOT_DUPLICATE_INTERVAL", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 1000 });

    client.pauseHealthCheck();
    mockChild.postMessage.mockClear();
    client.resumeHealthCheck();

    vi.advanceTimersByTime(5000);
    mockChild.emit("message", { type: "pong" });
    vi.advanceTimersByTime(3000);

    const healthChecks = mockChild.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "health-check"
    );
    expect(healthChecks).toHaveLength(4);
  });

  it("REPLACING_PENDING_PORT_ONLY_FORWARDS_NEW_PORT", () => {
    const client = createReadyClient();
    const privateAccess = client as unknown as PtyClientPrivateAccess;
    const oldPort = createMockPort();
    const newPort = createMockPort();
    const restartedChild = createMockChild();

    privateAccess.child = null;
    client.connectMessagePort(7, oldPort as unknown as import("electron").MessagePortMain);
    client.connectMessagePort(7, newPort as unknown as import("electron").MessagePortMain);
    shared.forkMock.mockReturnValue(restartedChild);

    client.manualRestart();
    restartedChild.emit("message", { type: "ready" });

    expect(oldPort.close).toHaveBeenCalledTimes(1);
    expect(restartedChild.postMessage).toHaveBeenCalledWith({ type: "connect-port", windowId: 7 }, [
      newPort,
    ]);
    expect(restartedChild.postMessage).not.toHaveBeenCalledWith(
      { type: "connect-port", windowId: 7 },
      [oldPort]
    );
  });

  it("CONTEXT_REPLAY_ORDER_AFTER_PORT_TRANSITION", () => {
    const client = createReadyClient();
    const privateAccess = client as unknown as PtyClientPrivateAccess;
    const port = createMockPort();
    const restartedChild = createMockChild();

    privateAccess.child = null;
    client.connectMessagePort(4, port as unknown as import("electron").MessagePortMain);
    client.setActiveProject(4, "project-a", "/projects/a");
    shared.forkMock.mockReturnValue(restartedChild);

    client.manualRestart();
    restartedChild.emit("message", { type: "ready" });

    const messageTypes = restartedChild.postMessage.mock.calls.map(
      (call: unknown[]) => (call[0] as { type?: string })?.type
    );
    expect(messageTypes.indexOf("connect-port")).toBeGreaterThanOrEqual(0);
    expect(messageTypes.indexOf("set-active-project")).toBeGreaterThan(
      messageTypes.indexOf("connect-port")
    );
  });

  it("TERMINAL_STATUS_ORDER_SURVIVES_RESTART", () => {
    const client = createReadyClient();
    const restartedChild = createMockChild();
    const statuses: string[] = [];
    client.on("terminal-status", (payload: { status: string }) => {
      statuses.push(payload.status);
    });
    shared.forkMock.mockReturnValue(restartedChild);

    mockChild.emit("message", {
      type: "terminal-status",
      id: "t1",
      status: "paused-backpressure",
      timestamp: 1,
    });
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(2000);
    restartedChild.emit("message", { type: "ready" });
    restartedChild.emit("message", {
      type: "terminal-status",
      id: "t1",
      status: "running",
      timestamp: 2,
    });

    expect(statuses).toEqual(["paused-backpressure", "running"]);
  });

  it("SNAPSHOT_RESPONSE_RESOLVES_PROMISE_VIA_BROKER", async () => {
    const client = createReadyClient();
    const snapshotPayload = { id: "t1", title: "hello", cwd: "/tmp", spawnedAt: 1 };

    const snapshotPromise = client.getTerminalSnapshot("t1");

    const sentRequest = mockChild.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as { type?: string; requestId?: string })
      .find((msg) => msg?.type === "get-snapshot");
    expect(sentRequest?.requestId).toBeTruthy();

    mockChild.emit("message", {
      type: "snapshot",
      id: "t1",
      requestId: sentRequest!.requestId,
      snapshot: snapshotPayload,
    });

    await expect(snapshotPromise).resolves.toEqual(snapshotPayload);
  });

  it("ALL_SNAPSHOTS_RESPONSE_RESOLVES_PROMISE_VIA_BROKER", async () => {
    const client = createReadyClient();
    const payload = [{ id: "t1", title: "a", cwd: "/", spawnedAt: 1 }];

    const promise = client.getAllTerminalSnapshots();

    const sentRequest = mockChild.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as { type?: string; requestId?: string })
      .find((msg) => msg?.type === "get-all-snapshots");
    expect(sentRequest?.requestId).toBeTruthy();

    mockChild.emit("message", {
      type: "all-snapshots",
      requestId: sentRequest!.requestId,
      snapshots: payload,
    });

    await expect(promise).resolves.toEqual(payload);
  });

  it("TRANSITION_RESULT_RESPONSE_RESOLVES_PROMISE_VIA_BROKER", async () => {
    const client = createReadyClient();

    const promise = client.transitionState("t1", { type: "idle" }, "output", 1);

    const sentRequest = mockChild.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as { type?: string; requestId?: string })
      .find((msg) => msg?.type === "transition-state");
    expect(sentRequest?.requestId).toBeTruthy();

    mockChild.emit("message", {
      type: "transition-result",
      id: "t1",
      requestId: sentRequest!.requestId,
      success: true,
    });

    await expect(promise).resolves.toBe(true);
  });

  it("GRACEFUL_KILL_TIMEOUT_TRIGGERS_FORCED_KILL", async () => {
    const client = createReadyClient();

    const promise = client.gracefulKill("t1");

    await vi.advanceTimersByTimeAsync(5001);

    await expect(promise).resolves.toBeNull();
    const killCall = mockChild.postMessage.mock.calls.find(
      (call: unknown[]) =>
        (call[0] as { type?: string; id?: string; reason?: string })?.type === "kill"
    );
    expect(killCall?.[0]).toMatchObject({
      type: "kill",
      id: "t1",
      reason: "graceful-kill-timeout",
    });
  });

  it("GRACEFUL_KILL_SKIPS_KILL_WHEN_BROKER_CLEARED_BY_HOST_EXIT", async () => {
    const client = createReadyClient();
    const privateAccess = client as unknown as PtyClientPrivateAccess;
    shared.forkMock.mockReturnValue(createMockChild());

    const promise = client.gracefulKill("t1");

    const postedRequest = mockChild.postMessage.mock.calls.find(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "graceful-kill"
    );
    expect(postedRequest).toBeDefined();

    shared.tracker.removeTrashed.mockClear();
    mockChild.postMessage.mockClear();
    mockChild.emit("exit", 1);

    await expect(promise).resolves.toBeNull();

    // this.kill() would call getTrashedPidTracker().removeTrashed(id), post a
    // kill-typed IPC message, and bump pendingKillCount. None of that should
    // happen when the broker clear carries a BrokerError reason.
    expect(shared.tracker.removeTrashed).not.toHaveBeenCalled();
    expect(privateAccess.pendingKillCount.get("t1") ?? 0).toBe(0);
    const killCall = mockChild.postMessage.mock.calls.find(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "kill"
    );
    expect(killCall).toBeUndefined();
  });

  it("GRACEFUL_KILL_SKIPS_KILL_WHEN_TIMEOUT_FIRES_AFTER_HOST_GONE", async () => {
    // When the host exits and restarts are exhausted, a subsequent gracefulKill
    // will time out with a plain Error('Request timeout: …') — not a
    // BrokerError. Without the null-child guard, the catch would fall through
    // to this.kill() and mutate local state on a dead client.
    const client = createReadyClient({ maxRestartAttempts: 0 });
    const privateAccess = client as unknown as PtyClientPrivateAccess;

    mockChild.emit("exit", 1);
    expect(privateAccess.child).toBeNull();

    shared.tracker.removeTrashed.mockClear();
    const latePromise = client.gracefulKill("t1");

    vi.advanceTimersByTime(6000);
    await expect(latePromise).resolves.toBeNull();

    expect(shared.tracker.removeTrashed).not.toHaveBeenCalled();
    expect(privateAccess.pendingKillCount.get("t1") ?? 0).toBe(0);
  });

  it("GRACEFUL_KILL_CALLS_KILL_ON_TIMEOUT_WHEN_HOST_STILL_ALIVE", async () => {
    const client = createReadyClient();

    const promise = client.gracefulKill("t1");
    shared.tracker.removeTrashed.mockClear();
    mockChild.postMessage.mockClear();

    vi.advanceTimersByTime(6000);

    await expect(promise).resolves.toBeNull();

    // On timeout (non-BrokerError rejection) with a live host, gracefulKill
    // must still send a kill message and remove the trashed PID.
    expect(shared.tracker.removeTrashed).toHaveBeenCalledWith("t1");
    const killCall = mockChild.postMessage.mock.calls.find(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "kill"
    );
    expect(killCall).toBeDefined();
    expect(killCall?.[0]).toMatchObject({
      type: "kill",
      id: "t1",
      reason: "graceful-kill-timeout",
    });
  });

  it("HOST_RESTART_CLEARS_MIGRATED_REQUESTS_TO_SENTINELS", async () => {
    const client = createReadyClient();

    const snapshotPromise = client.getTerminalSnapshot("t1");
    const allSnapshotsPromise = client.getAllTerminalSnapshots();
    const transitionPromise = client.transitionState("t1", { type: "idle" }, "output", 1);
    const serializedPromise = client.getSerializedStateAsync("t1");

    mockChild.emit("exit", 1);

    await expect(snapshotPromise).resolves.toBeNull();
    await expect(allSnapshotsPromise).resolves.toEqual([]);
    await expect(transitionPromise).resolves.toBe(false);
    await expect(serializedPromise).resolves.toBeNull();
  });

  describe("child-process-gone crash routing", () => {
    function emitGone(
      details: Partial<{
        type: string;
        reason: string;
        exitCode: number;
        name: string;
        serviceName: string;
      }> = {}
    ): void {
      shared.appMock.emit(
        "child-process-gone",
        {},
        {
          type: "Utility",
          reason: "crashed",
          exitCode: 1,
          name: "daintree-pty-host",
          serviceName: "daintree-pty-host",
          ...details,
        }
      );
    }

    function captureCrash(client: import("../PtyClient.js").PtyClient): {
      payloads: Array<{ code: number | null; signal: string | null; crashType: string }>;
    } {
      const payloads: Array<{ code: number | null; signal: string | null; crashType: string }> = [];
      client.on(
        "host-crash-details",
        (payload: { code: number | null; signal: string | null; crashType: string }) => {
          payloads.push(payload);
        }
      );
      return { payloads };
    }

    it("GONE_BEFORE_EXIT_ROUTES_AUTHORITATIVE_REASON", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      emitGone({ reason: "oom", exitCode: 0 });
      mockChild.emit("exit", 0);
      vi.advanceTimersByTime(1);

      expect(payloads).toHaveLength(1);
      expect(payloads[0].crashType).toBe("OUT_OF_MEMORY");
    });

    it("EXIT_BEFORE_GONE_ORDERING_RACE", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      // Reverse order: exit first (incorrect code 0), gone arrives after.
      mockChild.emit("exit", 0);
      emitGone({ reason: "oom", exitCode: 0 });
      vi.advanceTimersByTime(1);

      expect(payloads).toHaveLength(1);
      expect(payloads[0].crashType).toBe("OUT_OF_MEMORY");
    });

    it("NO_GONE_EVENT_FALLS_BACK_TO_EXIT_CODE_HEURISTIC", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      mockChild.emit("exit", 137);
      vi.advanceTimersByTime(1);

      expect(payloads).toHaveLength(1);
      expect(payloads[0].crashType).toBe("OUT_OF_MEMORY");
      expect(payloads[0].code).toBe(137);
    });

    it("GONE_WRONG_TYPE_IGNORED", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      emitGone({ type: "GPU", reason: "oom" });
      mockChild.emit("exit", 0);
      vi.advanceTimersByTime(1);

      // exit code 0 + no authoritative reason → CLEAN_EXIT → nothing emitted
      expect(payloads).toHaveLength(0);
    });

    it("GONE_WRONG_NAME_IGNORED", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      // Clear both name and serviceName so the filter can't fall through.
      emitGone({ name: "some-other-host", serviceName: "some-other-host", reason: "oom" });
      mockChild.emit("exit", 0);
      vi.advanceTimersByTime(1);

      expect(payloads).toHaveLength(0);
    });

    it("SERVICE_NAME_MATCHES_WHEN_NAME_IS_UNDEFINED", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      // Electron 41 populates both `name` and `serviceName`, but the `Details`
      // type flags both as optional. Make sure we still match if only
      // `serviceName` is present.
      shared.appMock.emit(
        "child-process-gone",
        {},
        {
          type: "Utility",
          reason: "oom",
          exitCode: 0,
          serviceName: "daintree-pty-host",
        }
      );
      mockChild.emit("exit", 0);
      vi.advanceTimersByTime(1);

      expect(payloads).toHaveLength(1);
      expect(payloads[0].crashType).toBe("OUT_OF_MEMORY");
    });

    it("MANUAL_RESTART_DURING_EXIT_DEFER_DOES_NOT_DOUBLE_START", () => {
      const client = createReadyClient();
      const restartedChild = createMockChild();
      restartedChild.pid = 777;

      // Exit fires — synchronous part nulls this.child, setImmediate is queued.
      mockChild.emit("exit", 1);

      // Before setImmediate runs, the renderer triggers manualRestart(). It
      // sees this.child === null and forks a new host immediately.
      shared.forkMock.mockReturnValue(restartedChild);
      client.manualRestart();
      expect(shared.forkMock).toHaveBeenCalledTimes(2);

      // Now let the deferred setImmediate run. It must NOT schedule another
      // restart, because a new host is already alive.
      vi.advanceTimersByTime(1);

      // And if a restart timer had been armed, draining timers would have
      // triggered a third fork. Advance well past the max restart delay.
      vi.advanceTimersByTime(30000);

      expect(shared.forkMock).toHaveBeenCalledTimes(2);
    });

    it("AUTHORITATIVE_REASON_CARRIES_AUTHORITATIVE_EXIT_CODE", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      // Gone reports the authoritative exitCode; exit reports a mangled 0.
      emitGone({ reason: "oom", exitCode: -1 });
      mockChild.emit("exit", 0);
      vi.advanceTimersByTime(1);

      expect(payloads).toHaveLength(1);
      expect(payloads[0].code).toBe(-1);
      expect(payloads[0].signal).toBeNull();
      expect(payloads[0].crashType).toBe("OUT_OF_MEMORY");
    });

    it("CRASH_PAYLOAD_FIELDS_ARE_COMPLETE_ON_FALLBACK", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      // No gone event — use exit-code heuristic. Payload should include all fields.
      mockChild.emit("exit", 137);
      vi.advanceTimersByTime(1);

      expect(payloads).toHaveLength(1);
      expect(payloads[0].code).toBe(137);
      expect(payloads[0].signal).toBe("SIG9");
      expect(payloads[0].crashType).toBe("OUT_OF_MEMORY");
    });

    it("STARTHOST_CLEARS_STALE_GONE_BEFORE_NEW_HOST", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);
      const restartedChild = createMockChild();
      restartedChild.pid = 999;
      shared.forkMock.mockReturnValue(restartedChild);

      // First crash cycle — gone arrives, then exit consumes it.
      emitGone({ reason: "oom" });
      mockChild.emit("exit", 0);
      vi.advanceTimersByTime(1);
      expect(payloads[payloads.length - 1].crashType).toBe("OUT_OF_MEMORY");

      // Advance past the restart delay so startHost() runs (defensive reset).
      vi.advanceTimersByTime(10000);
      restartedChild.emit("message", { type: "ready" });

      // New host exits cleanly with no gone event. If the prior gone reason
      // had leaked, this would be misclassified as OUT_OF_MEMORY.
      restartedChild.emit("exit", 0);
      vi.advanceTimersByTime(1);

      // Only one crash payload total — the new host's clean exit emits nothing.
      expect(payloads).toHaveLength(1);
    });

    it("DISPOSE_DEREGISTERS_APP_LISTENER", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      expect(shared.appMock.listenerCount("child-process-gone")).toBe(1);
      client.dispose();
      expect(shared.appMock.listenerCount("child-process-gone")).toBe(0);

      // Post-dispose gone event must not emit anything.
      emitGone({ reason: "oom" });
      vi.advanceTimersByTime(1);
      expect(payloads).toHaveLength(0);
    });

    it("MEMORY_EVICTION_MAPS_TO_OOM", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      emitGone({ reason: "memory-eviction" });
      mockChild.emit("exit", 0);
      vi.advanceTimersByTime(1);

      expect(payloads).toHaveLength(1);
      expect(payloads[0].crashType).toBe("OUT_OF_MEMORY");
    });

    it("UNKNOWN_REASON_MAPS_TO_UNKNOWN_CRASH", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      emitGone({ reason: "something-new-from-electron-42" });
      mockChild.emit("exit", 0);
      vi.advanceTimersByTime(1);

      expect(payloads).toHaveLength(1);
      expect(payloads[0].crashType).toBe("UNKNOWN_CRASH");
    });

    it("KILLED_REASON_MAPS_TO_SIGNAL_TERMINATED", () => {
      const client = createReadyClient();
      const { payloads } = captureCrash(client);

      emitGone({ reason: "killed" });
      mockChild.emit("exit", 143);
      vi.advanceTimersByTime(1);

      expect(payloads).toHaveLength(1);
      expect(payloads[0].crashType).toBe("SIGNAL_TERMINATED");
    });
  });

  it("DISPOSE_RESOLVES_ORPHANED_PENDING_OPS", async () => {
    const client = createReadyClient();
    const privateAccess = client as unknown as PtyClientPrivateAccess;
    const pendingPort = createMockPort();

    privateAccess.child = null;
    client.connectMessagePort(9, pendingPort as unknown as import("electron").MessagePortMain);
    privateAccess.child = mockChild;

    const terminalPromise = client.getTerminalAsync("t1");
    const snapshotPromise = client.getTerminalSnapshot("t1");
    const allSnapshotsPromise = client.getAllTerminalSnapshots();
    const transitionPromise = client.transitionState("t1", { type: "busy" }, "output", 1);

    client.dispose();

    await expect(terminalPromise).resolves.toBeNull();
    await expect(snapshotPromise).resolves.toBeNull();
    await expect(allSnapshotsPromise).resolves.toEqual([]);
    await expect(transitionPromise).resolves.toBe(false);
    expect(pendingPort.close).toHaveBeenCalledTimes(1);
    expect(mockChild.postMessage).toHaveBeenCalledWith({ type: "dispose" });

    vi.advanceTimersByTime(1000);
    expect(mockChild.kill).toHaveBeenCalledTimes(1);
  });

  const MAX_PENDING_SPAWNS = 250;

  function baseSpawnOptions(overrides: Partial<PtyHostSpawnOptions> = {}): PtyHostSpawnOptions {
    return {
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      ...overrides,
    };
  }

  function countSpawnMessages(child: MockUtilityProcess): number {
    return child.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "spawn"
    ).length;
  }

  it("PENDING_SPAWNS_REJECTED_AT_CAP", async () => {
    const client = createReadyClient();
    const { logWarn } = await import("../../utils/logger.js");
    const results: Array<{ id: string; result: SpawnResult }> = [];
    client.on("spawn-result", (id: string, result: SpawnResult) => {
      results.push({ id, result });
    });
    mockChild.postMessage.mockClear();

    for (let i = 0; i < MAX_PENDING_SPAWNS; i++) {
      client.spawn(`t-${i}`, baseSpawnOptions());
    }
    expect(countSpawnMessages(mockChild)).toBe(MAX_PENDING_SPAWNS);
    expect(results).toHaveLength(0);

    client.spawn("t-overflow", baseSpawnOptions());

    expect(client.hasTerminal("t-overflow")).toBe(false);
    expect(countSpawnMessages(mockChild)).toBe(MAX_PENDING_SPAWNS);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("spawn rejected"));

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("t-overflow");
    expect(results[0].result.success).toBe(false);
    expect(results[0].result.id).toBe("t-overflow");
    expect(results[0].result.error?.code).toBe("PENDING_SPAWNS_CAPPED");
    expect(results[0].result.error?.message).toEqual(expect.stringContaining("250"));
  });

  it("KILL_FREES_SLOT_BELOW_CAP", () => {
    const client = createReadyClient();
    mockChild.postMessage.mockClear();

    for (let i = 0; i < MAX_PENDING_SPAWNS; i++) {
      client.spawn(`t-${i}`, baseSpawnOptions());
    }
    expect(countSpawnMessages(mockChild)).toBe(MAX_PENDING_SPAWNS);

    client.kill("t-0");
    client.spawn("t-new", baseSpawnOptions());

    expect(client.hasTerminal("t-new")).toBe(true);
    expect(client.hasTerminal("t-0")).toBe(false);
    const spawnIds = mockChild.postMessage.mock.calls
      .filter((call: unknown[]) => (call[0] as { type?: string })?.type === "spawn")
      .map((call: unknown[]) => (call[0] as { id?: string })?.id);
    expect(spawnIds).toContain("t-new");
  });

  it("SAME_ID_AT_CAP_IS_UPDATED_NOT_REJECTED", async () => {
    const client = createReadyClient();
    const { logWarn } = await import("../../utils/logger.js");
    const results: Array<{ id: string; result: SpawnResult }> = [];
    client.on("spawn-result", (id: string, result: SpawnResult) => {
      results.push({ id, result });
    });

    for (let i = 0; i < MAX_PENDING_SPAWNS; i++) {
      client.spawn(`t-${i}`, baseSpawnOptions());
    }
    (logWarn as Mock).mockClear();
    mockChild.postMessage.mockClear();

    client.spawn("t-0", baseSpawnOptions({ cwd: "/updated" }));

    expect(logWarn).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
    const updatedSpawns = mockChild.postMessage.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { type?: string })?.type === "spawn" &&
        (call[0] as { id?: string })?.id === "t-0"
    );
    expect(updatedSpawns).toHaveLength(1);
    expect((updatedSpawns[0][0] as { options: PtyHostSpawnOptions }).options.cwd).toBe("/updated");
  });

  it("RESPAWN_AFTER_CRASH_DOES_NOT_EXCEED_CAP", () => {
    const client = createReadyClient();
    const restartedChild = createMockChild();

    for (let i = 0; i < MAX_PENDING_SPAWNS; i++) {
      client.spawn(`t-${i}`, baseSpawnOptions({ cwd: `/cwd/${i}` }));
    }
    client.spawn("t-overflow", baseSpawnOptions());

    shared.forkMock.mockReturnValue(restartedChild);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(2000);
    restartedChild.emit("message", { type: "ready" });

    const replayedSpawns = restartedChild.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "spawn"
    ) as Array<[{ type: "spawn"; id: string; options: PtyHostSpawnOptions }]>;
    expect(replayedSpawns).toHaveLength(MAX_PENDING_SPAWNS);

    const replayedIds = replayedSpawns.map(([msg]) => msg.id);
    const expectedIds = Array.from({ length: MAX_PENDING_SPAWNS }, (_, i) => `t-${i}`);
    expect(new Set(replayedIds)).toEqual(new Set(expectedIds));
    expect(replayedIds).not.toContain("t-overflow");
    expect(new Set(replayedIds).size).toBe(replayedIds.length); // no duplicates

    for (const [msg] of replayedSpawns) {
      const idx = Number(msg.id.slice(2));
      expect(msg.options.cwd).toBe(`/cwd/${idx}`);
    }

    expect(client.hasTerminal("t-overflow")).toBe(false);
    // dispose to avoid leaking timers/listeners across tests
    client.dispose();
  });

  it("REJECTED_THEN_SUCCEEDING_SAME_ID_EMITS_FAILURE_THEN_SUCCESS", () => {
    const client = createReadyClient();
    const results: Array<{ id: string; result: SpawnResult }> = [];
    client.on("spawn-result", (id: string, result: SpawnResult) => {
      results.push({ id, result });
    });

    for (let i = 0; i < MAX_PENDING_SPAWNS; i++) {
      client.spawn(`t-${i}`, baseSpawnOptions());
    }
    client.spawn("t-overflow", baseSpawnOptions());
    expect(results).toHaveLength(1);
    expect(results[0].result.success).toBe(false);

    client.kill("t-0");
    client.spawn("t-overflow", baseSpawnOptions());
    expect(client.hasTerminal("t-overflow")).toBe(true);

    // Host eventually replies with success for the admitted spawn
    mockChild.emit("message", {
      type: "spawn-result",
      id: "t-overflow",
      result: { success: true, id: "t-overflow" } satisfies SpawnResult,
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "t-overflow",
      result: { success: false, id: "t-overflow" },
    });
    expect(results[0].result.error?.code).toBe("PENDING_SPAWNS_CAPPED");
    expect(results[1]).toMatchObject({
      id: "t-overflow",
      result: { success: true, id: "t-overflow" },
    });
  });
});
