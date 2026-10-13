import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { EventEmitter } from "events";
import { performance } from "node:perf_hooks";
import type { LogBuffer } from "../LogBuffer.js";

// Mock Electron modules before importing PtyClient
vi.mock("electron", () => ({
  utilityProcess: {
    fork: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
  },
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

import { utilityProcess } from "electron";
import type { PtyClientConfig } from "../PtyClient.js";

interface MockUtilityProcess extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

describe("PtyClient Handshake Protocol", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;
  let forkMock: Mock;
  let logBuffer: LogBuffer;

  beforeEach(async () => {
    // Create mock utility process
    mockChild = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    (utilityProcess.fork as Mock).mockReturnValue(mockChild);

    // Re-import to get fresh module with mocks
    vi.resetModules();
    vi.doMock("electron", () => ({
      utilityProcess: {
        fork: vi.fn().mockReturnValue(mockChild),
      },
      dialog: {
        showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
      },
      app: {
        getPath: vi.fn().mockReturnValue("/mock/user/data"),
        on: vi.fn(),
        off: vi.fn(),
      },
    }));

    const module = await import("../PtyClient.js");
    PtyClientClass = module.PtyClient;
    forkMock = (await import("electron")).utilityProcess.fork as unknown as Mock;
    logBuffer = (await import("../LogBuffer.js")).logBuffer;
    logBuffer.clear();

    // Install after imports: fake timers can stall module re-execution (#11661).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const createClient = (config?: PtyClientConfig) => {
    const client = new PtyClientClass(config);
    // Simulate ready event from host
    mockChild.emit("message", { type: "ready" });
    return client;
  };

  describe("resumeHealthCheck", () => {
    it("should send health-check ping when resuming after pause", () => {
      const client = createClient();

      // Pause and resume
      client.pauseHealthCheck();
      mockChild.postMessage.mockClear();
      client.resumeHealthCheck();

      // Should send health-check immediately for handshake
      expect(mockChild.postMessage).toHaveBeenCalledWith({ type: "health-check" });
    });

    it("should wait for pong before starting interval", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });

      client.pauseHealthCheck();
      mockChild.postMessage.mockClear();
      client.resumeHealthCheck();

      // Clear the initial handshake ping call
      const initialCalls = mockChild.postMessage.mock.calls.length;

      // Advance time but don't send pong - interval should not have started
      vi.advanceTimersByTime(2000);

      // Should NOT have additional health-check calls (interval not started)
      // Only the initial handshake ping should exist
      expect(
        mockChild.postMessage.mock.calls.filter((c) => c[0]?.type === "health-check").length
      ).toBe(initialCalls);
    });

    it("should start interval after receiving pong", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });

      client.pauseHealthCheck();
      mockChild.postMessage.mockClear();
      client.resumeHealthCheck();

      // Send pong response
      mockChild.emit("message", { type: "pong" });

      // Now interval should be running
      vi.advanceTimersByTime(1000);
      expect(mockChild.postMessage).toHaveBeenCalledTimes(2); // handshake + first interval

      vi.advanceTimersByTime(1000);
      expect(mockChild.postMessage).toHaveBeenCalledTimes(3); // + second interval
    });

    it("should fall back to immediate start after 5 second timeout", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });

      client.pauseHealthCheck();
      mockChild.postMessage.mockClear();
      client.resumeHealthCheck();

      // Advance past the 5 second timeout without pong
      vi.advanceTimersByTime(5000);

      // Now interval should be running (fallback)
      vi.advanceTimersByTime(1000);
      expect(
        mockChild.postMessage.mock.calls.filter((c) => c[0]?.type === "health-check").length
      ).toBe(2); // handshake + first interval
    });
  });

  describe("host log forwarding", () => {
    it("should start pty-host with stdio piped", () => {
      createClient();
      expect(forkMock).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({ stdio: "pipe" })
      );
    });

    it("should not include --expose-gc in execArgv", () => {
      createClient();
      expect(forkMock).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({
          execArgv: expect.not.arrayContaining(["--expose-gc"]),
        })
      );
    });

    it("should use configured memoryLimitMb when provided", () => {
      createClient({ memoryLimitMb: 1024 });
      expect(forkMock).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({
          execArgv: expect.arrayContaining(["--max-old-space-size=1024"]),
        })
      );
    });

    it("should pass --diagnostic-dir pointing at the logs path", () => {
      createClient();
      expect(forkMock).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({
          execArgv: expect.arrayContaining(["--diagnostic-dir=/mock/user/data"]),
        })
      );
    });

    it("should forward stdout/stderr lines into the main log buffer", () => {
      createClient();

      mockChild.stdout.emit("data", Buffer.from("hello from host\n"));
      mockChild.stderr.emit("data", Buffer.from("warning from host\n"));

      const messages = logBuffer.getAll().map((e) => e.message);
      expect(messages.some((m) => m.includes("[PtyHost] hello from host"))).toBe(true);
      expect(messages.some((m) => m.includes("[PtyHost] warning from host"))).toBe(true);
    });
  });

  describe("rapid suspend/resume cycles", () => {
    it("should clear handshake timeout on re-pause", () => {
      const client = createClient();

      // First cycle
      client.pauseHealthCheck();
      client.resumeHealthCheck();

      // Re-pause before timeout
      vi.advanceTimersByTime(2000);
      client.pauseHealthCheck();

      // Resume again
      mockChild.postMessage.mockClear();
      client.resumeHealthCheck();

      // Should start fresh handshake
      expect(mockChild.postMessage).toHaveBeenCalledWith({ type: "health-check" });
    });

    it("should handle multiple rapid cycles without timeout accumulation", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });

      // Multiple rapid cycles
      for (let i = 0; i < 5; i++) {
        client.pauseHealthCheck();
        client.resumeHealthCheck();
        vi.advanceTimersByTime(1000); // Partial timeout
      }

      // Should not have multiple timeouts firing
      mockChild.postMessage.mockClear();

      // Send single pong
      mockChild.emit("message", { type: "pong" });

      // Verify interval is running correctly
      vi.advanceTimersByTime(1000);
      expect(mockChild.postMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("IPC data mirror persistence", () => {
    it("re-sends setIpcDataMirror after host restart", () => {
      const client = createClient();

      // Spawn a terminal and enable mirror
      client.spawn("test-terminal", {
        cwd: "/repo",
        cols: 80,
        rows: 30,
        restore: false,
      } as any);
      client.setIpcDataMirror("test-terminal", true);

      mockChild.postMessage.mockClear();

      // Create new mock child for restart
      const newChild = Object.assign(new EventEmitter(), {
        postMessage: vi.fn(),
        kill: vi.fn(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      forkMock.mockReturnValue(newChild);

      // Simulate host crash
      mockChild.emit("exit", 1);

      // Advance past restart delay
      vi.advanceTimersByTime(2000);

      // Simulate new host ready
      newChild.emit("message", { type: "ready" });

      // Should have respawned the terminal AND re-enabled the mirror
      const spawnCalls = newChild.postMessage.mock.calls.filter(
        (c: unknown[]) => (c[0] as any)?.type === "spawn"
      );
      const mirrorCalls = newChild.postMessage.mock.calls.filter(
        (c: unknown[]) => (c[0] as any)?.type === "set-ipc-data-mirror"
      );

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0][0]).toMatchObject({ type: "spawn", id: "test-terminal" });
      expect(mirrorCalls.length).toBe(1);
      expect(mirrorCalls[0][0]).toMatchObject({
        type: "set-ipc-data-mirror",
        id: "test-terminal",
        enabled: true,
      });
    });

    it("keeps a mirror on while any holder still wants it", () => {
      const client = createClient();
      client.spawn("test-terminal", {
        cwd: "/repo",
        cols: 80,
        rows: 30,
        restore: false,
      } as any);
      const mirrorMessages = () =>
        mockChild.postMessage.mock.calls
          .map((c: unknown[]) => c[0] as { type?: string; enabled?: boolean })
          .filter((m) => m.type === "set-ipc-data-mirror")
          .map((m) => m.enabled);
      mockChild.postMessage.mockClear();

      client.setIpcDataMirror("test-terminal", true);
      const release = client.acquireIpcDataMirror("test-terminal");
      release();
      release();
      // A viewer's lease coming and going must not switch off the explicit holder.
      expect(mirrorMessages()).toEqual([true]);

      const viewer = client.acquireIpcDataMirror("test-terminal");
      client.setIpcDataMirror("test-terminal", false);
      expect(mirrorMessages()).toEqual([true]);
      viewer();
      expect(mirrorMessages()).toEqual([true, false]);
    });

    it("never lets a lease from before a kill release one taken since", () => {
      const client = createClient();
      const spawn = () =>
        client.spawn("test-terminal", {
          cwd: "/repo",
          cols: 80,
          rows: 30,
          restore: false,
        } as any);
      spawn();
      const old = client.acquireIpcDataMirror("test-terminal");
      client.kill("test-terminal");
      spawn();
      const current = client.acquireIpcDataMirror("test-terminal");
      mockChild.postMessage.mockClear();
      old();
      const disabled = mockChild.postMessage.mock.calls.filter(
        (c: unknown[]) =>
          (c[0] as { type?: string; enabled?: boolean })?.type === "set-ipc-data-mirror"
      );
      expect(disabled).toEqual([]);
      current();
    });

    it("does not re-send mirror for killed terminals", () => {
      const client = createClient();

      client.spawn("test-terminal", {
        cwd: "/repo",
        cols: 80,
        rows: 30,
        restore: false,
      } as any);
      client.setIpcDataMirror("test-terminal", true);
      client.kill("test-terminal", "test");

      mockChild.postMessage.mockClear();

      const newChild = Object.assign(new EventEmitter(), {
        postMessage: vi.fn(),
        kill: vi.fn(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      forkMock.mockReturnValue(newChild);

      mockChild.emit("exit", 1);
      vi.advanceTimersByTime(2000);
      newChild.emit("message", { type: "ready" });

      const mirrorCalls = newChild.postMessage.mock.calls.filter(
        (c: unknown[]) => (c[0] as any)?.type === "set-ipc-data-mirror"
      );
      expect(mirrorCalls.length).toBe(0);
    });
  });

  describe("resource profile persistence", () => {
    function restartHost(): any {
      const newChild = Object.assign(new EventEmitter(), {
        postMessage: vi.fn(),
        kill: vi.fn(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      forkMock.mockReturnValue(newChild);
      mockChild.emit("exit", 1);
      vi.advanceTimersByTime(2000);
      newChild.emit("message", { type: "ready" });
      return newChild;
    }

    it("replays the last profile and a later explicit poll interval after restart", () => {
      const client = createClient();
      client.setResourceProfile("efficiency");
      client.setProcessTreePollInterval(12_500);
      mockChild.postMessage.mockClear();

      const newChild = restartHost();

      const profileCalls = newChild.postMessage.mock.calls.filter(
        (c: unknown[]) => (c[0] as any)?.type === "set-resource-profile"
      );
      const intervalCalls = newChild.postMessage.mock.calls.filter(
        (c: unknown[]) => (c[0] as any)?.type === "set-process-tree-poll-interval"
      );
      expect(profileCalls.length).toBe(1);
      expect(profileCalls[0][0]).toMatchObject({ profile: "efficiency" });
      expect(intervalCalls.length).toBe(1);
      expect(intervalCalls[0][0]).toMatchObject({ ms: 12_500 });
      // Profile replays first so the explicit interval (the later writer) wins.
      expect(newChild.postMessage.mock.calls.indexOf(profileCalls[0])).toBeLessThan(
        newChild.postMessage.mock.calls.indexOf(intervalCalls[0])
      );
    });

    it("does not replay a poll interval superseded by a later profile", () => {
      const client = createClient();
      client.setProcessTreePollInterval(12_500);
      client.setResourceProfile("efficiency");
      mockChild.postMessage.mockClear();

      const newChild = restartHost();

      const intervalCalls = newChild.postMessage.mock.calls.filter(
        (c: unknown[]) => (c[0] as any)?.type === "set-process-tree-poll-interval"
      );
      expect(intervalCalls.length).toBe(0);
    });

    it("replays nothing when neither was ever set", () => {
      createClient();
      mockChild.postMessage.mockClear();

      const newChild = restartHost();

      const calls = newChild.postMessage.mock.calls.filter((c: unknown[]) =>
        ["set-resource-profile", "set-process-tree-poll-interval"].includes((c[0] as any)?.type)
      );
      expect(calls.length).toBe(0);
    });
  });

  describe("power policy (#12515)", () => {
    function restartHost() {
      const newChild = Object.assign(new EventEmitter(), {
        postMessage: vi.fn(),
        kill: vi.fn(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      forkMock.mockReturnValue(newChild);
      mockChild.emit("exit", 1);
      vi.advanceTimersByTime(2000);
      newChild.emit("message", { type: "ready" });
      return newChild;
    }

    function powerPolicyCalls(child: { postMessage: Mock }): unknown[][] {
      return child.postMessage.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type?: string } | undefined)?.type === "set-power-policy"
      );
    }

    it("sends a level change to the host", () => {
      const client = createClient();
      mockChild.postMessage.mockClear();

      client.setPowerPolicy("deep", "deep");

      expect(mockChild.postMessage).toHaveBeenCalledWith({
        type: "set-power-policy",
        level: "deep",
        observationLevel: "deep",
      });
    });

    it("sends a saving level on the default host's first ready", async () => {
      // The default host's first ready gets no config replay, and on a battery
      // launch the policy is already saving before the host is up.
      const { updatePowerObservations } = await import("../../window/powerPolicy.js");
      updatePowerObservations({ onBattery: true });

      createClient();

      expect(powerPolicyCalls(mockChild)).toEqual([
        // Battery with a focused window: the raw level narrows, and so does
        // observation, because battery still backs agent polling off.
        [{ type: "set-power-policy", level: "saving", observationLevel: "saving" }],
      ]);
    });

    it("replays main's current saving level to a restarted host", async () => {
      const { updatePowerObservations } = await import("../../window/powerPolicy.js");
      createClient();
      updatePowerObservations({ screenLocked: true });

      const newChild = restartHost();

      const calls = powerPolicyCalls(newChild);
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toEqual({
        type: "set-power-policy",
        level: "deep",
        observationLevel: "deep",
      });
    });

    it("replays no level while main is active — a host boots there", () => {
      createClient();

      const newChild = restartHost();

      expect(powerPolicyCalls(newChild)).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("should not resume if not paused", () => {
      const client = createClient();

      mockChild.postMessage.mockClear();
      client.resumeHealthCheck();

      // Should not send handshake if not paused
      expect(mockChild.postMessage).not.toHaveBeenCalledWith({ type: "health-check" });
    });

    it("should handle resume when host not initialized", () => {
      // Create client but don't emit ready
      const client = new PtyClientClass();

      client.pauseHealthCheck();

      // Should warn but not throw
      expect(() => client.resumeHealthCheck()).not.toThrow();
    });

    it("should clean up handshake state on dispose", () => {
      const client = createClient();

      client.pauseHealthCheck();
      client.resumeHealthCheck();

      // Dispose during handshake
      expect(() => client.dispose()).not.toThrow();

      // Advance past timeout - should not throw
      vi.advanceTimersByTime(6000);
    });
  });

  describe("RTT measurement", () => {
    interface RttPrivate {
      healthWatchdog: {
        lastPingTime: number | null;
        rttSamples: number[];
        rttSamplesSinceLastLog: number;
        lastRttLogTime: number;
      };
    }

    let fakeNow: number;
    let nowSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fakeNow = 1_000;
      nowSpy = vi.spyOn(performance, "now").mockImplementation(() => fakeNow);
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      nowSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("records RTT when pong arrives after handshake ping", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });
      const priv = client as unknown as RttPrivate;

      client.pauseHealthCheck();
      fakeNow = 2_000;
      client.resumeHealthCheck();
      expect(priv.healthWatchdog.lastPingTime).toBe(2_000);

      fakeNow = 2_050;
      mockChild.emit("message", { type: "pong" });

      expect(priv.healthWatchdog.rttSamples).toEqual([50]);
      expect(priv.healthWatchdog.lastPingTime).toBeNull();
    });

    it("does not record RTT when lastPingTime is null", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });
      const priv = client as unknown as RttPrivate;

      // Pong arrives without an outstanding ping timestamp
      mockChild.emit("message", { type: "pong" });

      expect(priv.healthWatchdog.rttSamples).toEqual([]);
      expect(priv.healthWatchdog.lastPingTime).toBeNull();
    });

    it("does not record a sample for a late pong after handshake timeout", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });
      const priv = client as unknown as RttPrivate;

      client.pauseHealthCheck();
      client.resumeHealthCheck();
      expect(priv.healthWatchdog.lastPingTime).not.toBeNull();

      // Handshake timeout fires at 5s — clears lastPingTime
      vi.advanceTimersByTime(5000);
      expect(priv.healthWatchdog.lastPingTime).toBeNull();

      mockChild.emit("message", { type: "pong" });
      expect(priv.healthWatchdog.rttSamples).toEqual([]);
    });

    it("logs a summary after 10 samples and resets the counter", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });
      const priv = client as unknown as RttPrivate;
      mockChild.emit("message", { type: "pong" }); // ready handshake — no sample
      logSpy.mockClear();

      for (let i = 0; i < 10; i++) {
        fakeNow = 10_000 + i * 1_000;
        vi.advanceTimersByTime(1000);
        fakeNow += 40; // 40ms RTT
        mockChild.emit("message", { type: "pong" });
      }

      const summaryCalls = logSpy.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).startsWith("[PtyClient] Heartbeat RTT (last ")
      );
      expect(summaryCalls).toHaveLength(1);
      expect(summaryCalls[0][0]).toContain("samples=10");
      expect(priv.healthWatchdog.rttSamplesSinceLastLog).toBe(0);
    });

    it("emits a spike warning when RTT exceeds the threshold", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });
      mockChild.emit("message", { type: "pong" }); // handshake
      warnSpy.mockClear();

      fakeNow = 10_000;
      vi.advanceTimersByTime(1000);
      fakeNow = 16_000; // 6000ms RTT
      mockChild.emit("message", { type: "pong" });

      const spikes = warnSpy.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === "string" && (c[0] as string).includes("Heartbeat RTT spike")
      );
      expect(spikes).toHaveLength(1);
      expect(spikes[0][0]).toContain("6000.0ms");
      void client;
    });

    it("rolls the sample buffer at RTT_BUFFER_SIZE", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });
      const priv = client as unknown as RttPrivate;
      mockChild.emit("message", { type: "pong" }); // handshake

      for (let i = 0; i < 25; i++) {
        fakeNow = 10_000 + i * 1_000;
        vi.advanceTimersByTime(1000);
        fakeNow += i + 1; // distinct RTTs
        mockChild.emit("message", { type: "pong" });
      }

      expect(priv.healthWatchdog.rttSamples).toHaveLength(20);
      // Oldest 5 samples were dropped; first kept sample has RTT = 6
      expect(priv.healthWatchdog.rttSamples[0]).toBe(6);
      expect(priv.healthWatchdog.rttSamples[priv.healthWatchdog.rttSamples.length - 1]).toBe(25);
    });

    it("clears lastPingTime when health check is paused", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });
      const priv = client as unknown as RttPrivate;
      mockChild.emit("message", { type: "pong" }); // handshake

      fakeNow = 5_000;
      vi.advanceTimersByTime(1000);
      expect(priv.healthWatchdog.lastPingTime).not.toBeNull();

      client.pauseHealthCheck();
      expect(priv.healthWatchdog.lastPingTime).toBeNull();
    });

    it("clears lastPingTime when the watchdog force-kills the host", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });
      const priv = client as unknown as RttPrivate;
      mockChild.emit("message", { type: "pong" }); // handshake
      // Leave mockChild.pid undefined so process.kill is skipped by the
      // `if (this.child.pid)` guard — the watchdog should still clear state.

      // Advance past MAX_MISSED_HEARTBEATS (3) intervals with no pong.
      // Each interval: missedHeartbeats++ then send. After 3 unanswered
      // cycles the watchdog path fires on the next tick.
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(1000);
      }

      expect(priv.healthWatchdog.lastPingTime).toBeNull();
      void client;
    });
  });
});

/**
 * #8827: the app boot path constructs PtyClient with `deferStart: true` so the
 * PTY host fork no longer blocks the first renderer load. The fork is triggered
 * later by `start()`, after the early PATH refresh resolves. These tests pin
 * that contract: deferStart skips the constructor fork, `start()` forks exactly
 * once, and the default (non-deferred) path keeps forking in the constructor.
 */
describe("PtyClient deferStart", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;
  let forkMock: Mock;

  beforeEach(async () => {
    mockChild = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    (utilityProcess.fork as Mock).mockReturnValue(mockChild);

    vi.resetModules();
    vi.doMock("electron", () => ({
      utilityProcess: {
        fork: vi.fn().mockReturnValue(mockChild),
      },
      dialog: {
        showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
      },
      app: {
        getPath: vi.fn().mockReturnValue("/mock/user/data"),
        on: vi.fn(),
        off: vi.fn(),
      },
    }));

    const module = await import("../PtyClient.js");
    PtyClientClass = module.PtyClient;
    forkMock = (await import("electron")).utilityProcess.fork as unknown as Mock;

    // Install after imports: fake timers can stall module re-execution (#11661).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not fork the host in the constructor when deferStart is true", () => {
    const client = new PtyClientClass({ deferStart: true });

    expect(forkMock).not.toHaveBeenCalled();
    expect(client.isHostStarted()).toBe(false);

    client.dispose();
  });

  it("forks the host exactly once when start() is called after a deferred construction", () => {
    const client = new PtyClientClass({ deferStart: true });
    expect(forkMock).not.toHaveBeenCalled();

    client.start();

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(client.isHostStarted()).toBe(true);

    client.dispose();
  });

  it("treats a second start() call as a no-op (idempotent)", () => {
    const client = new PtyClientClass({ deferStart: true });

    client.start();
    client.start();
    client.start();

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(client.isHostStarted()).toBe(true);

    client.dispose();
  });

  it("forks in the constructor when deferStart is unset (default behavior)", () => {
    const client = new PtyClientClass();

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(client.isHostStarted()).toBe(true);

    client.dispose();
  });

  it("replays a spawn requested before the deferred host was ready", () => {
    const client = new PtyClientClass({ deferStart: true });

    // Spawn while the host has not forked yet — the send() is dropped (no child).
    client.spawn("t1", { cwd: "/tmp", cols: 80, rows: 30 });
    expect(mockChild.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "spawn", id: "t1" })
    );

    // Fork the host, then signal ready — the queued spawn must be replayed.
    client.start();
    mockChild.emit("message", { type: "ready" });

    expect(mockChild.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "spawn", id: "t1" })
    );

    client.dispose();
  });

  it("queues a MessagePort requested before start() and flushes it on ready", () => {
    const client = new PtyClientClass({ deferStart: true });
    const port = { close: vi.fn(), postMessage: vi.fn(), start: vi.fn() };

    // No host child yet — the port is queued rather than forwarded.
    client.connectMessagePort(7, port as never);
    expect(mockChild.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "connect-port", windowId: 7 }),
      expect.anything()
    );

    client.start();
    mockChild.emit("message", { type: "ready" });

    expect(mockChild.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connect-port", windowId: 7 }),
      [port]
    );

    client.dispose();
  });

  it("replays a resource profile set before the deferred host was ready", () => {
    const client = new PtyClientClass({ deferStart: true });

    // ResourceProfileService's startup push can land before the host exists.
    client.setResourceProfile("efficiency");
    client.setProcessTreePollInterval(25_000);

    client.start();
    mockChild.emit("message", { type: "ready" });

    const sent = mockChild.postMessage.mock.calls.map((c: unknown[]) => c[0] as { type: string });
    const profileIndex = sent.findIndex((m) => m.type === "set-resource-profile");
    const intervalIndex = sent.findIndex((m) => m.type === "set-process-tree-poll-interval");
    expect(sent[profileIndex]).toMatchObject({ profile: "efficiency" });
    expect(sent[intervalIndex]).toMatchObject({ ms: 25_000 });
    expect(profileIndex).toBeLessThan(intervalIndex);

    client.dispose();
  });

  it("replays a resource profile posted between fork and the host's first ready", () => {
    const client = new PtyClientClass();
    // Posted before the host's listener exists — the real host drops it.
    client.setResourceProfile("efficiency");
    mockChild.postMessage.mockClear();

    mockChild.emit("message", { type: "ready" });

    expect(mockChild.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "set-resource-profile", profile: "efficiency" })
    );

    client.dispose();
  });
});

describe("PtyClient projectId assignment", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;

  beforeEach(async () => {
    mockChild = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    (utilityProcess.fork as Mock).mockReturnValue(mockChild);

    vi.resetModules();
    vi.doMock("electron", () => ({
      utilityProcess: {
        fork: vi.fn().mockReturnValue(mockChild),
      },
      dialog: {
        showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
      },
      app: {
        getPath: vi.fn().mockReturnValue("/mock/user/data"),
        on: vi.fn(),
        off: vi.fn(),
      },
    }));

    const module = await import("../PtyClient.js");
    PtyClientClass = module.PtyClient;

    // Install after imports: fake timers can stall module re-execution (#11661).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const createClient = () => {
    const client = new PtyClientClass();
    mockChild.emit("message", { type: "ready" });
    return client;
  };

  describe("getLiveWorkspaceIds (#12320)", () => {
    /**
     * The open-window manifest needs this because a project's agents outlive
     * its renderer: LRU eviction destroys the view and leaves the PTYs
     * running, so a manifest built from views alone drops exactly the
     * long-running projects a relaunch most needs to bring back.
     */
    it("reports every workspace that owns a tracked terminal, deduplicated", () => {
      const client = createClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t2", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t3", { cwd: "/b", cols: 80, rows: 24, projectId: "project-b" });

      expect(client.getLiveWorkspaceIds()).toEqual(new Set(["project-a", "project-b"]));
    });

    it("keeps a workspace while any of its terminals survives", () => {
      const client = createClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t2", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });

      mockChild.emit("message", { type: "exit", id: "t1", exitCode: 0 });

      expect(client.getLiveWorkspaceIds().has("project-a")).toBe(true);
    });

    it("drops a workspace once its last terminal exits", () => {
      const client = createClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      mockChild.emit("message", { type: "exit", id: "t1", exitCode: 0 });

      expect(client.getLiveWorkspaceIds().has("project-a")).toBe(false);
    });

    it("contributes nothing for a terminal with no owning workspace", () => {
      const client = createClient();
      client.spawn("t1", { cwd: "/tmp", cols: 80, rows: 24 });

      expect(client.getLiveWorkspaceIds()).toEqual(new Set());
    });

    it("answers without sending anything to the host", () => {
      // The manifest is written from the shutdown chain's synchronous prefix,
      // where an async round trip has no chance to answer before the process
      // ends.
      const client = createClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      mockChild.postMessage.mockClear();

      client.getLiveWorkspaceIds();

      expect(mockChild.postMessage).not.toHaveBeenCalled();
    });
  });

  it("defaults spawn() projectId to activeProjectId when omitted", () => {
    const client = createClient();
    client.setActiveProject(1, "project-a");
    mockChild.postMessage.mockClear();

    client.spawn("t1", {
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });

    expect(mockChild.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "spawn",
        id: "t1",
        options: expect.objectContaining({ projectId: "project-a" }),
      })
    );
  });

  it("does not override an explicit spawn() projectId", () => {
    const client = createClient();
    client.setActiveProject(1, "project-a");
    mockChild.postMessage.mockClear();

    client.spawn("t2", {
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      projectId: "explicit-project",
    });

    expect(mockChild.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "spawn",
        id: "t2",
        options: expect.objectContaining({ projectId: "explicit-project" }),
      })
    );
  });

  it("treats blank projectId as missing and falls back to activeProjectId", () => {
    const client = createClient();
    client.setActiveProject(1, "project-a");
    mockChild.postMessage.mockClear();

    client.spawn("t3", {
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      projectId: "  ",
    });

    expect(mockChild.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "spawn",
        id: "t3",
        options: expect.objectContaining({ projectId: "project-a" }),
      })
    );
  });
});

function createMockPort() {
  return {
    close: vi.fn(),
    start: vi.fn(),
    on: vi.fn(),
    postMessage: vi.fn(),
  };
}

describe("PtyClient multi-port support", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;
  let forkMock: Mock;

  beforeEach(async () => {
    mockChild = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    vi.resetModules();
    vi.doMock("electron", () => ({
      utilityProcess: {
        fork: vi.fn().mockReturnValue(mockChild),
      },
      dialog: {
        showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
      },
      app: {
        getPath: vi.fn().mockReturnValue("/mock/user/data"),
        on: vi.fn(),
        off: vi.fn(),
      },
    }));

    const module = await import("../PtyClient.js");
    PtyClientClass = module.PtyClient;
    forkMock = (await import("electron")).utilityProcess.fork as unknown as Mock;

    // Install after imports: fake timers can stall module re-execution (#11661).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const createClient = () => {
    const client = new PtyClientClass();
    mockChild.emit("message", { type: "ready" });
    return client;
  };

  it("connects multiple windows independently", () => {
    const client = createClient();
    mockChild.postMessage.mockClear();

    const port1 = createMockPort();
    const port2 = createMockPort();

    client.connectMessagePort(1, port1 as unknown as import("electron").MessagePortMain);
    client.connectMessagePort(2, port2 as unknown as import("electron").MessagePortMain);

    expect(mockChild.postMessage).toHaveBeenCalledTimes(2);
    expect(mockChild.postMessage).toHaveBeenCalledWith({ type: "connect-port", windowId: 1 }, [
      port1,
    ]);
    expect(mockChild.postMessage).toHaveBeenCalledWith({ type: "connect-port", windowId: 2 }, [
      port2,
    ]);
  });

  it("sends windowId with set-active-project", () => {
    const client = createClient();
    mockChild.postMessage.mockClear();

    client.setActiveProject(1, "project-a");

    expect(mockChild.postMessage).toHaveBeenCalledWith({
      type: "set-active-project",
      windowId: 1,
      projectId: "project-a",
    });
  });

  it("includes projectPath with set-active-project when provided", () => {
    const client = createClient();
    mockChild.postMessage.mockClear();

    client.setActiveProject(1, "project-a", "/projects/a");

    expect(mockChild.postMessage).toHaveBeenCalledWith({
      type: "set-active-project",
      windowId: 1,
      projectId: "project-a",
      projectPath: "/projects/a",
    });
  });

  it("sends windowId with project-switch", () => {
    const client = createClient();
    mockChild.postMessage.mockClear();

    client.onProjectSwitch(1, "project-b");

    expect(mockChild.postMessage).toHaveBeenCalledWith({
      type: "project-switch",
      windowId: 1,
      projectId: "project-b",
    });
  });

  it("includes projectPath with project-switch when provided", () => {
    const client = createClient();
    mockChild.postMessage.mockClear();

    client.onProjectSwitch(1, "project-b", "/projects/b");

    expect(mockChild.postMessage).toHaveBeenCalledWith({
      type: "project-switch",
      windowId: 1,
      projectId: "project-b",
      projectPath: "/projects/b",
    });
  });

  it("sends disconnect-port message", () => {
    const client = createClient();
    mockChild.postMessage.mockClear();

    client.disconnectMessagePort(1);

    expect(mockChild.postMessage).toHaveBeenCalledWith({
      type: "disconnect-port",
      windowId: 1,
    });
  });

  it("replays per-window project contexts after host restart", () => {
    const client = createClient();
    client.setActiveProject(1, "project-a", "/projects/a");
    client.onProjectSwitch(2, "project-b", "/projects/b");

    // Simulate host crash and restart
    const newChild = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    forkMock.mockReturnValue(newChild);

    // Install port refresh callback (normally done in windowServices.ts)
    client.setPortRefreshCallback(() => {
      // In production this recreates ports for all windows
    });

    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(2000);

    // New host becomes ready
    newChild.emit("message", { type: "ready" });

    // Should replay both windows' project contexts
    const setActiveCalls = newChild.postMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "set-active-project"
    );
    const switchCalls = newChild.postMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "project-switch"
    );

    expect(setActiveCalls.length).toBe(1);
    expect(setActiveCalls[0][0]).toMatchObject({
      type: "set-active-project",
      windowId: 1,
      projectId: "project-a",
      projectPath: "/projects/a",
    });
    expect(switchCalls.length).toBe(1);
    expect(switchCalls[0][0]).toMatchObject({
      type: "project-switch",
      windowId: 2,
      projectId: "project-b",
      projectPath: "/projects/b",
    });
  });

  it("disconnectMessagePort clears window project context", () => {
    const client = createClient();
    client.setActiveProject(1, "project-a");
    client.onProjectSwitch(2, "project-b");

    // Disconnect window 1
    client.disconnectMessagePort(1);

    // Simulate host crash and restart
    const newChild = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    forkMock.mockReturnValue(newChild);
    client.setPortRefreshCallback(() => {});

    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(2000);
    newChild.emit("message", { type: "ready" });

    // Should only replay window 2's context, not window 1
    const setActiveCalls = newChild.postMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "set-active-project"
    );
    const switchCalls = newChild.postMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "project-switch"
    );

    expect(setActiveCalls.length).toBe(0);
    expect(switchCalls.length).toBe(1);
    expect(switchCalls[0][0]).toMatchObject({
      type: "project-switch",
      windowId: 2,
      projectId: "project-b",
    });
  });
});

interface MockUtilityProcessWithPid extends EventEmitter {
  pid: number | undefined;
  postMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

describe("PtyClient.getHostPidForWindow", () => {
  let mockChild: MockUtilityProcessWithPid;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;

  beforeEach(async () => {
    mockChild = Object.assign(new EventEmitter(), {
      pid: 4242 as number | undefined,
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    vi.resetModules();
    vi.doMock("electron", () => ({
      utilityProcess: { fork: vi.fn().mockReturnValue(mockChild) },
      dialog: { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) },
      app: {
        getPath: vi.fn().mockReturnValue("/mock/user/data"),
        on: vi.fn(),
        off: vi.fn(),
      },
    }));

    PtyClientClass = (await import("../PtyClient.js")).PtyClient;
    // Install after imports: fake timers can stall module re-execution (#11661).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns null before the host is forked", () => {
    const client = new PtyClientClass({ deferStart: true });
    expect(client.getHostPidForWindow(1)).toBeNull();
    client.dispose();
  });

  it("returns the forked host's pid for any window on the default shard", () => {
    const client = new PtyClientClass({ deferStart: true });
    client.start();
    expect(client.getHostPidForWindow(1)).toBe(4242);
    expect(client.getHostPidForWindow(99)).toBe(4242);
    client.dispose();
  });

  it("returns null when the forked process has no pid yet", () => {
    mockChild.pid = undefined;
    const client = new PtyClientClass({ deferStart: true });
    client.start();
    expect(client.getHostPidForWindow(1)).toBeNull();
    client.dispose();
  });

  it("returns null once the host has exited", () => {
    const client = new PtyClientClass({ deferStart: true });
    client.start();
    mockChild.emit("exit", 1);
    expect(client.getHostPidForWindow(1)).toBeNull();
    client.dispose();
  });
});
