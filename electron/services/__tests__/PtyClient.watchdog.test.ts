import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "events";

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

interface MockUtilityProcess extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid?: number;
}

interface WatchdogPrivate {
  child: MockUtilityProcess | null;
  missedHeartbeats: number;
  isHealthCheckPaused: boolean;
  healthCheckInterval: NodeJS.Timeout | null;
  isInitialized: boolean;
  isWaitingForHandshake: boolean;
}

function createMockChild(): MockUtilityProcess {
  return Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 321 as number | undefined,
  });
}

describe("PtyClient watchdog", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    shared.appMock.removeAllListeners();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);
    killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);

    ({ PtyClient: PtyClientClass } = await import("../PtyClient.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createReadyClient(
    config?: import("../PtyClient.js").PtyClientConfig
  ): import("../PtyClient.js").PtyClient {
    const client = new PtyClientClass(config);
    mockChild.emit("message", { type: "ready" });
    return client;
  }

  it("THREE_MISSED_PONGS_TRIGGER_FORCE_KILL", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const crashListener = vi.fn();
    client.on("host-crash-details", crashListener);

    // Ticks 1-3 increment the counter to 1, 2, 3. Tick 4 (counter >= MAX_MISSED_HEARTBEATS=3)
    // fires the watchdog: emits crash details, then calls process.kill.
    vi.advanceTimersByTime(400);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(321, "SIGKILL");
    expect(crashListener).toHaveBeenCalledTimes(1);
    // Watchdog resets the counter to 0 after firing so the next tick starts fresh.
    expect((client as unknown as WatchdogPrivate).missedHeartbeats).toBe(0);
  });

  it("CRASH_DETAILS_EMITTED_BEFORE_KILL_WITH_SIGNAL_PAYLOAD", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const callOrder: string[] = [];
    let capturedPayload: unknown;
    client.on("host-crash-details", (payload: unknown) => {
      callOrder.push("event");
      capturedPayload = payload;
    });
    killSpy.mockImplementation((() => {
      callOrder.push("kill");
      return true;
    }) as typeof process.kill);

    vi.advanceTimersByTime(400);

    expect(callOrder).toEqual(["event", "kill"]);
    expect(capturedPayload).toMatchObject({
      code: null,
      signal: "SIGKILL",
      crashType: "SIGNAL_TERMINATED",
      timestamp: expect.any(Number),
    });
  });

  it("PONG_BEFORE_THIRD_MISS_RESETS_COUNTER", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;

    vi.advanceTimersByTime(200);
    expect(priv.missedHeartbeats).toBe(2);

    mockChild.emit("message", { type: "pong" });
    expect(priv.missedHeartbeats).toBe(0);

    // Three more ticks bring the counter back to 3 without triggering the kill.
    vi.advanceTimersByTime(300);
    expect(priv.missedHeartbeats).toBe(3);
    expect(killSpy).not.toHaveBeenCalled();

    // The fourth tick is the one that fires the watchdog guard.
    vi.advanceTimersByTime(100);
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("PAUSE_MID_COUNT_FREEZES_COUNTER", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;

    vi.advanceTimersByTime(200);
    expect(priv.missedHeartbeats).toBe(2);

    client.pauseHealthCheck();
    expect(priv.isHealthCheckPaused).toBe(true);
    expect(priv.healthCheckInterval).toBeNull();

    // With the interval cleared, advancing time has no effect on the counter.
    vi.advanceTimersByTime(10_000);
    expect(priv.missedHeartbeats).toBe(2);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("NULL_CHILD_MID_TICK_NO_KILL_NO_THROW", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;
    const crashListener = vi.fn();
    client.on("host-crash-details", crashListener);

    // Drive the counter up to the threshold, then simulate the exit-event race:
    // the host is gone (child = null) when the 4th tick tries to fire the watchdog.
    vi.advanceTimersByTime(300);
    expect(priv.missedHeartbeats).toBe(3);

    priv.child = null;

    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(killSpy).not.toHaveBeenCalled();
    expect(crashListener).not.toHaveBeenCalled();
  });

  it("PONG_AFTER_PAUSE_RESUME_REENTRY_RESETS_COUNTER", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;

    vi.advanceTimersByTime(200);
    expect(priv.missedHeartbeats).toBe(2);

    // pauseHealthCheck clears the interval but leaves the counter untouched.
    client.pauseHealthCheck();
    expect(priv.missedHeartbeats).toBe(2);

    // resumeHealthCheck sends a handshake ping and arms a 5s fallback timeout.
    client.resumeHealthCheck();
    expect(priv.isWaitingForHandshake).toBe(true);

    // A pong during the handshake window clears the counter and re-enters
    // startHealthCheckInterval(), which itself resets missedHeartbeats to 0.
    mockChild.emit("message", { type: "pong" });
    expect(priv.isWaitingForHandshake).toBe(false);
    expect(priv.missedHeartbeats).toBe(0);

    // Re-armed interval takes 4 fresh ticks to reach the kill threshold.
    vi.advanceTimersByTime(300);
    expect(killSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("MISSING_PID_SKIPS_KILL_BUT_EMITS_CRASH_DETAILS", () => {
    // Race: the child process lost its pid (e.g. spawn failure / early exit) but
    // is still the referenced child. Watchdog should emit the crash event but
    // skip the signal to avoid `process.kill(undefined, ...)`.
    mockChild.pid = undefined;
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const crashListener = vi.fn();
    client.on("host-crash-details", crashListener);

    vi.advanceTimersByTime(400);

    expect(crashListener).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("PID_CLEARED_MID_FLIGHT_SKIPS_KILL", () => {
    // Complementary to MISSING_PID: the host starts with a valid pid, receives
    // heartbeats, then loses its pid right before the 4th tick. The watchdog
    // reads child.pid fresh each tick, so it should still emit crash details
    // but skip the signal.
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const crashListener = vi.fn();
    client.on("host-crash-details", crashListener);

    vi.advanceTimersByTime(300);
    mockChild.pid = undefined;
    vi.advanceTimersByTime(100);

    expect(crashListener).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("STEADY_STATE_PONGS_NEVER_KILL", () => {
    // Happy path: host answers every health-check with a pong. Over many ticks,
    // the watchdog must never fire and the counter must never cross the
    // threshold. This is the most common runtime state — a regression that
    // started force-killing healthy hosts would be catastrophic.
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;
    const crashListener = vi.fn();
    client.on("host-crash-details", crashListener);

    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(100);
      mockChild.emit("message", { type: "pong" });
    }

    expect(killSpy).not.toHaveBeenCalled();
    expect(crashListener).not.toHaveBeenCalled();
    expect(priv.missedHeartbeats).toBe(0);
    const healthChecks = mockChild.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "health-check"
    );
    expect(healthChecks).toHaveLength(20);
  });

  it("HANDSHAKE_TIMEOUT_FALLBACK_RESETS_COUNTER", () => {
    // Alternate re-entry path: resume without a pong arriving. After the 5s
    // fallback timeout fires, startHealthCheckInterval() is called via the
    // timeout branch (PtyClient.ts:1325-1332) instead of the pong branch.
    // Either way, missedHeartbeats must be reset.
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;

    vi.advanceTimersByTime(200);
    expect(priv.missedHeartbeats).toBe(2);

    client.pauseHealthCheck();
    client.resumeHealthCheck();
    expect(priv.isWaitingForHandshake).toBe(true);

    // No pong: handshake timeout (5000ms) fires and falls back to
    // startHealthCheckInterval() which resets the counter.
    vi.advanceTimersByTime(5000);
    expect(priv.isWaitingForHandshake).toBe(false);
    expect(priv.missedHeartbeats).toBe(0);

    vi.advanceTimersByTime(300);
    expect(killSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(killSpy).toHaveBeenCalledTimes(1);
  });
});
