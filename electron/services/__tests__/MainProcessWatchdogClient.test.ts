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

  it("forks with a V8 heap cap without dropping the diagnostic execArgv flags", () => {
    new WatchdogClient({ mainPid: 4242 });

    const execArgv: string[] = shared.forkMock.mock.calls[0][2].execArgv;
    expect(execArgv.some((arg) => /^--max-old-space-size=\d+$/.test(arg))).toBe(true);
    expect(execArgv.some((arg) => arg.startsWith("--diagnostic-dir="))).toBe(true);
    expect(execArgv).toContain("--report-exclude-env");
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
    new WatchdogClient({ mainPid: 4242 });
    expect(shared.forkMock).toHaveBeenCalledTimes(1);

    // Simulate a crash.
    mockChild.emit("exit", 1);

    // Advance past the maximum cap (5s for the watchdog) so the timer always
    // fires regardless of jitter — fork must be called again.
    const nextChild = createMockChild();
    shared.forkMock.mockReturnValue(nextChild);
    vi.advanceTimersByTime(6_000);

    expect(shared.forkMock).toHaveBeenCalledTimes(2);
  });

  it("stops restarting after the sliding-window crash threshold (deadlock detection becomes inactive)", () => {
    new WatchdogClient({ mainPid: 4242 });

    // Simulate 3 crashes within the window — the 3rd must hit the cap.
    let currentChild = mockChild;
    for (let i = 0; i < 4; i++) {
      const next = createMockChild();
      shared.forkMock.mockReturnValueOnce(next);
      currentChild.emit("exit", 1);
      vi.advanceTimersByTime(6_000);
      currentChild = next;
    }

    // Initial fork + 2 restart attempts = 3 total. The 3rd crash trips
    // CRASH_THRESHOLD and no further fork is scheduled.
    expect(shared.forkMock.mock.calls.length).toBe(3);
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
    const client = new WatchdogClient({ mainPid: 4242 });
    client.pause();

    // Simulate the watchdog crashing during sleep.
    const replacementChild = createMockChild();
    shared.forkMock.mockReturnValue(replacementChild);
    mockChild.emit("exit", 1);

    // Drive the restart timer past the cap so the new fork happens.
    vi.advanceTimersByTime(6_000);
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

  it("clears the crash window after STABILITY_TIMEOUT_MS of clean running", () => {
    new WatchdogClient({ mainPid: 4242 });

    // Two crashes in quick succession.
    let currentChild = mockChild;
    for (let i = 0; i < 2; i++) {
      const next = createMockChild();
      shared.forkMock.mockReturnValueOnce(next);
      currentChild.emit("exit", 1);
      vi.advanceTimersByTime(6_000);
      currentChild = next;
    }
    expect(shared.forkMock).toHaveBeenCalledTimes(3);

    // 5 minutes of clean running clears the window via the stability timer.
    vi.advanceTimersByTime(300_000);

    // 3 more crashes should be tolerated — the window has reset, so the
    // first two restart while the third trips the threshold again.
    for (let i = 0; i < 3; i++) {
      const next = createMockChild();
      shared.forkMock.mockReturnValueOnce(next);
      currentChild.emit("exit", 1);
      vi.advanceTimersByTime(6_000);
      currentChild = next;
    }
    // Initial fork + 2 + 2 = 5 (the 3rd post-reset crash trips CRASH_THRESHOLD).
    expect(shared.forkMock.mock.calls.length).toBe(5);
  });

  it("does not clear the crash window on successful fork (defeats fast crash→fork→crash loops)", () => {
    // Before this fix, a brief 31s of uptime cleared `restartAttempts`,
    // letting a "crash every 35s" loop run forever. The sliding window only
    // clears via the stability timer firing after a full clean stretch —
    // a successful fork alone must NOT reset it.
    new WatchdogClient({ mainPid: 4242 });

    let currentChild = mockChild;
    for (let i = 0; i < 4; i++) {
      const next = createMockChild();
      shared.forkMock.mockReturnValueOnce(next);
      currentChild.emit("exit", 1);
      // Advance just past the backoff cap (5s) so each fork happens but not
      // long enough for the 5-minute stability timer to fire.
      vi.advanceTimersByTime(6_000);
      currentChild = next;
    }
    // Initial fork + 2 restart attempts = 3 total. The 3rd crash trips
    // the cap; no 4th fork happens despite each fork having "succeeded".
    expect(shared.forkMock.mock.calls.length).toBe(3);
  });

  it("sliding window decays — crashes older than RAPID_CRASH_WINDOW_MS are dropped", () => {
    new WatchdogClient({ mainPid: 4242 });

    // First crash.
    let currentChild = mockChild;
    let next = createMockChild();
    shared.forkMock.mockReturnValueOnce(next);
    currentChild.emit("exit", 1);
    vi.advanceTimersByTime(6_000);
    currentChild = next;
    expect(shared.forkMock).toHaveBeenCalledTimes(2);

    // Wait past the 5-minute window so the old crash decays out on the
    // next trim — but the stability timer also clears the array, so this
    // exercises the trim path. Step the clock incrementally so the
    // stability timer fires at 300s and clears the array.
    vi.advanceTimersByTime(310_000);

    // Three more crashes — the prior crash is out of the window AND was
    // cleared by the stability timer, so the third trips the threshold.
    for (let i = 0; i < 3; i++) {
      next = createMockChild();
      shared.forkMock.mockReturnValueOnce(next);
      currentChild.emit("exit", 1);
      vi.advanceTimersByTime(6_000);
      currentChild = next;
    }
    // Initial + 1 + 2 = 4 forks. The 3rd crash post-reset trips the cap.
    expect(shared.forkMock.mock.calls.length).toBe(4);
  });

  it("sliding window trims crashes older than RAPID_CRASH_WINDOW_MS without relying on the stability timer", () => {
    // Isolates the per-crash filter trim from the stability timer's bulk
    // clear. After a single crash, advance past the window but stop short
    // of `STABILITY_TIMEOUT_MS` to keep the stability timer pending — the
    // next crash must observe an empty window via the filter, not the
    // timer. Both knobs happen to be 300s in this codebase, so we use a
    // first crash that's well inside the window, then a brief restart, so
    // the stability timer is restarted by the new fork and never fires.
    new WatchdogClient({ mainPid: 4242 });

    let currentChild = mockChild;
    // First crash — schedules a restart and a fresh stability timer.
    let next = createMockChild();
    shared.forkMock.mockReturnValueOnce(next);
    currentChild.emit("exit", 1);
    vi.advanceTimersByTime(6_000);
    currentChild = next;
    expect(shared.forkMock).toHaveBeenCalledTimes(2);

    // Crash again at t≈12s — second crash in window.
    next = createMockChild();
    shared.forkMock.mockReturnValueOnce(next);
    currentChild.emit("exit", 1);
    vi.advanceTimersByTime(6_000);
    currentChild = next;
    expect(shared.forkMock).toHaveBeenCalledTimes(3);

    // Advance past RAPID_CRASH_WINDOW_MS (300s) so the prior two crash
    // timestamps decay out of the filter. The stability timer restarts on
    // every fork, so it last started at t≈18s and would fire at t≈318s.
    // Stop just before that.
    vi.advanceTimersByTime(295_000);

    // Now crash 3 more times. If trimming works, each crash starts a fresh
    // window, so we get 2 more restarts before the 3rd hits the cap.
    for (let i = 0; i < 3; i++) {
      next = createMockChild();
      shared.forkMock.mockReturnValueOnce(next);
      currentChild.emit("exit", 1);
      vi.advanceTimersByTime(6_000);
      currentChild = next;
    }
    // Initial(1) + 2 + 2 = 5. If trimming were broken, the first post-decay
    // crash would land as the 3rd entry in the window and trip the cap
    // immediately — count would stay at 3.
    expect(shared.forkMock.mock.calls.length).toBe(5);
  });

  it("dispose() while a restart timer is pending suppresses the restart fork", () => {
    // Pre-fix regression: if `dispose()` only cleared the timer but the
    // timer callback didn't recheck `isDisposed`, a near-instant
    // dispose-after-crash race could still spawn a watchdog after we
    // committed to shutting down.
    const client = new WatchdogClient({ mainPid: 4242 });
    expect(shared.forkMock).toHaveBeenCalledTimes(1);

    // Crash → restart timer scheduled.
    mockChild.emit("exit", 1);

    // Dispose before the restart cap elapses.
    client.dispose();

    // Advance past the cap — the restart fork must NOT happen.
    vi.advanceTimersByTime(10_000);
    expect(shared.forkMock).toHaveBeenCalledTimes(1);
  });

  it("uses watchdog-specific jitter constants distinct from PtyHostLifecycle", () => {
    // The watchdog must not share jitter ranges with PtyHostLifecycle —
    // correlated restart delays trigger simultaneous fork storms when both
    // services crash from a shared trigger (OOM, signal). Spy on Math.random
    // to capture both endpoints of the floor/cap range.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    new WatchdogClient({ mainPid: 4242 });

    mockChild.emit("exit", 1);
    expect(randomSpy).toHaveBeenCalled();

    // floor (random=0) → delay = RESTART_FLOOR_MS = 250ms. PtyHostLifecycle
    // uses floor=100; the watchdog's 250 means at the floor the two cannot
    // collide within the 100ms collision-window definition.
    const nextChild = createMockChild();
    shared.forkMock.mockReturnValueOnce(nextChild);
    vi.advanceTimersByTime(249);
    expect(shared.forkMock).toHaveBeenCalledTimes(1); // not yet
    vi.advanceTimersByTime(2);
    expect(shared.forkMock).toHaveBeenCalledTimes(2); // fired at 250ms

    randomSpy.mockRestore();
  });

  it("jitter cap is bounded by RESTART_CAP_MAX_MS even at high attempt counts", () => {
    // Spy with random=0.9999 so the delay lands just under the cap.
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    new WatchdogClient({ mainPid: 4242 });

    let currentChild = mockChild;
    for (let i = 0; i < 2; i++) {
      const next = createMockChild();
      shared.forkMock.mockReturnValueOnce(next);
      currentChild.emit("exit", 1);
      // 6s is past RESTART_CAP_MAX_MS (5s) — the second restart MUST fire.
      vi.advanceTimersByTime(6_000);
      currentChild = next;
    }
    // Both restarts fired within the 5s cap → 3 total forks.
    expect(shared.forkMock.mock.calls.length).toBe(3);
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
    const client = new WatchdogClient({ mainPid: 4242 });
    const listener = vi.fn();
    client.onDisabled(listener);

    // Drive 3 crash cycles within the sliding window — the 3rd trips
    // CRASH_THRESHOLD and notifies once.
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
    expect(payload.attemptCount).toBe(3);
    expect(payload.lastExitCode).toBe(137);
    expect(typeof payload.timestamp).toBe("number");
    client.dispose();
  });

  it("sends a watchdog_disabled telemetry event when the restart cap is hit", () => {
    shared.trackEventMock.mockClear();
    const client = new WatchdogClient({ mainPid: 4242 });

    // 3 crashes within the sliding window — the 3rd trips CRASH_THRESHOLD.
    let currentChild = mockChild;
    for (let i = 0; i < 3; i++) {
      const next = createMockChild();
      shared.forkMock.mockReturnValueOnce(next);
      currentChild.emit("exit", 1);
      vi.advanceTimersByTime(11_000);
      currentChild = next;
    }

    expect(shared.trackEventMock).toHaveBeenCalledTimes(1);
    const [eventName, props] = shared.trackEventMock.mock.calls[0];
    expect(eventName).toBe("watchdog_disabled");
    expect(props).toMatchObject({
      attemptCount: 3,
      lastExitCode: 1,
    });
    client.dispose();
  });

  it("does not call onDisabled or telemetry on intermediate restarts below the cap", () => {
    shared.trackEventMock.mockClear();
    const client = new WatchdogClient({ mainPid: 4242 });
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
    const client = new WatchdogClient({ mainPid: 4242 });
    const listener = vi.fn();
    client.onDisabled(listener);

    // 3 crashes trip CRASH_THRESHOLD — listener fires once.
    let currentChild = mockChild;
    for (let i = 0; i < 3; i++) {
      const next = createMockChild();
      shared.forkMock.mockReturnValueOnce(next);
      currentChild.emit("exit", 1);
      vi.advanceTimersByTime(11_000);
      currentChild = next;
    }
    expect(listener).toHaveBeenCalledTimes(1);

    // A second cap-hit before restart() is a no-op — no extra fires.
    // (No fork happens after the cap, but defensively assert.)
    vi.advanceTimersByTime(11_000);
    expect(listener).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("restart() resets the crash window, forks a fresh child, and re-arms the disabled listener", () => {
    const client = new WatchdogClient({ mainPid: 4242 });
    const listener = vi.fn();
    client.onDisabled(listener);

    // First cap-hit cycle: queue 2 replacements (3rd crash hits the cap and
    // does not fork). Crashes 1 & 2 consume the queue; crash 3 trips
    // CRASH_THRESHOLD and notifies once.
    const second = createMockChild();
    const third = createMockChild();
    shared.forkMock.mockReturnValueOnce(second).mockReturnValueOnce(third);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(11_000);
    second.emit("exit", 1);
    vi.advanceTimersByTime(11_000);
    third.emit("exit", 1);
    expect(listener).toHaveBeenCalledTimes(1);

    // Manual restart — clears crashTimestamps + disabledNotified and forks fresh.
    const forksBeforeRestart = shared.forkMock.mock.calls.length;
    const fresh = createMockChild();
    shared.forkMock.mockReturnValueOnce(fresh);
    client.restart();
    expect(shared.forkMock).toHaveBeenCalledTimes(forksBeforeRestart + 1);

    // A second cap-hit cycle re-fires the listener (re-armed).
    const fifth = createMockChild();
    const sixth = createMockChild();
    shared.forkMock.mockReturnValueOnce(fifth).mockReturnValueOnce(sixth);
    fresh.emit("exit", 1);
    vi.advanceTimersByTime(11_000);
    fifth.emit("exit", 1);
    vi.advanceTimersByTime(11_000);
    sixth.emit("exit", 1);
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

  it("restart() while the child is still running only resets the crash window (no extra fork)", () => {
    const client = new WatchdogClient({ mainPid: 4242 });
    expect(shared.forkMock).toHaveBeenCalledTimes(1);
    client.restart();
    // Already running — no new fork, crash window reset silently.
    expect(shared.forkMock).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
