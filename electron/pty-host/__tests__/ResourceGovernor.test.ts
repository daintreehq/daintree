import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Shared mock state that tests can reconfigure
let mockCheckForLeaks: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
let mockFdMonitorSupported: boolean;

vi.mock("../FdMonitor.js", () => {
  return {
    FdMonitor: class {
      get supported() {
        return mockFdMonitorSupported;
      }
      getFdCount = vi.fn().mockReturnValue(10);
      checkForLeaks = (...args: unknown[]) => mockCheckForLeaks(...args);
    },
    isProcessAlive: vi.fn(),
  };
});

vi.mock("../metrics.js", () => ({
  metricsEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("node:v8", () => ({
  default: {
    getHeapStatistics: vi.fn().mockReturnValue({
      heap_size_limit: 1024 * 1024 * 1024,
    }),
  },
}));

import { ResourceGovernor, type ResourceGovernorDeps } from "../ResourceGovernor.js";
import { PtyPauseCoordinator } from "../PtyPauseCoordinator.js";
import { metricsEnabled } from "../metrics.js";

function createMockCoordinator() {
  const raw = { pause: vi.fn(), resume: vi.fn() };
  return { coordinator: new PtyPauseCoordinator(raw), raw };
}

function createMockDeps(overrides?: Partial<ResourceGovernorDeps>): ResourceGovernorDeps {
  return {
    getTerminalIds: vi.fn().mockReturnValue([]),
    getPauseCoordinator: vi.fn().mockReturnValue(undefined),
    getTerminalPids: vi.fn().mockReturnValue([]),
    incrementPauseCount: vi.fn(),
    sendEvent: vi.fn(),
    emitTerminalStatus: vi.fn(),
    getTerminalActivity: vi.fn().mockReturnValue([]),
    trimBuffers: vi.fn(),
    ...overrides,
  };
}

// After the EMA + warmup + trim-first changes, engage requires 6 ticks:
// ticks 1–4 build EMA warmup, tick 5 satisfies warmup and fires the one-shot
// trim attempt, tick 6 escalates to pause. 6 × 2s = 12s.
// Critical pressure (≥95% raw) bypasses warmup, trim, and cooldown — those
// tests can keep advancing a single 2s tick.
const ADVANCE_TO_ENGAGE_MS = 12000;

const defaultLeakResult = {
  totalFds: 10,
  baselineFds: 5,
  estimatedTerminalFds: 5,
  activeTerminals: 2,
  isWarning: false,
  orphanedPids: [] as number[],
  ptmxLimit: 511,
};

describe("ResourceGovernor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFdMonitorSupported = true;
    mockCheckForLeaks = vi.fn().mockReturnValue({ ...defaultLeakResult });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts and stops monitoring interval", () => {
    const deps = createMockDeps();
    const governor = new ResourceGovernor(deps);
    governor.start();
    governor.dispose();
  });

  it("calls checkResources on interval", () => {
    const deps = createMockDeps();
    const governor = new ResourceGovernor(deps);
    governor.start();

    vi.advanceTimersByTime(2000);
    expect(deps.getTerminalPids).toHaveBeenCalled();
    expect(mockCheckForLeaks).toHaveBeenCalled();

    governor.dispose();
  });

  it("emits fd-leak-warning when FD monitor reports warning", () => {
    mockCheckForLeaks.mockReturnValue({
      totalFds: 50,
      baselineFds: 5,
      estimatedTerminalFds: 45,
      activeTerminals: 2,
      isWarning: true,
      orphanedPids: [1234],
      ptmxLimit: 511,
    });

    const deps = createMockDeps({
      getTerminalPids: vi.fn().mockReturnValue([
        { id: "t1", pid: 100 },
        { id: "t2", pid: 200 },
      ]),
    });

    const governor = new ResourceGovernor(deps);
    governor.start();

    vi.advanceTimersByTime(2000);

    expect(deps.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "fd-leak-warning",
        fdCount: 50,
        activeTerminals: 2,
        orphanedPids: [1234],
        ptmxLimit: 511,
      })
    );

    governor.dispose();
  });

  it("does not emit warning when FD monitor reports no warning", () => {
    const deps = createMockDeps();
    const governor = new ResourceGovernor(deps);
    governor.start();

    vi.advanceTimersByTime(2000);

    const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
    const fdWarnings = calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "fd-leak-warning"
    );
    expect(fdWarnings).toHaveLength(0);

    governor.dispose();
  });

  it("skips FD monitoring on unsupported platforms", () => {
    mockFdMonitorSupported = false;

    const deps = createMockDeps();
    const governor = new ResourceGovernor(deps);
    governor.start();

    vi.advanceTimersByTime(2000);

    expect(mockCheckForLeaks).not.toHaveBeenCalled();

    governor.dispose();
  });

  describe("engageThrottle", () => {
    it("pauses terminals via coordinator and emits host-throttled event under high memory", () => {
      const { coordinator, raw } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([
            { id: "t1", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
          ]),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);

      expect(raw.pause).toHaveBeenCalled();
      expect(coordinator.hasToken("resource-governor")).toBe(true);
      expect(deps.incrementPauseCount).toHaveBeenCalledWith(1);
      expect(deps.emitTerminalStatus).toHaveBeenCalledWith(
        "t1",
        "paused-resource-governor",
        undefined,
        undefined,
        expect.stringContaining("Memory pressure")
      );
      expect(deps.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "host-throttled",
          isThrottled: true,
        })
      );

      governor.dispose();
    });

    it("emits forced: false on threshold-cleared resume", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([{ id: "t1", lastOutputTime: 100, lastInputTime: 100 }]),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);

      // Drop memory below resume threshold — disengage uses raw utilization
      // so a single low tick resumes immediately.
      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 500 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);
      vi.advanceTimersByTime(2000);

      const event = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "host-throttled" &&
          (c[0] as Record<string, unknown>)?.isThrottled === false
      )?.[0] as Record<string, unknown> | undefined;

      expect(event).toBeDefined();
      expect(event?.forced).toBe(false);
      expect(event?.reason).toContain("High memory usage");
      expect(event?.duration).toBeGreaterThan(0);

      // Should emit "running" when no other tokens hold
      expect(deps.emitTerminalStatus).toHaveBeenCalledWith(
        "t1",
        "running",
        undefined,
        expect.any(Number)
      );

      governor.dispose();
    });

    it("emits forced: true on force-resume timeout", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);

      // Keep memory above resume threshold past force-resume timeout
      vi.advanceTimersByTime(12000);

      const event = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "host-throttled" &&
          (c[0] as Record<string, unknown>)?.isThrottled === false
      )?.[0] as Record<string, unknown> | undefined;

      expect(event).toBeDefined();
      expect(event?.forced).toBe(true);
      expect(event?.reason).toContain("High memory usage");

      governor.dispose();
    });
  });

  describe("dispose", () => {
    it("releases resource-governor token from coordinators when throttling", () => {
      const { coordinator, raw } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);

      expect(coordinator.hasToken("resource-governor")).toBe(true);
      raw.resume.mockClear();

      governor.dispose();

      expect(coordinator.hasToken("resource-governor")).toBe(false);
      expect(raw.resume).toHaveBeenCalled();
    });

    it("does not throw when not throttling", () => {
      const deps = createMockDeps();
      const governor = new ResourceGovernor(deps);
      governor.start();

      expect(() => governor.dispose()).not.toThrow();
    });

    it("double dispose does not throw", () => {
      const deps = createMockDeps();
      const governor = new ResourceGovernor(deps);
      governor.start();
      governor.dispose();
      expect(() => governor.dispose()).not.toThrow();
    });
  });

  describe("coordination with other managers", () => {
    it("disengageThrottle does not resume PTY when backpressure hold is active", () => {
      const { coordinator, raw } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([{ id: "t1", lastOutputTime: 100, lastInputTime: 100 }]),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      // Trigger engage
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);
      expect(coordinator.hasToken("resource-governor")).toBe(true);

      // Simulate backpressure manager also holding a pause
      coordinator.pause("backpressure");

      // Now lower memory to trigger disengage
      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 500 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      raw.resume.mockClear();
      (deps.emitTerminalStatus as ReturnType<typeof vi.fn>).mockClear();
      vi.advanceTimersByTime(2000);

      // Governor released its hold, but backpressure still holds — PTY must stay paused
      expect(coordinator.hasToken("resource-governor")).toBe(false);
      expect(coordinator.hasToken("backpressure")).toBe(true);
      expect(coordinator.isPaused).toBe(true);
      expect(raw.resume).not.toHaveBeenCalled();

      // Should NOT emit "running" because backpressure still holds
      const terminalStatusCalls = (
        deps.emitTerminalStatus as ReturnType<typeof vi.fn>
      ).mock.calls.filter((c: unknown[]) => (c as string[])[1] === "running");
      expect(terminalStatusCalls).toHaveLength(0);

      governor.dispose();
    });
  });

  describe("pending bytes gauge", () => {
    it("emits pending-bytes-gauge when metrics enabled and pending bytes > 0", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      const deps = createMockDeps({
        getPendingBytesSnapshot: vi.fn().mockReturnValue({
          totalPendingBytes: 1024,
          perTerminal: [{ terminalId: "t1", pendingBytes: 1024 }],
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(2000);

      expect(deps.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "terminal-reliability-metric",
          payload: expect.objectContaining({
            terminalId: "resource-governor",
            metricType: "pending-bytes-gauge",
            totalPendingBytes: 1024,
            perTerminal: [{ terminalId: "t1", pendingBytes: 1024 }],
          }),
        })
      );

      governor.dispose();
    });

    it("does not emit gauge when metrics are disabled", () => {
      vi.mocked(metricsEnabled).mockReturnValue(false);

      const deps = createMockDeps({
        getPendingBytesSnapshot: vi.fn().mockReturnValue({
          totalPendingBytes: 1024,
          perTerminal: [{ terminalId: "t1", pendingBytes: 1024 }],
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "pending-bytes-gauge"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("does not emit gauge when total pending bytes is zero", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      const deps = createMockDeps({
        getPendingBytesSnapshot: vi.fn().mockReturnValue({
          totalPendingBytes: 0,
          perTerminal: [],
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "pending-bytes-gauge"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("gracefully handles missing getPendingBytesSnapshot dep", () => {
      const deps = createMockDeps();
      const governor = new ResourceGovernor(deps);
      governor.start();

      // Should not throw
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();

      governor.dispose();
    });
  });

  describe("throughput rate gauge", () => {
    it("emits throughput-rate with exact rates on second tick (first tick seeds baselines)", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      let call = 0;
      const deps = createMockDeps({
        getThroughputSnapshot: vi.fn().mockImplementation(() => {
          call++;
          return {
            timestamp: call * 2000,
            totalBytes: 2048,
            totalPackets: 4,
            perTerminal: [{ terminalId: "t1", byteCount: 2048, packetCount: 4 }],
            pauseCount: call * 2,
          };
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      // First tick: seeds baselines, no emission
      vi.advanceTimersByTime(2000);

      // Second tick: emits with computed rates (2048 bytes / 2s = 1024 B/s)
      vi.advanceTimersByTime(2000);

      expect(deps.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "terminal-reliability-metric",
          payload: expect.objectContaining({
            terminalId: "resource-governor",
            metricType: "throughput-rate",
            totalBytesPerSecond: 1024,
            pauseCountDelta: 2,
            perTerminalThroughput: [
              {
                terminalId: "t1",
                bytesPerSecond: 1024,
                avgPacketSizeBytes: 512,
              },
            ],
          }),
        })
      );

      governor.dispose();
    });

    it("does not emit gauge when metrics are disabled", () => {
      vi.mocked(metricsEnabled).mockReturnValue(false);

      const deps = createMockDeps({
        getThroughputSnapshot: vi.fn().mockReturnValue({
          timestamp: 2000,
          totalBytes: 2048,
          totalPackets: 4,
          perTerminal: [{ terminalId: "t1", byteCount: 2048, packetCount: 4 }],
          pauseCount: 2,
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "throughput-rate"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("does not emit gauge when snapshot is null (no bytes accumulated)", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      const deps = createMockDeps({
        getThroughputSnapshot: vi.fn().mockReturnValue(null),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "throughput-rate"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("does not emit gauge when totalBytes is zero", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      const deps = createMockDeps({
        getThroughputSnapshot: vi.fn().mockReturnValue({
          timestamp: 2000,
          totalBytes: 0,
          totalPackets: 0,
          perTerminal: [],
          pauseCount: 0,
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "throughput-rate"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("gracefully handles missing getThroughputSnapshot dep", () => {
      const deps = createMockDeps();
      const governor = new ResourceGovernor(deps);
      governor.start();

      // Should not throw
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();

      governor.dispose();
    });

    it("computes pauseCountDelta from consecutive snapshots", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      let callCount = 0;
      const deps = createMockDeps({
        getThroughputSnapshot: vi.fn().mockImplementation(() => {
          callCount++;
          return {
            timestamp: callCount * 2000,
            totalBytes: 1024,
            totalPackets: 2,
            perTerminal: [{ terminalId: "t1", byteCount: 1024, packetCount: 2 }],
            pauseCount: callCount * 3,
          };
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      // First tick: seeds baselines (no emission)
      vi.advanceTimersByTime(2000);
      // Second tick: emits with delta from seeded baseline
      vi.advanceTimersByTime(2000);
      // Third tick: emits delta since last update
      vi.advanceTimersByTime(2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "throughput-rate"
      );

      // Two emissions (ticks 2 and 3)
      expect(gaugeCalls).toHaveLength(2);

      // First emission: pauseCount seeded at 3, current = 6, delta = 3
      expect((gaugeCalls[0][0] as Record<string, unknown>).payload).toMatchObject({
        pauseCountDelta: 3,
      });

      // Second emission: prev = 6, current = 9, delta = 3
      expect((gaugeCalls[1][0] as Record<string, unknown>).payload).toMatchObject({
        pauseCountDelta: 3,
      });

      governor.dispose();
    });
  });

  describe("host-memory-warning", () => {
    it("emits host-memory-warning when crossing warning threshold", () => {
      const deps = createMockDeps();
      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 750 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(2000);

      expect(deps.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "host-memory-warning",
          isWarning: true,
        })
      );

      governor.dispose();
    });

    it("clears warning when memory drops below clear threshold", () => {
      const deps = createMockDeps();
      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 750 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      // Drop below clear threshold
      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 600 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);
      vi.advanceTimersByTime(2000);

      expect(deps.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "host-memory-warning",
          isWarning: false,
        })
      );

      governor.dispose();
    });

    it("does not re-emit warning on consecutive ticks above threshold", () => {
      const deps = createMockDeps();
      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 750 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(2000);

      const warningCalls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "host-memory-warning"
      );
      expect(warningCalls).toHaveLength(1);

      governor.dispose();
    });
  });

  describe("triage ordering", () => {
    it("pauses idle terminals before active-agent terminals", () => {
      const c1 = createMockCoordinator();
      const c2 = createMockCoordinator();
      const c3 = createMockCoordinator();
      const coordinators: Record<string, ReturnType<typeof createMockCoordinator>> = {
        t1: c1,
        t2: c2,
        t3: c3,
      };

      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1", "t2", "t3"]),
        getPauseCoordinator: vi.fn((id: string) => coordinators[id]?.coordinator),
        getTerminalActivity: vi.fn().mockReturnValue([
          { id: "t1", lastOutputTime: 1000, lastInputTime: 1000, agentState: "idle" },
          { id: "t2", lastOutputTime: 3000, lastInputTime: 2000, agentState: "working" },
          { id: "t3", lastOutputTime: 2000, lastInputTime: 1000, agentState: "idle" },
        ]),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);

      const emitCalls = (deps.emitTerminalStatus as ReturnType<typeof vi.fn>).mock.calls;
      const pausedOrder = emitCalls.map((c: unknown[]) => (c as string[])[0]);

      // t2 (working agent) should be paused last
      expect(pausedOrder[pausedOrder.length - 1]).toBe("t2");

      governor.dispose();
    });
  });

  describe("critical pressure", () => {
    it("pauses all terminals immediately at 95%+ without triage ordering", () => {
      const c1 = createMockCoordinator();
      const c2 = createMockCoordinator();
      const coordinators: Record<string, ReturnType<typeof createMockCoordinator>> = {
        t1: c1,
        t2: c2,
      };

      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1", "t2"]),
        getPauseCoordinator: vi.fn((id: string) => coordinators[id]?.coordinator),
        getTerminalActivity: vi.fn().mockReturnValue([
          { id: "t1", lastOutputTime: 1000, lastInputTime: 1000, agentState: "working" },
          { id: "t2", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
        ]),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 980 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      // At critical, both should be paused — order follows getTerminalIds (no sort)
      const emitCalls = (deps.emitTerminalStatus as ReturnType<typeof vi.fn>).mock.calls;
      expect(emitCalls).toHaveLength(2);

      governor.dispose();
    });
  });

  describe("setResourceProfile", () => {
    it("lowers throttle threshold on efficiency profile", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([{ id: "t1", lastOutputTime: 100, lastInputTime: 100 }]),
      });

      const governor = new ResourceGovernor(deps);
      governor.setResourceProfile("efficiency");
      governor.start();

      // 75% heap — below default 85% but above efficiency 70%
      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 768 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);

      expect(coordinator.hasToken("resource-governor")).toBe(true);

      governor.dispose();
    });

    it("restores default thresholds when switching back to balanced", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([{ id: "t1", lastOutputTime: 100, lastInputTime: 100 }]),
      });

      const governor = new ResourceGovernor(deps);
      governor.setResourceProfile("efficiency");
      governor.setResourceProfile("balanced");
      governor.start();

      // 75% heap — above efficiency 70% but below default 85%
      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 768 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      // Advance past warmup to verify no throttle ever fires on balanced.
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);

      // Should NOT throttle at 75% on balanced profile
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      governor.dispose();
    });

    it("lowers warning threshold on efficiency profile", () => {
      const deps = createMockDeps();
      const governor = new ResourceGovernor(deps);
      governor.setResourceProfile("efficiency");
      governor.start();

      // 60% heap — below default warning 70% but above efficiency warning 55%
      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 614 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      vi.advanceTimersByTime(2000);

      expect(deps.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "host-memory-warning",
          isWarning: true,
        })
      );

      governor.dispose();
    });
  });

  describe("EMA smoothing and warmup", () => {
    it("does not engage on a single-tick spike above threshold", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([
            { id: "t1", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
          ]),
      });

      // Baseline at 50% for first 5 ticks (warmup), then a single spike to 90%.
      const memSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 512 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      // Complete warmup at low memory.
      vi.advanceTimersByTime(10000);
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      // Single-tick spike to 90%.
      memSpy.mockReturnValue({
        heapUsed: 922 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);
      vi.advanceTimersByTime(2000);

      // Drop back. EMA pushes smoothed to ~0.18*90 + 0.82*50 = 57.2 — well below 85.
      memSpy.mockReturnValue({
        heapUsed: 512 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);
      vi.advanceTimersByTime(4000);

      // No throttle, no trim — smoothed never crossed 85%.
      expect(coordinator.hasToken("resource-governor")).toBe(false);
      expect(deps.trimBuffers).not.toHaveBeenCalled();

      governor.dispose();
    });

    it("suppresses engage during warmup even under sustained high memory", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([
            { id: "t1", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
          ]),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      // Only 4 ticks (8s) — below WARMUP_TICKS=5.
      vi.advanceTimersByTime(8000);
      expect(coordinator.hasToken("resource-governor")).toBe(false);
      expect(deps.trimBuffers).not.toHaveBeenCalled();

      governor.dispose();
    });

    it("calls trimBuffers once before pausing, then pauses on next tick", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([
            { id: "t1", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
          ]),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      // 5 ticks = warmup complete. The 5th tick fires trim, NOT engage.
      vi.advanceTimersByTime(10000);
      expect(deps.trimBuffers).toHaveBeenCalledTimes(1);
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      // 6th tick: trim already attempted, escalate to pause.
      vi.advanceTimersByTime(2000);
      expect(coordinator.hasToken("resource-governor")).toBe(true);

      governor.dispose();
    });

    it("trims at most once per pressure episode", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([
            { id: "t1", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
          ]),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      // Engage, then advance many more ticks while still throttled.
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS + 6000);
      expect(deps.trimBuffers).toHaveBeenCalledTimes(1);

      governor.dispose();
    });

    it("eventually pauses even if trimBuffers throws", () => {
      const { coordinator } = createMockCoordinator();
      const trimBuffers = vi.fn().mockImplementation(() => {
        throw new Error("trim failed");
      });
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([
            { id: "t1", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
          ]),
        trimBuffers,
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);
      expect(trimBuffers).toHaveBeenCalled();
      expect(coordinator.hasToken("resource-governor")).toBe(true);

      governor.dispose();
    });

    it("bypasses warmup, trim, and cooldown gates at critical pressure (≥95%)", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([
            { id: "t1", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
          ]),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 980 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(2000);
      expect(coordinator.hasToken("resource-governor")).toBe(true);
      expect(deps.trimBuffers).not.toHaveBeenCalled();

      governor.dispose();
    });
  });

  describe("re-engage cooldown", () => {
    it("does not re-engage immediately after a force-resume even at high pressure", () => {
      const { coordinator, raw } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([
            { id: "t1", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
          ]),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      // Engage + sustained pressure → force-resume after FORCE_RESUME_MS.
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS + 12000);
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      const forceResumeEvent = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "host-throttled" &&
          (c[0] as Record<string, unknown>)?.isThrottled === false &&
          (c[0] as Record<string, unknown>)?.forced === true
      );
      expect(forceResumeEvent).toBeDefined();

      // Pressure persists. Advance several ticks (~10s) — must NOT re-engage
      // until REENGAGE_COOLDOWN_MS (30s) has elapsed.
      raw.pause.mockClear();
      vi.advanceTimersByTime(10000);
      expect(coordinator.hasToken("resource-governor")).toBe(false);
      expect(raw.pause).not.toHaveBeenCalled();

      governor.dispose();
    });

    it("re-engages after the cooldown elapses with sustained pressure", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([
            { id: "t1", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
          ]),
      });

      vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const governor = new ResourceGovernor(deps);
      governor.start();

      // First engage + force-resume.
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS + 12000);
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      // Wait out the cooldown (30s) plus enough time for trim + pause cycle.
      // After force-resume, trimAttemptedForCurrentPressure resets, so the
      // first tick past the cooldown gate re-fires trim, and the tick after
      // that actually engages.
      vi.advanceTimersByTime(34000);
      expect(coordinator.hasToken("resource-governor")).toBe(true);

      governor.dispose();
    });

    it("threshold-based disengage also sets the cooldown gate", () => {
      const { coordinator, raw } = createMockCoordinator();
      const memSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([
            { id: "t1", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
          ]),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      // Engage, then drop memory to threshold-clear.
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);
      expect(coordinator.hasToken("resource-governor")).toBe(true);

      memSpy.mockReturnValue({
        heapUsed: 500 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);
      vi.advanceTimersByTime(2000);
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      // Pressure returns immediately. Cooldown gate must still block re-engage.
      memSpy.mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);
      raw.pause.mockClear();
      vi.advanceTimersByTime(10000);
      expect(coordinator.hasToken("resource-governor")).toBe(false);
      expect(raw.pause).not.toHaveBeenCalled();

      governor.dispose();
    });
  });

  describe("resume ordering", () => {
    it("resumes idle terminals before working-agent terminals", () => {
      const c1 = createMockCoordinator();
      const c2 = createMockCoordinator();
      const c3 = createMockCoordinator();
      const coordinators: Record<string, ReturnType<typeof createMockCoordinator>> = {
        t1: c1,
        t2: c2,
        t3: c3,
      };

      const memSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1", "t2", "t3"]),
        getPauseCoordinator: vi.fn((id: string) => coordinators[id]?.coordinator),
        getTerminalActivity: vi.fn().mockReturnValue([
          { id: "t1", lastOutputTime: 1000, lastInputTime: 1000, agentState: "idle" },
          { id: "t2", lastOutputTime: 3000, lastInputTime: 2000, agentState: "working" },
          { id: "t3", lastOutputTime: 2000, lastInputTime: 1000, agentState: "idle" },
        ]),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      // Engage, then clear pressure to trigger threshold-based disengage.
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);
      (deps.emitTerminalStatus as ReturnType<typeof vi.fn>).mockClear();

      memSpy.mockReturnValue({
        heapUsed: 500 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);
      vi.advanceTimersByTime(2000);

      const resumeEmits = (deps.emitTerminalStatus as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => (c as string[])[1] === "running")
        .map((c: unknown[]) => (c as string[])[0]);

      // t2 (working agent) must resume last.
      expect(resumeEmits[resumeEmits.length - 1]).toBe("t2");

      governor.dispose();
    });

    it("does not resume terminals not paused by the resource governor", () => {
      const { coordinator: c1 } = createMockCoordinator();
      const c2 = createMockCoordinator();
      const coordinators: Record<string, ReturnType<typeof createMockCoordinator>> = {
        t1: { coordinator: c1, raw: { pause: vi.fn(), resume: vi.fn() } },
        t2: c2,
      };

      const memSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        heapUsed: 900 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);

      const deps = createMockDeps({
        // Only t1 is visible to the governor when engage fires.
        getTerminalIds: vi.fn().mockReturnValueOnce(["t1"]).mockReturnValue(["t1", "t2"]),
        getPauseCoordinator: vi.fn((id: string) => coordinators[id]?.coordinator),
        getTerminalActivity: vi.fn().mockReturnValue([
          { id: "t1", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
          { id: "t2", lastOutputTime: 100, lastInputTime: 100, agentState: "idle" },
        ]),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);
      expect(c1.hasToken("resource-governor")).toBe(true);
      expect(c2.coordinator.hasToken("resource-governor")).toBe(false);

      // t2 came online while paused, governed by another pause holder.
      c2.coordinator.pause("backpressure");

      memSpy.mockReturnValue({
        heapUsed: 500 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as ReturnType<typeof process.memoryUsage>);
      c2.raw.resume.mockClear();
      vi.advanceTimersByTime(2000);

      // t2 was never paused by the governor — its raw.resume must not be called.
      expect(c2.raw.resume).not.toHaveBeenCalled();
      expect(c2.coordinator.hasToken("backpressure")).toBe(true);

      governor.dispose();
    });
  });

  describe("trackKilledPid", () => {
    it("tracks killed PIDs and passes them to FdMonitor after grace period", () => {
      const deps = createMockDeps();
      const governor = new ResourceGovernor(deps);
      governor.start();

      governor.trackKilledPid(5678);

      // First tick — grace period not elapsed yet (only 2s, need 4s)
      vi.advanceTimersByTime(2000);
      expect(mockCheckForLeaks).toHaveBeenLastCalledWith(0, []);

      // After grace period (6s total from start, 4s from trackKilledPid)
      vi.advanceTimersByTime(4000);
      expect(mockCheckForLeaks).toHaveBeenLastCalledWith(0, [5678]);

      governor.dispose();
    });
  });
});
