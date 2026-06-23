/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { createHash } from "crypto";
import { Readable } from "node:stream";

function serviceNameFor(projectPath: string): string {
  const safeName = projectPath
    .split("/")
    .pop()!
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 40);
  const pathHash = createHash("sha1").update(projectPath).digest("hex").slice(0, 8);
  return `daintree-workspace-host:${safeName}-${pathHash}`;
}

const { forkMock, mockChildren, loggerCalls, appMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const forkMock = vi.fn();
  const mockChildren: any[] = [];
  const loggerCalls: { level: "info" | "warn"; message: string }[] = [];
  const appEmitter = new EventEmitter();
  const appMock = Object.assign(appEmitter, {
    getPath: vi.fn(() => "/tmp/userData"),
  });
  return { forkMock, mockChildren, loggerCalls, appMock };
});

class MockUtilityChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  postMessage = vi.fn();
  kill = vi.fn(() => true);
  pid = 42;

  constructor() {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    mockChildren.push(this);
  }
}

vi.mock("electron", () => ({
  utilityProcess: {
    fork: forkMock,
  },
  app: appMock,
  UtilityProcess: class {},
  MessagePortMain: class {},
}));

vi.mock("../github/GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => null),
  },
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: (name: string) => ({
    name,
    debug: vi.fn(),
    info: (message: string) => loggerCalls.push({ level: "info", message }),
    warn: (message: string) => loggerCalls.push({ level: "warn", message }),
    error: vi.fn(),
  }),
}));

async function loadModule(): Promise<typeof import("../WorkspaceHostProcess.js")> {
  return await import("../WorkspaceHostProcess.js");
}

describe("WorkspaceHostProcess", () => {
  beforeEach(() => {
    vi.resetModules();
    forkMock.mockReset();
    mockChildren.length = 0;
    loggerCalls.length = 0;
    appMock.removeAllListeners();
    forkMock.mockImplementation(() => new MockUtilityChild());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forks the utility process with stdio:"pipe" to isolate from main process\'s fd 2 (regression guard for #5588)', async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    expect(forkMock).toHaveBeenCalledTimes(1);
    const options = forkMock.mock.calls[0][2];
    expect(options.stdio).toBe("pipe");

    host.dispose();
  });

  it("forks with a V8 heap cap without dropping the diagnostic execArgv flags", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const execArgv: string[] = forkMock.mock.calls[0][2].execArgv;
    const heapCapArg = execArgv.find((arg) => /^--max-old-space-size=\d+$/.test(arg));
    expect(heapCapArg).toBeDefined();
    // The cap must stay at or above the OOM-mitigation floor (#10729) — 256 MB
    // was too tight for large multi-worktree projects and let the host OOM-loop.
    const heapCapMb = Number(heapCapArg!.split("=")[1]);
    expect(heapCapMb).toBeGreaterThanOrEqual(512);
    expect(execArgv.some((arg) => arg.startsWith("--diagnostic-dir="))).toBe(true);
    expect(execArgv).toContain("--report-exclude-env");

    host.dispose();
  });

  it("forwards stdout lines via logger.info with [WorkspaceHost] prefix", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.stdout.emit("data", Buffer.from("hello world\n"));

    const infoMessages = loggerCalls.filter((c) => c.level === "info").map((c) => c.message);
    expect(infoMessages).toContain("[WorkspaceHost] hello world");

    host.dispose();
  });

  it("forwards stderr lines via logger.warn", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.stderr.emit("data", Buffer.from("boom!\n"));

    const warnMessages = loggerCalls.filter((c) => c.level === "warn").map((c) => c.message);
    expect(warnMessages).toContain("[WorkspaceHost] boom!");

    host.dispose();
  });

  it("reassembles lines split across chunks and only emits once complete", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.stdout.emit("data", Buffer.from("partial"));
    const afterFirstChunk = loggerCalls.filter((c) =>
      c.message.startsWith("[WorkspaceHost]")
    ).length;
    expect(afterFirstChunk).toBe(0);

    child.stdout.emit("data", Buffer.from(" line\n"));
    const infoMessages = loggerCalls.filter((c) => c.level === "info").map((c) => c.message);
    expect(infoMessages).toContain("[WorkspaceHost] partial line");

    host.dispose();
  });

  it("flushes partial (unterminated) line buffer on host exit", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.stderr.emit("data", Buffer.from("partial crash trace"));

    const beforeExit = loggerCalls.filter((c) => c.message.startsWith("[WorkspaceHost]")).length;
    expect(beforeExit).toBe(0);

    child.emit("exit", 137);
    const warnMessages = loggerCalls.filter((c) => c.level === "warn").map((c) => c.message);
    expect(warnMessages).toContain("[WorkspaceHost] partial crash trace");

    host.dispose();
  });

  it("does not throw when Readable streams emit 'error' events (post-exit pipe I/O)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    // Without an "error" listener Node would throw; we've added a silencer.
    expect(() => child.stdout.emit("error", new Error("pipe gone"))).not.toThrow();
    expect(() => child.stderr.emit("error", new Error("pipe gone"))).not.toThrow();

    host.dispose();
  });

  it("routes inotify-limit-reached as host-event (spontaneous event)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const onHostEvent = vi.fn();
    host.on("host-event", onHostEvent);

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "inotify-limit-reached" });

    expect(onHostEvent).toHaveBeenCalledWith({ type: "inotify-limit-reached" });

    host.dispose();
  });

  it("routes emfile-limit-reached as host-event (spontaneous event)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const onHostEvent = vi.fn();
    host.on("host-event", onHostEvent);

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "emfile-limit-reached" });

    expect(onHostEvent).toHaveBeenCalledWith({ type: "emfile-limit-reached" });

    host.dispose();
  });

  it("routes watcher-recovered as host-event (spontaneous event)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const onHostEvent = vi.fn();
    host.on("host-event", onHostEvent);

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "watcher-recovered" });

    expect(onHostEvent).toHaveBeenCalledWith({ type: "watcher-recovered" });

    host.dispose();
  });
});

// ── BrokerError contract tests ──

describe("WorkspaceHostProcess BrokerError contract", () => {
  beforeEach(() => {
    vi.resetModules();
    forkMock.mockReset();
    mockChildren.length = 0;
    loggerCalls.length = 0;
    appMock.removeAllListeners();
    forkMock.mockImplementation(() => new MockUtilityChild());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sendWithResponse rejects with APP_SHUTDOWN when disposed", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});
    host.dispose();

    await expect(
      host.sendWithResponse({ type: "refresh" as any, requestId: "r1" })
    ).rejects.toMatchObject({
      code: "APP_SHUTDOWN",
      message: "WorkspaceHostProcess disposed",
      projectScopeId: "/tmp/project",
    });
  });

  it("sendWithResponse rejects with HOST_EXITED when child is null", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    // Kill the child so it's null but not disposed
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("exit", 1);

    await expect(
      host.sendWithResponse({ type: "refresh" as any, requestId: "r2" })
    ).rejects.toMatchObject({
      code: "HOST_EXITED",
      projectScopeId: "/tmp/project",
    });

    host.dispose();
  });

  it("duplicate-ID guard rejects old promise and clears old timeout before registering new one", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    // Send the host "ready" so isInitialized is true
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    const firstPromise = host.sendWithResponse({
      type: "refresh" as any,
      requestId: "dup-id",
    });

    // Second call with same ID — the guard rejects the FIRST promise, then
    // registers a new entry for the second one.
    const secondPromise = host.sendWithResponse({
      type: "refresh" as any,
      requestId: "dup-id",
    });

    // The first promise should be rejected with the duplicate error
    await expect(firstPromise).rejects.toThrow("Duplicate request ID: dup-id");

    // The second promise gets a fresh entry; resolve it to clean up
    child.emit("message", { type: "refresh-result", requestId: "dup-id" });
    await secondPromise;

    host.dispose();
  });

  it("timeout rejects with BrokerError TIMEOUT", async () => {
    vi.useFakeTimers();
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    const promise = host.sendWithResponse(
      { type: "refresh" as any, requestId: "timeout-test" },
      5000
    );

    vi.advanceTimersByTime(5000);

    await expect(promise).rejects.toMatchObject({
      code: "TIMEOUT",
      projectScopeId: "/tmp/project",
    });

    host.dispose();
    vi.useRealTimers();
  });

  it("exit handler rejects pending requests with BrokerError HOST_EXITED", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 1,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    const promise = host.sendWithResponse({
      type: "refresh" as any,
      requestId: "exit-test",
    });

    child.emit("exit", 1);

    await expect(promise).rejects.toMatchObject({
      code: "HOST_EXITED",
      message: "Workspace Host crashed",
      projectScopeId: "/tmp/project",
    });

    host.dispose();
  });

  it("pauseHealthCheck clears the health-check interval", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    host.pauseHealthCheck();
    expect((host as any).healthCheckInterval).toBeNull();

    host.dispose();
  });

  it("dispose rejects pending requests with APP_SHUTDOWN BrokerError", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    const promise = host.sendWithResponse({
      type: "refresh" as any,
      requestId: "dispose-test",
    });

    host.dispose();

    await expect(promise).rejects.toMatchObject({
      code: "APP_SHUTDOWN",
      projectScopeId: "/tmp/project",
    });
  });

  it("ready reject carries APP_SHUTDOWN when disposed before ready", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);

    const readyPromise = host.waitForReady();
    host.dispose();

    await expect(readyPromise).rejects.toMatchObject({
      code: "APP_SHUTDOWN",
    });
  });

  it("restart delay has random jitter (full-jitter parity with PtyHostLifecycle)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
    // Mock Math.random to control jitter
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });
    child.emit("exit", 1);

    // After one crash: crashTimestamps.length=1, cap = min(1000*2^1, 10000) = 2000
    // delay = 100 + 0.5 * (2000 - 100) = 100 + 950 = 1050
    const restartSpy = vi.fn();
    host.on("restarted", restartSpy);

    // Flush the setImmediate that defers crash classification
    await vi.advanceTimersByTimeAsync(0);
    // Then advance through the restart delay
    await vi.advanceTimersByTimeAsync(1050);
    expect(restartSpy).toHaveBeenCalledTimes(1);

    // Auto-restart created a new readyPromise; swallow its rejection on dispose
    host.waitForReady().catch(() => {});
    randomSpy.mockRestore();
    host.dispose();
    vi.useRealTimers();
  });

  it("auto-restart does not emit 'restarted' when fork fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    // Cause fork to fail on the next attempt
    forkMock.mockImplementation(() => {
      throw new Error("fork failed");
    });

    const restartSpy = vi.fn();
    const crashSpy = vi.fn();
    host.on("restarted", restartSpy);
    host.on("host-crash", crashSpy);

    child.emit("exit", 1);

    // Flush setImmediate then advance past the restart delay
    await vi.advanceTimersByTimeAsync(0);
    const cap = Math.min(1000 * Math.pow(2, 1), 10000); // 2000
    await vi.advanceTimersByTimeAsync(cap + 100);

    expect(restartSpy).not.toHaveBeenCalled();
    expect(crashSpy).toHaveBeenCalled();

    host.waitForReady().catch(() => {});
    host.dispose();
    vi.useRealTimers();
  });

  it("duplicate-ID guard clears old timeout before overwriting", async () => {
    vi.useFakeTimers();
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    // Register first request with a short timeout (100ms)
    const firstPromise = host.sendWithResponse(
      { type: "refresh" as any, requestId: "timer-test" },
      100
    );

    // Register duplicate — should clear old 100ms timeout
    const secondPromise = host.sendWithResponse(
      { type: "refresh" as any, requestId: "timer-test" },
      10000
    );

    // Advance past the first timeout — if not cleared, it would have rejected
    vi.advanceTimersByTime(150);

    // First promise was already rejected by duplicate guard (synchronous)
    await expect(firstPromise).rejects.toThrow("Duplicate request ID: timer-test");

    // Second promise is still pending (not timed out)
    // Resolve it to clean up
    child.emit("message", { type: "refresh-result", requestId: "timer-test" });
    await secondPromise;

    host.dispose();
    vi.useRealTimers();
  });
});

// ── Sliding-window crash guard (regression #8553) ──

describe("WorkspaceHostProcess crash window", () => {
  beforeEach(() => {
    vi.resetModules();
    forkMock.mockReset();
    mockChildren.length = 0;
    loggerCalls.length = 0;
    appMock.removeAllListeners();
    forkMock.mockImplementation(() => new MockUtilityChild());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ready does NOT reset the crash window (regression #8553)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    // Crash 1
    const child1 = mockChildren[0] as MockUtilityChild;
    child1.emit("message", { type: "ready" });
    child1.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).crashTimestamps).toHaveLength(1);

    // Auto-restart fires
    host.waitForReady().catch(() => {});
    await vi.advanceTimersByTimeAsync(2_001);
    const child2 = mockChildren[1] as MockUtilityChild;

    // New host becomes ready — under the OLD bug, this would reset the
    // crash counter to zero. Under the new sliding-window guard, the
    // history must persist.
    child2.emit("message", { type: "ready" });
    expect((host as any).crashTimestamps).toHaveLength(1);

    host.dispose();
  });

  it("emits host-crash on three crashes within the window (with intervening ready)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const crashSpy = vi.fn();
    host.on("host-crash", crashSpy);

    // Crash 1 — ready then crash
    const child1 = mockChildren[0] as MockUtilityChild;
    child1.emit("message", { type: "ready" });
    child1.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_001);
    expect((host as any).crashTimestamps).toHaveLength(1);
    expect(crashSpy).not.toHaveBeenCalled();

    // Crash 2 — ready then crash again (regression: this used to reset
    // crashTimestamps to zero via the `ready` case)
    const child2 = mockChildren[1] as MockUtilityChild;
    host.waitForReady().catch(() => {});
    child2.emit("message", { type: "ready" });
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_001);
    expect((host as any).crashTimestamps).toHaveLength(2);
    expect(crashSpy).not.toHaveBeenCalled();

    // Crash 3 — threshold reached, no further restart, host-crash emitted
    const child3 = mockChildren[2] as MockUtilityChild;
    host.waitForReady().catch(() => {});
    child3.emit("message", { type: "ready" });
    child3.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).crashTimestamps).toHaveLength(3);
    expect(crashSpy).toHaveBeenCalledWith(1);

    host.dispose();
  });

  it("crash window persists through long quiet intervals (regression #8683)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const child1 = mockChildren[0] as MockUtilityChild;
    child1.emit("message", { type: "ready" });
    child1.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).crashTimestamps).toHaveLength(1);

    // Auto-restart fires and host comes up
    host.waitForReady().catch(() => {});
    await vi.advanceTimersByTimeAsync(2_001);
    const child2 = mockChildren[1] as MockUtilityChild;
    child2.emit("message", { type: "ready" });

    // 10 minutes of clean running — the crash entry must persist (there
    // is no proactive reset timer any more).
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((host as any).crashTimestamps).toHaveLength(1);

    host.dispose();
  });

  it("crashes spread beyond the window decay out", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    // Crash 1
    const child1 = mockChildren[0] as MockUtilityChild;
    child1.emit("message", { type: "ready" });
    child1.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).crashTimestamps).toHaveLength(1);

    // Restart fires; advance well past the 30-min window (31 minutes)
    host.waitForReady().catch(() => {});
    await vi.advanceTimersByTimeAsync(2_001);
    const child2 = mockChildren[1] as MockUtilityChild;
    child2.emit("message", { type: "ready" });
    await vi.advanceTimersByTimeAsync(31 * 60_000);

    // A subsequent crash gets a fresh budget — the lazy filter at
    // crash-record-time drops the stale entry.
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).crashTimestamps).toHaveLength(1);

    host.dispose();
  });

  it("slow flap of 6-minute-cadence crashes trips host-crash (regression #8683)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const crashSpy = vi.fn();
    host.on("host-crash", crashSpy);

    // Crash 1
    const child1 = mockChildren[0] as MockUtilityChild;
    child1.emit("message", { type: "ready" });
    child1.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).crashTimestamps).toHaveLength(1);

    // Wait 6 minutes (just outside the prior 5-min rapid window), then crash
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    const child2 = mockChildren[1] as MockUtilityChild;
    host.waitForReady().catch(() => {});
    child2.emit("message", { type: "ready" });
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).crashTimestamps).toHaveLength(2);
    expect(crashSpy).not.toHaveBeenCalled();

    // Another 6 minutes, then crash 3 — threshold reached
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    const child3 = mockChildren[2] as MockUtilityChild;
    host.waitForReady().catch(() => {});
    child3.emit("message", { type: "ready" });
    child3.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).crashTimestamps).toHaveLength(3);
    expect(crashSpy).toHaveBeenCalledWith(1);

    host.dispose();
  });

  it("slow OOM loop trips host-crash even when the burst window never holds 3 crashes (#10729)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const crashSpy = vi.fn();
    host.on("host-crash", crashSpy);

    // Crash 1 at t=0
    const child1 = mockChildren[0] as MockUtilityChild;
    child1.emit("message", { type: "ready" });
    child1.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);

    // Crash 2 at t=12min (gap 12min < 20min interval → consecutive short #1)
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    const child2 = mockChildren[1] as MockUtilityChild;
    host.waitForReady().catch(() => {});
    child2.emit("message", { type: "ready" });
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(crashSpy).not.toHaveBeenCalled();

    // Crash 3 at t=30min (gap 18min < 20min → consecutive short #2 → trips).
    // The burst window has decayed crash 1 out (30min ≥ 30min window) so it
    // holds only 2 timestamps and would NOT trip — the interval detector does.
    await vi.advanceTimersByTimeAsync(18 * 60_000);
    const child3 = mockChildren[2] as MockUtilityChild;
    host.waitForReady().catch(() => {});
    child3.emit("message", { type: "ready" });
    child3.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);

    expect((host as any).crashTimestamps).toHaveLength(2); // burst guard alone would not trip
    expect((host as any).consecutiveShortCrashIntervals).toBeGreaterThanOrEqual(2);
    expect(crashSpy).toHaveBeenCalledWith(1);

    host.dispose();
  });

  it("a long gap between crashes resets the slow-OOM interval counter", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const crashSpy = vi.fn();
    host.on("host-crash", crashSpy);

    // Crash 1 at t=0
    const child1 = mockChildren[0] as MockUtilityChild;
    child1.emit("message", { type: "ready" });
    child1.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);

    // Crash 2 at t=12min (gap 12min < 20min → counter goes to 1)
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    const child2 = mockChildren[1] as MockUtilityChild;
    host.waitForReady().catch(() => {});
    child2.emit("message", { type: "ready" });
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).consecutiveShortCrashIntervals).toBe(1);

    // Crash 3 at t=37min (gap 25min > 20min → counter resets to 0, no trip)
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    const child3 = mockChildren[2] as MockUtilityChild;
    host.waitForReady().catch(() => {});
    child3.emit("message", { type: "ready" });
    child3.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);

    expect((host as any).consecutiveShortCrashIntervals).toBe(0);
    expect(crashSpy).not.toHaveBeenCalled();

    host.dispose();
  });

  it("ready does NOT reset the slow-OOM interval state", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    // Crash 1 at t=0
    const child1 = mockChildren[0] as MockUtilityChild;
    child1.emit("message", { type: "ready" });
    child1.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);

    // Crash 2 at t=6min (gap 6min < 20min → counter goes to 1)
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    const child2 = mockChildren[1] as MockUtilityChild;
    host.waitForReady().catch(() => {});
    child2.emit("message", { type: "ready" });
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).consecutiveShortCrashIntervals).toBe(1);

    // Restart comes up clean — `ready` must NOT wipe the interval state, or a
    // crash-ready-crash-ready loop would never accumulate (mirrors #8553).
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    const child3 = mockChildren[2] as MockUtilityChild;
    child3.emit("message", { type: "ready" });

    expect((host as any).consecutiveShortCrashIntervals).toBe(1);
    expect((host as any).previousCrashAt).not.toBeNull();

    host.dispose();
  });

  it("manualRestart clears the slow-OOM interval state", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    // Two short-interval crashes → counter at 1, child null (restart pending)
    const child1 = mockChildren[0] as MockUtilityChild;
    child1.emit("message", { type: "ready" });
    child1.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_001);
    const child2 = mockChildren[1] as MockUtilityChild;
    host.waitForReady().catch(() => {});
    child2.emit("message", { type: "ready" });
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).consecutiveShortCrashIntervals).toBe(1);
    expect((host as any).child).toBeNull();

    host.manualRestart();
    expect((host as any).consecutiveShortCrashIntervals).toBe(0);
    expect((host as any).previousCrashAt).toBeNull();

    host.dispose();
  });

  it("manualRestart clears the crash window so a fresh budget is given", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    // Two rapid crashes — short of the threshold
    const child1 = mockChildren[0] as MockUtilityChild;
    child1.emit("message", { type: "ready" });
    child1.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_001);
    const child2 = mockChildren[1] as MockUtilityChild;
    host.waitForReady().catch(() => {});
    child2.emit("message", { type: "ready" });
    child2.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect((host as any).crashTimestamps).toHaveLength(2);
    expect((host as any).child).toBeNull();

    // User intervenes with manualRestart — clears window + pending stability timer
    host.manualRestart();
    host.waitForReady().catch(() => {});
    expect((host as any).crashTimestamps).toHaveLength(0);
    expect((host as any).restartTimer).toBeNull();

    host.dispose();
  });

  it("child-process-gone with matching serviceName captures reason", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    // Simulate Electron 37-41 race: child-process-gone arrives BEFORE exit
    appMock.emit(
      "child-process-gone",
      {} as Electron.Event,
      {
        type: "Utility",
        name: serviceNameFor("/tmp/project"),
        reason: "oom",
        exitCode: 137,
      } as Electron.Details
    );

    // The handler should have captured the reason
    expect((host as any).pendingChildProcessGoneReason).toEqual({
      reason: "oom",
      exitCode: 137,
    });

    const crashSpy = vi.fn();
    host.on("host-crash", crashSpy);

    // To trigger host-crash on first exit, fill the crash window
    (host as any).crashTimestamps = [Date.now() - 1000, Date.now() - 500];

    child.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);

    // host-crash uses the authoritative exitCode 137, not the exit event's 1
    expect(crashSpy).toHaveBeenCalledWith(137);

    host.dispose();
  });

  it("uses child-process-gone reason when it arrives AFTER exit (named Electron 37-41 race)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    const crashSpy = vi.fn();
    host.on("host-crash", crashSpy);

    // Pre-fill the crash window so the next crash trips the cap.
    (host as any).crashTimestamps = [Date.now() - 1000, Date.now() - 500];

    // Exit fires first — sync teardown runs, but the deferred restart
    // decision has NOT executed yet (setImmediate is queued).
    child.emit("exit", 1);

    // The authoritative reason arrives between exit and the setImmediate.
    appMock.emit(
      "child-process-gone",
      {} as Electron.Event,
      {
        type: "Utility",
        name: serviceNameFor("/tmp/project"),
        reason: "oom",
        exitCode: 137,
      } as Electron.Details
    );

    // Flush setImmediate — the deferred handler must now consume the
    // late-arriving reason instead of the exit-event's code.
    await vi.advanceTimersByTimeAsync(0);

    expect(crashSpy).toHaveBeenCalledWith(137);

    host.dispose();
  });

  it("child-process-gone with non-matching serviceName is ignored", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    appMock.emit(
      "child-process-gone",
      {} as Electron.Event,
      {
        type: "Utility",
        name: serviceNameFor("/tmp/some-other-project"),
        reason: "oom",
        exitCode: 137,
      } as Electron.Details
    );

    expect((host as any).pendingChildProcessGoneReason).toBeNull();

    host.dispose();
  });

  it("child-process-gone with non-Utility type is ignored", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    appMock.emit(
      "child-process-gone",
      {} as Electron.Event,
      {
        type: "Tab",
        name: serviceNameFor("/tmp/project"),
        reason: "crashed",
        exitCode: 1,
      } as unknown as Electron.Details
    );

    expect((host as any).pendingChildProcessGoneReason).toBeNull();

    host.dispose();
  });

  it("same-basename projects do not cross-attribute crash reasons", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const hostA = new WorkspaceHostProcess("/workspaces/a/api", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    hostA.waitForReady().catch(() => {});
    const hostB = new WorkspaceHostProcess("/workspaces/b/api", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    hostB.waitForReady().catch(() => {});

    // The service names must be distinct despite identical basename.
    expect(serviceNameFor("/workspaces/a/api")).not.toBe(serviceNameFor("/workspaces/b/api"));

    // A gone event for hostA only — hostB must NOT capture it.
    appMock.emit(
      "child-process-gone",
      {} as Electron.Event,
      {
        type: "Utility",
        name: serviceNameFor("/workspaces/a/api"),
        reason: "oom",
        exitCode: 137,
      } as Electron.Details
    );

    expect((hostA as any).pendingChildProcessGoneReason).toEqual({
      reason: "oom",
      exitCode: 137,
    });
    expect((hostB as any).pendingChildProcessGoneReason).toBeNull();

    hostA.dispose();
    hostB.dispose();
  });

  it("does NOT fork a fourth time after the crash threshold is reached", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    // Crash 1 → restart
    mockChildren[0].emit("message", { type: "ready" });
    mockChildren[0].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(forkMock).toHaveBeenCalledTimes(2);

    // Crash 2 → restart
    host.waitForReady().catch(() => {});
    mockChildren[1].emit("message", { type: "ready" });
    mockChildren[1].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(forkMock).toHaveBeenCalledTimes(3);

    // Crash 3 → threshold tripped, NO further fork
    host.waitForReady().catch(() => {});
    mockChildren[2].emit("message", { type: "ready" });
    mockChildren[2].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    // Advance well past any possible restart-delay cap to prove no timer fires.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(forkMock).toHaveBeenCalledTimes(3);

    host.dispose();
  });

  it("dispose removes the child-process-gone listener", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});

    expect(appMock.listenerCount("child-process-gone")).toBe(1);

    host.dispose();

    expect(appMock.listenerCount("child-process-gone")).toBe(0);
  });

  it("each WorkspaceHostProcess instance registers its own listener (isolation across projects)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const hostA = new WorkspaceHostProcess("/tmp/projectA", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    hostA.waitForReady().catch(() => {});
    const hostB = new WorkspaceHostProcess("/tmp/projectB", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    hostB.waitForReady().catch(() => {});

    expect(appMock.listenerCount("child-process-gone")).toBe(2);

    // Emit a gone event matching hostA's serviceName only
    appMock.emit(
      "child-process-gone",
      {} as Electron.Event,
      {
        type: "Utility",
        name: serviceNameFor("/tmp/projectA"),
        reason: "oom",
        exitCode: 137,
      } as Electron.Details
    );

    expect((hostA as any).pendingChildProcessGoneReason).toEqual({
      reason: "oom",
      exitCode: 137,
    });
    // hostB must NOT have captured the reason (cross-instance isolation)
    expect((hostB as any).pendingChildProcessGoneReason).toBeNull();

    hostA.dispose();
    hostB.dispose();
  });
});
