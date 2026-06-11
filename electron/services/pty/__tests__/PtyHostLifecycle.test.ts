import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "events";
import {
  classifyCrash,
  mapGoneReasonToCrashType,
  PtyHostLifecycle,
  type PtyHostLifecycleCallbacks,
} from "../PtyHostLifecycle.js";

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
  };
});

vi.mock("electron", () => ({
  utilityProcess: {
    fork: shared.forkMock,
  },
  app: shared.appMock,
}));

interface MockUtilityProcess extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid?: number;
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

function createCallbacks(): {
  callbacks: PtyHostLifecycleCallbacks;
  log: {
    onMessageCalls: unknown[];
    onExitSyncCalls: Array<Parameters<PtyHostLifecycleCallbacks["onExitSync"]>[0]>;
    onCrashClassifiedCalls: Array<Parameters<PtyHostLifecycleCallbacks["onCrashClassified"]>[0]>;
    onMaxRestartsCalls: Array<number | null>;
    onForkFailedCalls: unknown[];
    onBeforeRestartCalls: number;
    isDisposed: { current: boolean };
  };
} {
  const onMessageCalls: unknown[] = [];
  const onExitSyncCalls: Array<Parameters<PtyHostLifecycleCallbacks["onExitSync"]>[0]> = [];
  const onCrashClassifiedCalls: Array<
    Parameters<PtyHostLifecycleCallbacks["onCrashClassified"]>[0]
  > = [];
  const onMaxRestartsCalls: Array<number | null> = [];
  const onForkFailedCalls: unknown[] = [];
  let onBeforeRestartCalls = 0;
  const isDisposed = { current: false };

  const callbacks: PtyHostLifecycleCallbacks = {
    onMessage: (e) => onMessageCalls.push(e),
    onExitSync: (info) => onExitSyncCalls.push(info),
    onCrashClassified: (info) => onCrashClassifiedCalls.push(info),
    onMaxRestartsReached: (code) => onMaxRestartsCalls.push(code),
    onForkFailed: (err) => onForkFailedCalls.push(err),
    onBeforeRestart: () => {
      onBeforeRestartCalls++;
    },
    isDisposed: () => isDisposed.current,
    logInfo: vi.fn(),
    logWarn: vi.fn(),
  };

  return {
    callbacks,
    log: {
      onMessageCalls,
      onExitSyncCalls,
      onCrashClassifiedCalls,
      onMaxRestartsCalls,
      onForkFailedCalls,
      get onBeforeRestartCalls() {
        return onBeforeRestartCalls;
      },
      isDisposed,
    },
  };
}

describe("classifyCrash", () => {
  let originalPlatformDescriptor: PropertyDescriptor | undefined;

  function stubPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", {
      value,
      configurable: true,
      writable: false,
    });
  }

  beforeEach(() => {
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    stubPlatform("linux");
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("returns CLEAN_EXIT for code 0", () => {
    expect(classifyCrash(0, null)).toBe("CLEAN_EXIT");
  });

  it("returns SIGNAL_TERMINATED for null code", () => {
    expect(classifyCrash(null, null)).toBe("SIGNAL_TERMINATED");
  });

  it("returns OUT_OF_MEMORY for SIGKILL exit code 137", () => {
    expect(classifyCrash(137, null)).toBe("OUT_OF_MEMORY");
    expect(classifyCrash(99, "SIGKILL")).toBe("OUT_OF_MEMORY");
  });

  it("returns ASSERTION_FAILURE for SIGABRT exit code 134", () => {
    expect(classifyCrash(134, null)).toBe("ASSERTION_FAILURE");
    expect(classifyCrash(50, "SIGABRT")).toBe("ASSERTION_FAILURE");
  });

  it("returns SIGNAL_TERMINATED for codes > 128 on POSIX (other signals)", () => {
    expect(classifyCrash(140, null)).toBe("SIGNAL_TERMINATED");
  });

  it("returns UNKNOWN_CRASH for non-zero codes ≤128 with no signal", () => {
    expect(classifyCrash(1, null)).toBe("UNKNOWN_CRASH");
    expect(classifyCrash(127, null)).toBe("UNKNOWN_CRASH");
  });

  it("falls through to UNKNOWN_CRASH for Windows NTSTATUS exit codes", () => {
    stubPlatform("win32");
    // STATUS_ACCESS_VIOLATION (0xC0000005)
    expect(classifyCrash(3221225477, null)).toBe("UNKNOWN_CRASH");
    // STATUS_STACK_OVERFLOW (0xC00000FD)
    expect(classifyCrash(3221225725, null)).toBe("UNKNOWN_CRASH");
    // STATUS_BREAKPOINT (0x80000003)
    expect(classifyCrash(2147483651, null)).toBe("UNKNOWN_CRASH");
    // POSIX-shaped boundary value still falls through on Windows
    expect(classifyCrash(140, null)).toBe("UNKNOWN_CRASH");
  });

  it("still honors authoritative signals and special codes on Windows", () => {
    stubPlatform("win32");
    // SIGKILL signal arrives via child-process-gone path, so should still classify OOM
    expect(classifyCrash(50, "SIGKILL")).toBe("OUT_OF_MEMORY");
    expect(classifyCrash(50, "SIGABRT")).toBe("ASSERTION_FAILURE");
    // Special exit codes 137/134 still classify regardless of platform
    expect(classifyCrash(137, null)).toBe("OUT_OF_MEMORY");
    expect(classifyCrash(134, null)).toBe("ASSERTION_FAILURE");
  });
});

describe("mapGoneReasonToCrashType", () => {
  it.each([
    ["oom", "OUT_OF_MEMORY"],
    ["memory-eviction", "OUT_OF_MEMORY"],
    ["killed", "SIGNAL_TERMINATED"],
    ["clean-exit", "CLEAN_EXIT"],
    ["crashed", "UNKNOWN_CRASH"],
    ["abnormal-exit", "UNKNOWN_CRASH"],
    ["launch-failed", "UNKNOWN_CRASH"],
    ["integrity-failure", "UNKNOWN_CRASH"],
    ["something-novel", "UNKNOWN_CRASH"],
  ] as const)("maps %s to %s", (reason, expected) => {
    expect(mapGoneReasonToCrashType(reason)).toBe(expected);
  });
});

describe("PtyHostLifecycle", () => {
  let mockChild: MockUtilityProcess;

  beforeEach(() => {
    // Fake `Date` alongside the timer functions so the time-windowed crash
    // counter's `Date.now()` comparisons advance with `vi.advanceTimersByTimeAsync`.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
    vi.clearAllMocks();
    shared.appMock.removeAllListeners();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeLifecycle(): {
    lifecycle: PtyHostLifecycle;
    callbacks: ReturnType<typeof createCallbacks>;
  } {
    const callbacks = createCallbacks();
    const lifecycle = new PtyHostLifecycle(
      { memoryLimitMb: 256, electronDir: "/tmp/electron" },
      callbacks.callbacks
    );
    return { lifecycle, callbacks };
  }

  it("forks the host with serviceName=daintree-pty-host", () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.start();
    expect(shared.forkMock).toHaveBeenCalledTimes(1);
    expect(shared.forkMock.mock.calls[0][2]).toMatchObject({
      serviceName: "daintree-pty-host",
    });
    expect(lifecycle.child).toBe(mockChild);
  });

  it("injects DAINTREE_PTY_DEFER_POOL_WARM into the fork env per the config getter (#10393)", () => {
    let defer = true;
    const callbacks = createCallbacks();
    const lifecycle = new PtyHostLifecycle(
      { memoryLimitMb: 256, electronDir: "/tmp/electron", deferInitialPoolWarm: () => defer },
      callbacks.callbacks
    );
    lifecycle.start();
    expect(shared.forkMock.mock.calls[0][2].env.DAINTREE_PTY_DEFER_POOL_WARM).toBe("1");

    // The getter is re-read on each fork, not captured at construction.
    defer = false;
    lifecycle.child = null;
    lifecycle.manualRestart();
    expect(shared.forkMock).toHaveBeenCalledTimes(2);
    expect(shared.forkMock.mock.calls[1][2].env).not.toHaveProperty("DAINTREE_PTY_DEFER_POOL_WARM");
  });

  it("omits DAINTREE_PTY_DEFER_POOL_WARM when the config getter is absent", () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.start();
    expect(shared.forkMock.mock.calls[0][2].env).not.toHaveProperty("DAINTREE_PTY_DEFER_POOL_WARM");
  });

  it("calls onForkFailed when utilityProcess.fork throws", async () => {
    const error = new Error("fork failed");
    shared.forkMock.mockImplementationOnce(() => {
      throw error;
    });
    const { lifecycle, callbacks } = makeLifecycle();
    // Attach a no-op rejection handler before start() so the failed
    // readyPromise (created inside start()) doesn't surface as unhandled.
    const origStart = lifecycle.start.bind(lifecycle);
    lifecycle.start = () => {
      origStart();
      lifecycle.waitForReady().catch(() => undefined);
    };
    lifecycle.start();
    await Promise.resolve();
    expect(callbacks.log.onForkFailedCalls).toEqual([error]);
  });

  it("readyPromise rejects if exit fires before ready", async () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.start();
    const promise = lifecycle.waitForReady();
    // Attach catch synchronously so the rejection from exit handler is
    // observed immediately and never floats as unhandled.
    const captured: { error: Error | null } = { error: null };
    promise.catch((err: Error) => {
      captured.error = err;
    });
    mockChild.emit("exit", 1);
    await Promise.resolve();
    expect(captured.error?.message).toBe("PTY host exited before ready");
  });

  it("forwards each child message to onMessage callback", () => {
    const { lifecycle, callbacks } = makeLifecycle();
    lifecycle.start();
    mockChild.emit("message", { type: "ready" });
    mockChild.emit("message", { type: "pong" });
    expect(callbacks.log.onMessageCalls).toEqual([{ type: "ready" }, { type: "pong" }]);
  });

  it("markReady transitions to initialized and resolves the promise", async () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.start();
    expect(lifecycle.isInitialized).toBe(false);

    expect(lifecycle.markReady()).toBe(true);

    expect(lifecycle.isInitialized).toBe(true);
    await expect(lifecycle.waitForReady()).resolves.toBeUndefined();
  });

  it("markReady returns false when child is null", () => {
    const { lifecycle } = makeLifecycle();
    expect(lifecycle.child).toBeNull();
    expect(lifecycle.markReady()).toBe(false);
  });

  it("isRunning reflects initialized + child state", () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.start();
    expect(lifecycle.isRunning()).toBe(false); // not yet ready
    lifecycle.markReady();
    expect(lifecycle.isRunning()).toBe(true);
  });

  it("exit handler defers crash classification by setImmediate", async () => {
    const { lifecycle, callbacks } = makeLifecycle();
    lifecycle.start();
    lifecycle.markReady();

    mockChild.emit("exit", 1);

    // Sync portion: onExitSync fires
    expect(callbacks.log.onExitSyncCalls).toHaveLength(1);
    expect(callbacks.log.onExitSyncCalls[0]).toMatchObject({
      code: 1,
      wasReady: true,
      fallbackCrashType: "UNKNOWN_CRASH",
    });
    // Deferred portion not yet fired
    expect(callbacks.log.onCrashClassifiedCalls).toHaveLength(0);

    // Flush setImmediate
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.log.onCrashClassifiedCalls).toHaveLength(1);
    expect(callbacks.log.onCrashClassifiedCalls[0]).toMatchObject({
      crashType: "UNKNOWN_CRASH",
      reportedCode: 1,
    });
  });

  it("uses child-process-gone reason over exit-code heuristic when both arrive", async () => {
    const { lifecycle, callbacks } = makeLifecycle();
    lifecycle.start();
    lifecycle.markReady();

    // Simulate the Electron 37-41 race: child-process-gone arrives BEFORE exit
    shared.appMock.emit(
      "child-process-gone",
      {} as Electron.Event,
      {
        type: "Utility",
        name: "daintree-pty-host",
        reason: "oom",
        exitCode: 137,
      } as Electron.Details
    );

    mockChild.emit("exit", 1);

    // Flush setImmediate
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.log.onCrashClassifiedCalls[0]).toMatchObject({
      crashType: "OUT_OF_MEMORY",
      reportedCode: 137, // prefers gone.exitCode over exit's code
    });
    expect(callbacks.log.onCrashClassifiedCalls[0].payload).toMatchObject({
      crashType: "OUT_OF_MEMORY",
      code: 137,
      signal: null, // cleared when authoritative reason is present
    });
  });

  it("suppresses POSIX signal-string derivation on Windows for NTSTATUS exit codes", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
      writable: false,
    });
    try {
      const { lifecycle, callbacks } = makeLifecycle();
      lifecycle.start();
      lifecycle.markReady();

      // 0xC0000005 = STATUS_ACCESS_VIOLATION — would derive "SIG3221225349" on POSIX path
      mockChild.emit("exit", 3221225477);

      expect(callbacks.log.onExitSyncCalls[0]).toMatchObject({
        code: 3221225477,
        // Without the platform guard, classifyCrash would return SIGNAL_TERMINATED
        // for any code > 128 — Windows NTSTATUS values must fall through.
        fallbackCrashType: "UNKNOWN_CRASH",
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(callbacks.log.onCrashClassifiedCalls[0]).toMatchObject({
        crashType: "UNKNOWN_CRASH",
        reportedCode: 3221225477,
        signal: null, // suppressed — no nonsense "SIG3221225349"
      });
      expect(callbacks.log.onCrashClassifiedCalls[0].payload).toMatchObject({
        crashType: "UNKNOWN_CRASH",
        signal: null,
      });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, "platform", originalDescriptor);
      }
    }
  });

  it("ignores child-process-gone for unrelated utility processes", async () => {
    const { lifecycle, callbacks } = makeLifecycle();
    lifecycle.start();
    lifecycle.markReady();

    shared.appMock.emit(
      "child-process-gone",
      {} as Electron.Event,
      {
        type: "Utility",
        name: "some-other-host",
        reason: "oom",
        exitCode: 137,
      } as Electron.Details
    );

    mockChild.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.log.onCrashClassifiedCalls[0]).toMatchObject({
      crashType: "CLEAN_EXIT",
      reportedCode: 0, // falls back to exit's code
    });
  });

  it("schedules a restart with full-jitter backoff", async () => {
    const { lifecycle, callbacks } = makeLifecycle();
    lifecycle.start();
    lifecycle.markReady();
    expect(lifecycle.crashTimestamps).toHaveLength(0);

    // First crash: schedules restart attempt 1
    mockChild.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(1);

    // Restart timer is scheduled
    expect(lifecycle.restartTimer).not.toBeNull();
    expect(callbacks.log.onMaxRestartsCalls).toHaveLength(0);

    // Fire the timer (max delay 4000ms for attempt 1: 2^1 * 1000)
    const newChild = createMockChild();
    shared.forkMock.mockReturnValueOnce(newChild);
    // Pre-attach a rejection handler so the new child's readyPromise (recreated
    // inside start()) doesn't surface as unhandled if the test ends quickly.
    await vi.advanceTimersByTimeAsync(2_001);
    lifecycle.waitForReady().catch(() => undefined);
    expect(callbacks.log.onBeforeRestartCalls).toBe(1);
    expect(lifecycle.child).toBe(newChild);
  });

  it("calls onMaxRestartsReached when three crashes occur within the window", async () => {
    const { lifecycle, callbacks } = makeLifecycle();
    lifecycle.start();
    lifecycle.markReady();

    // Crash 1 — restart scheduled
    mockChild.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(1);
    expect(callbacks.log.onMaxRestartsCalls).toHaveLength(0);

    // Fire restart timer with new child
    const child2 = createMockChild();
    shared.forkMock.mockReturnValueOnce(child2);
    await vi.advanceTimersByTimeAsync(4_001);
    lifecycle.waitForReady().catch(() => undefined);
    // Don't markReady — these are rapid crashes before the host ever stabilizes

    // Crash 2 — still under threshold
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(2);
    expect(callbacks.log.onMaxRestartsCalls).toHaveLength(0);

    // Fire restart timer with another child
    const child3 = createMockChild();
    shared.forkMock.mockReturnValueOnce(child3);
    await vi.advanceTimersByTimeAsync(8_001);
    lifecycle.waitForReady().catch(() => undefined);

    // Crash 3 — threshold reached
    child3.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(3);
    expect(callbacks.log.onMaxRestartsCalls).toEqual([1]);
  });

  it("does not trip the cap when crashes are spread beyond the window", async () => {
    const { lifecycle, callbacks } = makeLifecycle();
    lifecycle.start();
    lifecycle.markReady();

    // Crash 1
    mockChild.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(1);

    // Fire the restart timer, then advance well past the 30-minute window.
    const child2 = createMockChild();
    shared.forkMock.mockReturnValueOnce(child2);
    await vi.advanceTimersByTimeAsync(4_001);
    lifecycle.waitForReady().catch(() => undefined);

    // Advance 31 minutes — the first crash timestamp is now outside the window
    await vi.advanceTimersByTimeAsync(31 * 60_000);

    // Crash 2: filter drops the stale timestamp, length becomes 1 again
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(1);
    expect(callbacks.log.onMaxRestartsCalls).toHaveLength(0);
  });

  it("crash window persists through long quiet intervals and decays lazily (regression #8683)", async () => {
    const { lifecycle, callbacks } = makeLifecycle();
    lifecycle.start();
    lifecycle.markReady();

    // Crash 1 within window
    mockChild.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(1);

    // Restart fires, host comes up. The crash entry must survive ready and
    // long quiet intervals — there is no proactive reset timer any more.
    const child2 = createMockChild();
    shared.forkMock.mockReturnValueOnce(child2);
    await vi.advanceTimersByTimeAsync(4_001);
    lifecycle.waitForReady().catch(() => undefined);
    lifecycle.markReady();

    expect(lifecycle.crashTimestamps).toHaveLength(1);

    // 10 minutes of clean running — the prior crash is still within the
    // 30-min window and remains counted.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(lifecycle.crashTimestamps).toHaveLength(1);

    // The next crash accumulates rather than getting a fresh budget.
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(2);
    expect(callbacks.log.onMaxRestartsCalls).toHaveLength(0);
  });

  it("slow flap of 6-minute-cadence crashes trips the cap (regression #8683)", async () => {
    const { lifecycle, callbacks } = makeLifecycle();
    lifecycle.start();
    lifecycle.markReady();

    // Crash 1
    mockChild.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(1);

    // Wait 6 minutes (well past the prior 5-min rapid window), restart, then
    // crash again. Under the old guard the prior timestamp had already
    // expired and the count would not accumulate.
    const child2 = createMockChild();
    shared.forkMock.mockReturnValueOnce(child2);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    lifecycle.waitForReady().catch(() => undefined);
    lifecycle.markReady();

    // Crash 2 — still inside the 30-min window
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(2);
    expect(callbacks.log.onMaxRestartsCalls).toHaveLength(0);

    // Another 6 minutes, then crash 3 — threshold reached.
    const child3 = createMockChild();
    shared.forkMock.mockReturnValueOnce(child3);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    lifecycle.waitForReady().catch(() => undefined);
    lifecycle.markReady();

    child3.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(3);
    expect(callbacks.log.onMaxRestartsCalls).toEqual([1]);
  });

  it("manualRestart no-ops when child is still alive", () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.start();
    expect(lifecycle.child).not.toBeNull();

    const beforeRestartChild = lifecycle.child;
    lifecycle.manualRestart();
    expect(lifecycle.child).toBe(beforeRestartChild);
    expect(shared.forkMock).toHaveBeenCalledTimes(1);
  });

  it("manualRestart spawns a fresh host once the prior child has exited", async () => {
    const { lifecycle, callbacks } = makeLifecycle();
    lifecycle.start();
    lifecycle.markReady();

    // Crash
    mockChild.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.child).toBeNull();

    // manualRestart now valid
    const child2 = createMockChild();
    shared.forkMock.mockReturnValueOnce(child2);
    lifecycle.manualRestart();
    lifecycle.waitForReady().catch(() => undefined);

    expect(lifecycle.child).toBe(child2);
    expect(lifecycle.crashTimestamps).toHaveLength(0);
    // Auto-restart's onBeforeRestart fired once when the timer was scheduled,
    // and manualRestart fires it again — but the auto-restart timer is a
    // pending setTimeout that hasn't fired yet, so only manualRestart
    // contributes here.
    expect(callbacks.log.onBeforeRestartCalls).toBe(1);
  });

  it("manualRestart clears the crash window so a fresh budget is given", async () => {
    const { lifecycle, callbacks } = makeLifecycle();
    lifecycle.start();
    lifecycle.markReady();

    // Two rapid crashes — one short of the threshold. After the second crash
    // the child is null and a restart is scheduled; manualRestart cancels the
    // pending auto-restart and clears the window.
    mockChild.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    const child2 = createMockChild();
    shared.forkMock.mockReturnValueOnce(child2);
    await vi.advanceTimersByTimeAsync(4_001);
    lifecycle.waitForReady().catch(() => undefined);
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.crashTimestamps).toHaveLength(2);
    expect(lifecycle.child).toBeNull();

    // User intervenes with a manual restart before the auto-restart timer
    // fires — clears the window and the pending restart.
    const child3 = createMockChild();
    shared.forkMock.mockReturnValueOnce(child3);
    lifecycle.manualRestart();
    lifecycle.waitForReady().catch(() => undefined);

    expect(lifecycle.crashTimestamps).toHaveLength(0);
    expect(lifecycle.restartTimer).toBeNull();
    // The new host gets a fresh three-crash budget; the prior crashes don't
    // contribute to the next threshold check.
    expect(callbacks.log.onMaxRestartsCalls).toHaveLength(0);
  });

  it("dispose removes the child-process-gone listener", () => {
    const { lifecycle } = makeLifecycle();
    expect(shared.appMock.listenerCount("child-process-gone")).toBe(1);
    lifecycle.dispose();
    expect(shared.appMock.listenerCount("child-process-gone")).toBe(0);
  });

  it("postMessage forwards to the child", () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.start();
    lifecycle.postMessage({ type: "health-check" });
    expect(mockChild.postMessage).toHaveBeenCalledWith({ type: "health-check" });
  });

  it("postMessage no-ops when child is null", () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.postMessage({ type: "health-check" });
    expect(mockChild.postMessage).not.toHaveBeenCalled();
  });
});

describe("PtyHostLifecycle timer hygiene", () => {
  let mockChild: MockUtilityProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    shared.appMock.removeAllListeners();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeLifecycle(): {
    lifecycle: PtyHostLifecycle;
    callbacks: ReturnType<typeof createCallbacks>;
  } {
    const callbacks = createCallbacks();
    const lifecycle = new PtyHostLifecycle(
      { memoryLimitMb: 256, electronDir: "/tmp/electron" },
      callbacks.callbacks
    );
    return { lifecycle, callbacks };
  }

  // Replace global.setTimeout with a wrapper that records each returned timer
  // and instruments its `unref` method. Returns a teardown that restores the
  // original setTimeout and clears any timers that fired.
  function instrumentSetTimeoutUnref(): {
    unrefSpies: Mock[];
    restore: () => void;
  } {
    const original = global.setTimeout;
    const unrefSpies: Mock[] = [];
    const trackedTimers: NodeJS.Timeout[] = [];
    const wrapped = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = original(handler, ms, ...args);
      trackedTimers.push(timer);
      const originalUnref = timer.unref.bind(timer);
      const unrefSpy = vi.fn(() => originalUnref());
      (timer as unknown as { unref: () => NodeJS.Timeout }).unref = unrefSpy;
      unrefSpies.push(unrefSpy);
      return timer;
    }) as typeof setTimeout;
    Object.assign(wrapped, original);
    global.setTimeout = wrapped;
    return {
      unrefSpies,
      restore: () => {
        global.setTimeout = original;
        for (const t of trackedTimers) clearTimeout(t);
      },
    };
  }

  it("dispose schedules an unref'd force-kill timer", () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.start();

    const { unrefSpies, restore } = instrumentSetTimeoutUnref();
    try {
      lifecycle.dispose();
      // Exactly one setTimeout should have been called (the dispose backstop).
      expect(unrefSpies).toHaveLength(1);
      expect(unrefSpies[0]).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("auto-restart timer is unref'd to avoid pinning the event loop", async () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.start();
    lifecycle.markReady();

    const { unrefSpies, restore } = instrumentSetTimeoutUnref();
    try {
      // Trigger crash → handleExit schedules a setImmediate which then schedules
      // the restart setTimeout. Wait for the macrotask to run.
      mockChild.emit("exit", 1);
      await new Promise<void>((resolve) => setImmediate(resolve));

      // The only setTimeout we expect during this window is the restart timer.
      expect(unrefSpies.length).toBeGreaterThanOrEqual(1);
      expect(unrefSpies[0]).toHaveBeenCalledTimes(1);
      expect(lifecycle.restartTimer).not.toBeNull();
    } finally {
      // Clear the restart timer so the test process exits cleanly.
      if (lifecycle.restartTimer) {
        clearTimeout(lifecycle.restartTimer);
        lifecycle.restartTimer = null;
      }
      restore();
    }
  });

  it("markReady does not schedule any background timer (regression #8683)", () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.start();

    const { unrefSpies, restore } = instrumentSetTimeoutUnref();
    try {
      // markReady() must NOT schedule a stability timer — its absence is the
      // core of #8683. The crash window decays lazily at crash-record-time.
      lifecycle.markReady();
      expect(unrefSpies).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
