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
    vi.useFakeTimers();

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

    it("should ignore late pong after timeout", () => {
      const client = createClient({ healthCheckIntervalMs: 1000 });

      client.pauseHealthCheck();
      mockChild.postMessage.mockClear();
      client.resumeHealthCheck();

      // Advance past timeout
      vi.advanceTimersByTime(5000);

      // Late pong should not cause issues (interval already started)
      expect(() => mockChild.emit("message", { type: "pong" })).not.toThrow();

      // Interval should still be running normally
      vi.advanceTimersByTime(1000);
      expect(
        mockChild.postMessage.mock.calls.filter((c) => c[0]?.type === "health-check").length
      ).toBeGreaterThanOrEqual(2);
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

    it("should start pty-host with 512MB memory limit by default", () => {
      createClient();
      expect(forkMock).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({
          execArgv: expect.arrayContaining(["--max-old-space-size=512"]),
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
