import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "events";

const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const appEmitter = new EventEmitter();
  const appMock = Object.assign(appEmitter, {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  });
  return {
    forkMock: vi.fn(),
    appMock,
    trackEventMock: vi.fn(),
  };
});

vi.mock("electron", () => ({
  utilityProcess: {
    fork: shared.forkMock,
  },
  UtilityProcess: EventEmitter,
  app: shared.appMock,
}));

vi.mock("../TelemetryService.js", () => ({
  trackEvent: shared.trackEventMock,
}));

interface MockChild extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid?: number;
}

function createMockChild(): MockChild {
  return Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 9999 as number | undefined,
  });
}

describe("MainProcessWatchdogClient", () => {
  let mockChild: MockChild;
  let WatchdogClient: typeof import("../MainProcessWatchdogClient.js").MainProcessWatchdogClient;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    // Drain any lingering mockReturnValueOnce queue from prior tests —
    // `clearAllMocks()` resets call history but not queued implementations,
    // so a previous test's unconsumed queue can hijack the next constructor's
    // fork() and attach the exit handler to a stale child.
    shared.forkMock.mockReset();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);
    ({ MainProcessWatchdogClient: WatchdogClient } =
      await import("../MainProcessWatchdogClient.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("forks the watchdog with serviceName and --main-pid argv", () => {
    new WatchdogClient({ mainPid: 4242 });

    expect(shared.forkMock).toHaveBeenCalledTimes(1);
    const [, argv, options] = shared.forkMock.mock.calls[0];
    expect(argv).toEqual(["--main-pid=4242"]);
    expect(options).toMatchObject({
      serviceName: "daintree-watchdog",
      stdio: "pipe",
    });
    expect(options.env).toMatchObject({
      DAINTREE_USER_DATA: "/mock/user/data",
      DAINTREE_UTILITY_PROCESS_KIND: "watchdog-host",
    });
  });

  it("sends an immediate ping on fork so the watchdog arms before the first interval", () => {
    new WatchdogClient({ mainPid: 4242 });
    const pings = mockChild.postMessage.mock.calls.filter(
      (call) => (call[0] as { type?: string })?.type === "ping"
    );
    expect(pings.length).toBeGreaterThanOrEqual(1);
  });

  it("sends a ping every 5 seconds", () => {
    new WatchdogClient({ mainPid: 4242 });
    mockChild.postMessage.mockClear();

    vi.advanceTimersByTime(5000);
    let pings = mockChild.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "ping"
    );
    expect(pings).toHaveLength(1);

    vi.advanceTimersByTime(15000);
    pings = mockChild.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "ping"
    );
    expect(pings).toHaveLength(4);
  });

  it("pause() stops the ping interval and posts {type: 'sleep'}", () => {
    const client = new WatchdogClient({ mainPid: 4242 });
    mockChild.postMessage.mockClear();

    client.pause();

    const sleeps = mockChild.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "sleep"
    );
    expect(sleeps).toHaveLength(1);

    // Advance 30s — no further pings should fire while paused.
    vi.advanceTimersByTime(30_000);
    const pings = mockChild.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "ping"
    );
    expect(pings).toHaveLength(0);
  });

  it("resume() posts {type: 'wake'}, an immediate ping, and restarts the interval", () => {
    const client = new WatchdogClient({ mainPid: 4242 });
    client.pause();
    mockChild.postMessage.mockClear();

    client.resume();

    const calls = mockChild.postMessage.mock.calls.map((c) => (c[0] as { type?: string })?.type);
    expect(calls.filter((t) => t === "wake")).toHaveLength(1);
    expect(calls.filter((t) => t === "ping").length).toBeGreaterThanOrEqual(1);

    // Interval restarts: a 5s tick produces another ping.
    mockChild.postMessage.mockClear();
    vi.advanceTimersByTime(5000);
    const pingsAfter = mockChild.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "ping"
    );
    expect(pingsAfter).toHaveLength(1);
  });

  it("dispose() posts 'dispose', kills the child, and stops the ping interval", () => {
    const client = new WatchdogClient({ mainPid: 4242 });
    mockChild.postMessage.mockClear();

    client.dispose();

    const disposeCalls = mockChild.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "dispose"
    );
    expect(disposeCalls).toHaveLength(1);
    expect(mockChild.kill).toHaveBeenCalledTimes(1);

    // No further pings after dispose.
    mockChild.postMessage.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(mockChild.postMessage).not.toHaveBeenCalled();
  });

  it("dispose() is idempotent", () => {
    const client = new WatchdogClient({ mainPid: 4242 });
    client.dispose();
    expect(() => client.dispose()).not.toThrow();
  });

  it("schedules a restart with backoff when the watchdog exits unexpectedly", () => {
    new WatchdogClient({ mainPid: 4242, maxRestartAttempts: 3 });
    expect(shared.forkMock).toHaveBeenCalledTimes(1);

    // Simulate a crash.
    mockChild.emit("exit", 1);

    // Advance past the maximum cap (10s) so the timer always fires regardless
    // of jitter — fork must be called again.
    const nextChild = createMockChild();
    shared.forkMock.mockReturnValue(nextChild);
    vi.advanceTimersByTime(11_000);

    expect(shared.forkMock).toHaveBeenCalledTimes(2);
  });

  it("stops restarting after maxRestartAttempts (deadlock detection becomes inactive)", () => {
    new WatchdogClient({ mainPid: 4242, maxRestartAttempts: 2 });

    // Simulate repeated crashes — track when each new child appears so we
    // can attach the next exit emission to it.
    let currentChild = mockChild;
    for (let i = 0; i < 3; i++) {
      const next = createMockChild();
      shared.forkMock.mockReturnValueOnce(next);
      currentChild.emit("exit", 1);
      vi.advanceTimersByTime(11_000);
      currentChild = next;
    }

    // Initial fork + 2 restart attempts = 3 total. The 4th is suppressed.
    expect(shared.forkMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("does not throw if postMessage fails (channel torn down)", () => {
    const client = new WatchdogClient({ mainPid: 4242 });
    mockChild.postMessage.mockImplementation(() => {
      throw new Error("channel closed");
    });

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(() => client.pause()).not.toThrow();
    expect(() => client.resume()).not.toThrow();
    expect(() => client.dispose()).not.toThrow();
  });

  it("isRunning() reflects child lifecycle", () => {
    const client = new WatchdogClient({ mainPid: 4242 });
    expect(client.isRunning()).toBe(true);

    mockChild.emit("exit", 0);
    expect(client.isRunning()).toBe(false);

    client.dispose();
    expect(client.isRunning()).toBe(false);
  });

  it("does not start the host when startImmediately is false", () => {
    new WatchdogClient({ mainPid: 4242, startImmediately: false });
    expect(shared.forkMock).not.toHaveBeenCalled();
  });

  it("uses process.pid when mainPid config is omitted", () => {
    new WatchdogClient();
    const argv = shared.forkMock.mock.calls[0][1] as string[];
    expect(argv[0]).toBe(`--main-pid=${process.pid}`);
  });

  it("a watchdog that crashes during sleep restarts in paused state (sleep sent after arming ping)", () => {
    const client = new WatchdogClient({ mainPid: 4242, maxRestartAttempts: 3 });
    client.pause();

    // Simulate the watchdog crashing during sleep.
    const replacementChild = createMockChild();
    shared.forkMock.mockReturnValue(replacementChild);
    mockChild.emit("exit", 1);

    // Drive the restart timer past the cap so the new fork happens.
    vi.advanceTimersByTime(11_000);
    expect(shared.forkMock).toHaveBeenCalledTimes(2);

    // The replacement child must have received both an arming ping AND a
    // "sleep" message — without "sleep", its tick interval would accumulate
    // missed beats during sleep and SIGKILL main on wake.
    const types = replacementChild.postMessage.mock.calls.map(
      (c) => (c[0] as { type?: string })?.type
    );
    expect(types).toContain("ping");
    expect(types).toContain("sleep");

    // No ping interval should be running while paused — verify by advancing
    // time and counting subsequent pings.
    replacementChild.postMessage.mockClear();
    vi.advanceTimersByTime(30_000);
    const subsequentPings = replacementChild.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "ping"
    );
    expect(subsequentPings).toHaveLength(0);
    client.dispose();
  });

  it("disposeMainProcessWatchdog() disposes the singleton instance", async () => {
    const { getMainProcessWatchdogClient, disposeMainProcessWatchdog } =
      await import("../MainProcessWatchdogClient.js");
    const singleton = getMainProcessWatchdogClient({ mainPid: 4242 });
    expect(singleton.isRunning()).toBe(true);

    disposeMainProcessWatchdog();
    expect(singleton.isRunning()).toBe(false);

    // Subsequent calls return a fresh instance.
    const next = getMainProcessWatchdogClient({ mainPid: 4242 });
    expect(next).not.toBe(singleton);
    next.dispose();
  });

  it("restartAttempts resets after the watchdog stays alive long enough to be considered stable", () => {
    new WatchdogClient({ mainPid: 4242, maxRestartAttempts: 2 });

    // Crash once → restart triggered, attempts=1.
    let currentChild = mockChild;
    let next = createMockChild();
    shared.forkMock.mockReturnValueOnce(next);
    currentChild.emit("exit", 1);
    vi.advanceTimersByTime(11_000);
    currentChild = next;
    expect(shared.forkMock).toHaveBeenCalledTimes(2);

    // Advance past the stability reset window so restartAttempts goes back to 0.
    vi.advanceTimersByTime(31_000);

    // Two more crashes should now be tolerated (counter has reset).
    next = createMockChild();
    shared.forkMock.mockReturnValueOnce(next);
    currentChild.emit("exit", 1);
    vi.advanceTimersByTime(11_000);
    currentChild = next;
    expect(shared.forkMock).toHaveBeenCalledTimes(3);

    next = createMockChild();
    shared.forkMock.mockReturnValueOnce(next);
    currentChild.emit("exit", 1);
    vi.advanceTimersByTime(11_000);
    expect(shared.forkMock).toHaveBeenCalledTimes(4);
  });

  it("pause() before resume() is a no-op when called on an already-paused client", () => {
    const client = new WatchdogClient({ mainPid: 4242 });
    client.pause();
    mockChild.postMessage.mockClear();
    client.pause();
    const sleeps = mockChild.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "sleep"
    );
    expect(sleeps).toHaveLength(0);
  });

  it("fires onDisabled listener exactly once when the restart cap is hit", () => {
    const client = new WatchdogClient({ mainPid: 4242, maxRestartAttempts: 2 });
    const listener = vi.fn();
    client.onDisabled(listener);

    // Drive 3 crash cycles: 2 restarts, 3rd hits the cap.
    let currentChild = mockChild;
    for (let i = 0; i < 3; i++) {
      const next = createMockChild();
      shared.forkMock.mockReturnValueOnce(next);
      currentChild.emit("exit", 137);
      vi.advanceTimersByTime(11_000);
      currentChild = next;
    }

    expect(listener).toHaveBeenCalledTimes(1);
    const payload = listener.mock.calls[0][0] as {
      attemptCount: number;
      lastExitCode: number | null;
      timestamp: number;
    };
    expect(payload.attemptCount).toBe(2);
    expect(payload.lastExitCode).toBe(137);
    expect(typeof payload.timestamp).toBe("number");
    client.dispose();
  });

  it("sends a watchdog_disabled telemetry event when the restart cap is hit", () => {
    shared.trackEventMock.mockClear();
    const client = new WatchdogClient({ mainPid: 4242, maxRestartAttempts: 1 });

    // 1 restart, 2nd exit hits the cap.
    const next = createMockChild();
    shared.forkMock.mockReturnValueOnce(next);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(11_000);
    next.emit("exit", 1);

    expect(shared.trackEventMock).toHaveBeenCalledTimes(1);
    const [eventName, props] = shared.trackEventMock.mock.calls[0];
    expect(eventName).toBe("watchdog_disabled");
    expect(props).toMatchObject({
      attemptCount: 1,
      lastExitCode: 1,
    });
    client.dispose();
  });

  it("does not call onDisabled or telemetry on intermediate restarts below the cap", () => {
    shared.trackEventMock.mockClear();
    const client = new WatchdogClient({ mainPid: 4242, maxRestartAttempts: 3 });
    const listener = vi.fn();
    client.onDisabled(listener);

    // One crash below the cap.
    const next = createMockChild();
    shared.forkMock.mockReturnValueOnce(next);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(11_000);

    expect(listener).not.toHaveBeenCalled();
    expect(shared.trackEventMock).not.toHaveBeenCalled();
    client.dispose();
  });

  it("does not refire onDisabled when scheduleRestart is invoked again while still capped", () => {
    const client = new WatchdogClient({ mainPid: 4242, maxRestartAttempts: 1 });
    const listener = vi.fn();
    client.onDisabled(listener);

    // 1 restart, 2nd exit hits cap, listener fires once.
    const next = createMockChild();
    shared.forkMock.mockReturnValueOnce(next);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(11_000);
    next.emit("exit", 1);
    expect(listener).toHaveBeenCalledTimes(1);

    // A second cap-hit before restart() is a no-op — no extra fires.
    // (No fork happens after the cap, but defensively assert.)
    vi.advanceTimersByTime(11_000);
    expect(listener).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("restart() resets attempt counters, forks a fresh child, and re-arms the disabled listener", () => {
    const client = new WatchdogClient({ mainPid: 4242, maxRestartAttempts: 1 });
    const listener = vi.fn();
    client.onDisabled(listener);

    // First cap-hit cycle.
    const second = createMockChild();
    shared.forkMock.mockReturnValueOnce(second);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(11_000);
    second.emit("exit", 1);
    expect(listener).toHaveBeenCalledTimes(1);

    // Manual restart — a fresh fork happens.
    const third = createMockChild();
    shared.forkMock.mockReturnValueOnce(third);
    client.restart();
    expect(shared.forkMock).toHaveBeenCalledTimes(3);

    // A second cap-hit cycle re-fires the listener (re-armed).
    const fourth = createMockChild();
    shared.forkMock.mockReturnValueOnce(fourth);
    third.emit("exit", 1);
    vi.advanceTimersByTime(11_000);
    fourth.emit("exit", 1);
    expect(listener).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("restart() is a no-op after dispose", () => {
    const client = new WatchdogClient({ mainPid: 4242 });
    client.dispose();
    const forksBefore = shared.forkMock.mock.calls.length;
    expect(() => client.restart()).not.toThrow();
    expect(shared.forkMock.mock.calls.length).toBe(forksBefore);
  });

  it("restart() while the child is still running only resets counters (no extra fork)", () => {
    const client = new WatchdogClient({ mainPid: 4242, maxRestartAttempts: 5 });
    expect(shared.forkMock).toHaveBeenCalledTimes(1);
    client.restart();
    // Already running — no new fork, counters reset silently.
    expect(shared.forkMock).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
