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

  it("returns SIGNAL_TERMINATED for codes > 128 (other signals)", () => {
    expect(classifyCrash(140, null)).toBe("SIGNAL_TERMINATED");
  });

  it("returns UNKNOWN_CRASH for non-zero codes ≤128 with no signal", () => {
    expect(classifyCrash(1, null)).toBe("UNKNOWN_CRASH");
    expect(classifyCrash(127, null)).toBe("UNKNOWN_CRASH");
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
    vi.useFakeTimers();
    vi.clearAllMocks();
    shared.appMock.removeAllListeners();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeLifecycle(maxRestarts = 3): {
    lifecycle: PtyHostLifecycle;
    callbacks: ReturnType<typeof createCallbacks>;
  } {
    const callbacks = createCallbacks();
    const lifecycle = new PtyHostLifecycle(
      { maxRestartAttempts: maxRestarts, memoryLimitMb: 256, electronDir: "/tmp/electron" },
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
    expect(lifecycle.restartAttempts).toBe(0);
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
    const { lifecycle, callbacks } = makeLifecycle(3);
    lifecycle.start();
    lifecycle.markReady();
    expect(lifecycle.restartAttempts).toBe(0);

    // First crash: schedules restart attempt 1
    mockChild.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.restartAttempts).toBe(1);

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

  it("calls onMaxRestartsReached when restart cap is hit", async () => {
    const { lifecycle, callbacks } = makeLifecycle(1); // only 1 restart allowed
    lifecycle.start();
    lifecycle.markReady();

    // Crash 1 — restart scheduled
    mockChild.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.restartAttempts).toBe(1);

    // Fire the restart timer
    const child2 = createMockChild();
    shared.forkMock.mockReturnValueOnce(child2);
    await vi.advanceTimersByTimeAsync(4_001);
    lifecycle.waitForReady().catch(() => undefined);

    // Crash 2 — max reached
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);

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
    expect(lifecycle.restartAttempts).toBe(0);
    // Auto-restart's onBeforeRestart fired once when the timer was scheduled,
    // and manualRestart fires it again — but the auto-restart timer is a
    // pending setTimeout that hasn't fired yet, so only manualRestart
    // contributes here.
    expect(callbacks.log.onBeforeRestartCalls).toBe(1);
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
