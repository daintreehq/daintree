import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { EventEmitter } from "events";
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
});
