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

// Mock process.memoryUsage with MB-denominated values. Utilization is the
// binding constraint: max(heap / 512 heap budget, combined / 768 process
// budget) — so mockMemoryUsage(450) = 87.9% (heap-bound) and
// mockMemoryUsage(300, 276) = 75% (combined-bound).
// Re-invoking returns the same spy, so later calls re-mock in place.
function mockMemoryUsage(heapMb: number, externalMb = 0, arrayBuffersMb = 0) {
  return vi.spyOn(process, "memoryUsage").mockReturnValue({
    heapUsed: heapMb * 1024 * 1024,
    rss: 1024 * 1024 * 1024,
    external: externalMb * 1024 * 1024,
    arrayBuffers: arrayBuffersMb * 1024 * 1024,
  } as ReturnType<typeof process.memoryUsage>);
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

      mockMemoryUsage(450);

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

      mockMemoryUsage(450);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);

      // Drop memory below resume threshold — disengage uses raw utilization
      // so a single low tick resumes immediately.
      mockMemoryUsage(250);
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

    it("disengages on raw utilization even when smoothed is still elevated", () => {
      const { coordinator } = createMockCoordinator();
      mockMemoryUsage(450);

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

      // Engage at sustained 87.89% — smoothed EMA tracks this value exactly.
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);
      expect(coordinator.hasToken("resource-governor")).toBe(true);

      // Drop raw to 53.7% (275MB) in a single tick — well below the 60%
      // resume threshold. Smoothed will only decay to ~81.7% on this tick,
      // still above 60%. Disengage must still fire because it uses RAW.
      mockMemoryUsage(275);
      vi.advanceTimersByTime(2000);

      expect(coordinator.hasToken("resource-governor")).toBe(false);
      const disengageEvent = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "host-throttled" &&
          (c[0] as Record<string, unknown>)?.isThrottled === false
      );
      expect(disengageEvent).toBeDefined();
      expect((disengageEvent?.[0] as Record<string, unknown>).forced).toBe(false);

      governor.dispose();
    });

    it("emits forced: true on force-resume timeout", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
      });

      mockMemoryUsage(450);

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

      mockMemoryUsage(450);

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
    it.each(["ipc-queue", "port-queue", "port-queue-5"] as const)(
      "disengageThrottle does not resume PTY when %s hold is active",
      (queueToken) => {
        const { coordinator, raw } = createMockCoordinator();
        const deps = createMockDeps({
          getTerminalIds: vi.fn().mockReturnValue(["t1"]),
          getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
          getTerminalActivity: vi
            .fn()
            .mockReturnValue([{ id: "t1", lastOutputTime: 100, lastInputTime: 100 }]),
        });

        mockMemoryUsage(450);

        const governor = new ResourceGovernor(deps);
        governor.start();

        // Trigger engage
        vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);
        expect(coordinator.hasToken("resource-governor")).toBe(true);

        // Simulate a queue manager also holding a pause
        coordinator.pause(queueToken);

        // Now lower memory to trigger disengage
        mockMemoryUsage(250);

        raw.resume.mockClear();
        (deps.emitTerminalStatus as ReturnType<typeof vi.fn>).mockClear();
        vi.advanceTimersByTime(2000);

        // Governor released its hold, but backpressure still holds — PTY must stay paused
        expect(coordinator.hasToken("resource-governor")).toBe(false);
        expect(coordinator.hasToken(queueToken)).toBe(true);
        expect(coordinator.isPaused).toBe(true);
        expect(raw.resume).not.toHaveBeenCalled();

        // Should NOT emit "running" because backpressure still holds
        const statusCalls = (deps.emitTerminalStatus as ReturnType<typeof vi.fn>).mock.calls;
        const runningCalls = statusCalls.filter((c: unknown[]) => (c as string[])[1] === "running");
        expect(runningCalls).toHaveLength(0);

        // Should re-emit "paused-backpressure" so the renderer pill isn't stuck
        // on the governor's stale "Paused (memory)" status
        const backpressureCalls = statusCalls.filter(
          (c: unknown[]) => (c as string[])[1] === "paused-backpressure"
        );
        expect(backpressureCalls).toHaveLength(1);
        expect(backpressureCalls[0]).toEqual([
          "t1",
          "paused-backpressure",
          undefined,
          expect.any(Number),
        ]);

        governor.dispose();
      }
    );

    it("dispose does not emit paused-backpressure for terminals with a queue hold", () => {
      const { coordinator } = createMockCoordinator();
      const deps = createMockDeps({
        getTerminalIds: vi.fn().mockReturnValue(["t1"]),
        getPauseCoordinator: vi.fn().mockReturnValue(coordinator),
        getTerminalActivity: vi
          .fn()
          .mockReturnValue([{ id: "t1", lastOutputTime: 100, lastInputTime: 100 }]),
      });

      mockMemoryUsage(450);

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);
      expect(coordinator.hasToken("resource-governor")).toBe(true);
      coordinator.pause("ipc-queue");

      (deps.emitTerminalStatus as ReturnType<typeof vi.fn>).mockClear();
      governor.dispose();

      // Teardown path deliberately has no backpressure-restore branch — queue
      // managers emit their own events, and renderers are disconnected first
      const statusCalls = (deps.emitTerminalStatus as ReturnType<typeof vi.fn>).mock.calls;
      const backpressureCalls = statusCalls.filter(
        (c: unknown[]) => (c as string[])[1] === "paused-backpressure"
      );
      expect(backpressureCalls).toHaveLength(0);
      const runningCalls = statusCalls.filter((c: unknown[]) => (c as string[])[1] === "running");
      expect(runningCalls).toHaveLength(0);
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
    it("emits throughput-rate with exact rates on second tick (first tick seeds hasThroughputBaseline)", () => {
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

    it("uses fixed 2s window for rate after an idle gap (does not underreport)", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      let call = 0;
      const deps = createMockDeps({
        getThroughputSnapshot: vi.fn().mockImplementation(() => {
          call++;
          // Tick 1: seed (zero bytes). Ticks 2–16 (15 ticks = 30s) return null
          // to simulate an idle gap. Tick 17: an active burst of 2048 bytes.
          if (call === 1) {
            return {
              timestamp: call * 2000,
              totalBytes: 0,
              totalPackets: 0,
              perTerminal: [],
              pauseCount: 0,
            };
          }
          if (call >= 2 && call <= 16) {
            return null;
          }
          return {
            timestamp: call * 2000,
            totalBytes: 2048,
            totalPackets: 4,
            perTerminal: [{ terminalId: "t1", byteCount: 2048, packetCount: 4 }],
            pauseCount: 0,
          };
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      // 17 ticks total: 1 seed + 15 idle + 1 active = 34s
      vi.advanceTimersByTime(17 * 2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "throughput-rate"
      );

      // Exactly one emission (the active tick). No rate emission on the seed or
      // the null-snapshot idle ticks.
      expect(gaugeCalls).toHaveLength(1);

      // Rate is computed against the 2s poll window, not the 34s wall-clock gap.
      // Bug underfix would report ~60 B/s (2048 / 34s); correct is 1024 B/s.
      expect((gaugeCalls[0][0] as Record<string, unknown>).payload).toMatchObject({
        totalBytesPerSecond: 1024,
        perTerminalThroughput: [
          {
            terminalId: "t1",
            bytesPerSecond: 1024,
            avgPacketSizeBytes: 512,
          },
        ],
      });

      governor.dispose();
    });

    it("does not misattribute idle-window pauseCount deltas to the next active tick", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      let call = 0;
      const deps = createMockDeps({
        getThroughputSnapshot: vi.fn().mockImplementation(() => {
          call++;
          // Tick 1: seed (zero bytes, no pauses). Tick 2: zero-byte non-null
          // snapshot with 5 pauses accumulated since seed. Tick 3: active tick
          // with 1 additional pause.
          if (call === 1) {
            return {
              timestamp: call * 2000,
              totalBytes: 0,
              totalPackets: 0,
              perTerminal: [],
              pauseCount: 0,
            };
          }
          if (call === 2) {
            return {
              timestamp: call * 2000,
              totalBytes: 0,
              totalPackets: 0,
              perTerminal: [],
              pauseCount: 5,
            };
          }
          return {
            timestamp: call * 2000,
            totalBytes: 1024,
            totalPackets: 2,
            perTerminal: [{ terminalId: "t1", byteCount: 1024, packetCount: 2 }],
            pauseCount: 6,
          };
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      // 3 ticks
      vi.advanceTimersByTime(3 * 2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "throughput-rate"
      );

      // Exactly one emission (the active tick on tick 3). The zero-byte tick 2
      // advances prevPauseCount silently — no emission.
      expect(gaugeCalls).toHaveLength(1);

      // pauseCountDelta is 1 (the pause in the active window), not 6 (which
      // would leak the idle-window pauses into this emission).
      expect((gaugeCalls[0][0] as Record<string, unknown>).payload).toMatchObject({
        totalBytesPerSecond: 512,
        pauseCountDelta: 1,
      });

      governor.dispose();
    });
  });

  describe("pause-duration-gauge", () => {
    it("emits pause-duration-gauge with per-terminal held durations when metrics enabled", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      const deps = createMockDeps({
        getPausedDurationsSnapshot: vi.fn().mockReturnValue([
          { terminalId: "t1", heldDurationMs: 4000 },
          { terminalId: "t2", heldDurationMs: 12000 },
        ]),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(2000);

      expect(deps.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "terminal-reliability-metric",
          payload: expect.objectContaining({
            terminalId: "resource-governor",
            metricType: "pause-duration-gauge",
            perTerminalHeld: [
              { terminalId: "t1", heldDurationMs: 4000 },
              { terminalId: "t2", heldDurationMs: 12000 },
            ],
          }),
        })
      );

      governor.dispose();
    });

    it("does not emit gauge when metrics are disabled", () => {
      vi.mocked(metricsEnabled).mockReturnValue(false);

      const deps = createMockDeps({
        getPausedDurationsSnapshot: vi
          .fn()
          .mockReturnValue([{ terminalId: "t1", heldDurationMs: 4000 }]),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "pause-duration-gauge"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("does not emit gauge when snapshot is empty", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      const deps = createMockDeps({
        getPausedDurationsSnapshot: vi.fn().mockReturnValue([]),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "pause-duration-gauge"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("gracefully handles missing getPausedDurationsSnapshot dep", () => {
      const deps = createMockDeps();
      const governor = new ResourceGovernor(deps);
      governor.start();

      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();

      governor.dispose();
    });
  });

  describe("queue-depth-gauge", () => {
    it("emits queue-depth-gauge with layer-tagged entries when metrics enabled", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      const deps = createMockDeps({
        getQueueDepthSnapshot: vi.fn().mockReturnValue([
          { terminalId: "t1", layer: "ipc", pendingBytes: 1024 },
          { terminalId: "t1", layer: "port", pendingBytes: 2048 },
          { terminalId: "t2", layer: "port", pendingBytes: 512 },
        ]),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      expect(deps.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "terminal-reliability-metric",
          payload: expect.objectContaining({
            terminalId: "resource-governor",
            metricType: "queue-depth-gauge",
            perTerminalQueueDepth: [
              { terminalId: "t1", layer: "ipc", pendingBytes: 1024 },
              { terminalId: "t1", layer: "port", pendingBytes: 2048 },
              { terminalId: "t2", layer: "port", pendingBytes: 512 },
            ],
          }),
        })
      );

      governor.dispose();
    });

    it("does not emit gauge when metrics are disabled", () => {
      vi.mocked(metricsEnabled).mockReturnValue(false);

      const deps = createMockDeps({
        getQueueDepthSnapshot: vi
          .fn()
          .mockReturnValue([{ terminalId: "t1", layer: "ipc", pendingBytes: 1024 }]),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "queue-depth-gauge"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("does not emit gauge when snapshot is empty", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      const deps = createMockDeps({
        getQueueDepthSnapshot: vi.fn().mockReturnValue([]),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "queue-depth-gauge"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("gracefully handles missing getQueueDepthSnapshot dep", () => {
      const deps = createMockDeps();
      const governor = new ResourceGovernor(deps);
      governor.start();

      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();

      governor.dispose();
    });
  });

  describe("data-loss-count", () => {
    it("emits data-loss-count with non-zero deltas when metrics enabled", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      const deps = createMockDeps({
        getDropSnapshot: vi.fn().mockReturnValue({
          droppedBytesDelta: 4096,
          dataLossCountDelta: 3,
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
            metricType: "data-loss-count",
            droppedBytesDelta: 4096,
            dataLossCountDelta: 3,
          }),
        })
      );

      governor.dispose();
    });

    it("does not emit when both deltas are zero (skip-when-zero)", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      const deps = createMockDeps({
        getDropSnapshot: vi.fn().mockReturnValue({
          droppedBytesDelta: 0,
          dataLossCountDelta: 0,
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
            "data-loss-count"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("emits when only one of the two deltas is non-zero (idempotent guard)", () => {
      vi.mocked(metricsEnabled).mockReturnValue(true);

      const deps = createMockDeps({
        getDropSnapshot: vi.fn().mockReturnValue({
          droppedBytesDelta: 0,
          dataLossCountDelta: 2,
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      expect(deps.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            metricType: "data-loss-count",
            droppedBytesDelta: 0,
            dataLossCountDelta: 2,
          }),
        })
      );

      governor.dispose();
    });

    it("does not emit gauge when metrics are disabled", () => {
      vi.mocked(metricsEnabled).mockReturnValue(false);

      const deps = createMockDeps({
        getDropSnapshot: vi.fn().mockReturnValue({
          droppedBytesDelta: 4096,
          dataLossCountDelta: 3,
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
            "data-loss-count"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("gracefully handles missing getDropSnapshot dep", () => {
      const deps = createMockDeps();
      const governor = new ResourceGovernor(deps);
      governor.start();

      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();

      governor.dispose();
    });

    it("always resets the drop counter on each tick, even when metrics are disabled", () => {
      // Locks in the regression-detection contract: the counter must NOT
      // accumulate indefinitely while metrics are gated off, otherwise the
      // first emit after toggling metrics on would dump the entire
      // historical backlog as a false "regression" — defeating the
      // purpose of the gauge.
      vi.mocked(metricsEnabled).mockReturnValue(false);

      let snapshotCount = 0;
      const deps = createMockDeps({
        getDropSnapshot: vi.fn().mockImplementation(() => {
          snapshotCount++;
          // Each tick the mock reports 100 new bytes / 1 new drop.
          return { droppedBytesDelta: 100, dataLossCountDelta: 1 };
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      // Three ticks with metrics off. Snapshot must be called on every
      // tick (gated emission is what was failing here).
      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(2000);

      expect(snapshotCount).toBe(3);
      // No wire emissions because metrics are gated.
      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "data-loss-count"
      );
      expect(gaugeCalls).toHaveLength(0);

      governor.dispose();
    });

    it("emits a bounded delta after toggling metrics on (not the historical backlog)", () => {
      // Continuation of the previous test: after a metrics-off period,
      // the first emit after the gate opens must report only the drops
      // accumulated since the gate opened — not the historical total.
      vi.mocked(metricsEnabled).mockReturnValue(false);

      // Track call index so the mock can simulate "drops only after
      // metrics flip on" — the counter reset on every tick means the
      // gauge never accumulates a backlog.
      let callIdx = 0;
      const dropsByTick = [0, 0, 0, 5]; // 3 off-ticks with 0 drops, then 1 drop after flip

      const deps = createMockDeps({
        getDropSnapshot: vi.fn().mockImplementation(() => {
          const drops = dropsByTick[callIdx] ?? 0;
          callIdx++;
          return { droppedBytesDelta: drops * 1024, dataLossCountDelta: drops };
        }),
      });

      const governor = new ResourceGovernor(deps);
      governor.start();

      // 3 ticks with metrics off.
      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(2000);

      // Flip metrics on.
      vi.mocked(metricsEnabled).mockReturnValue(true);

      vi.advanceTimersByTime(2000);

      // The post-flip emit must reflect ONLY the post-flip drop, not
      // the historical 0+0+0+5 = 5 backlog. The counter is reset on
      // every tick (the off-ticks reset to 0, the post-flip tick
      // captured the fresh 5).
      const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
      const gaugeCalls = calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.type === "terminal-reliability-metric" &&
          ((c[0] as Record<string, unknown>)?.payload as Record<string, unknown>)?.metricType ===
            "data-loss-count"
      );
      expect(gaugeCalls).toHaveLength(1);
      expect((gaugeCalls[0][0] as Record<string, unknown>).payload).toMatchObject({
        droppedBytesDelta: 5 * 1024,
        dataLossCountDelta: 5,
      });

      governor.dispose();
    });
  });

  describe("host-memory-warning", () => {
    it("emits host-memory-warning when crossing warning threshold", () => {
      const deps = createMockDeps();
      mockMemoryUsage(375);

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
      mockMemoryUsage(375);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      // Drop below clear threshold
      mockMemoryUsage(300);
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
      mockMemoryUsage(375);

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

  describe("external memory signal", () => {
    it("engages from external-only pressure invisible to the heap signal", () => {
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

      // 64MB heap + 620MB external = 684MB → 89.1% of the 768MB budget.
      // A heap-only signal would read far below every threshold.
      mockMemoryUsage(64, 620);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);

      expect(coordinator.hasToken("resource-governor")).toBe(true);

      governor.dispose();
    });

    it("engages immediately when external pushes combined past critical", () => {
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

      // 100MB heap + 640MB external = 740MB → 96.4%: the critical bypass
      // fires on the first tick with no warmup or trim.
      mockMemoryUsage(100, 640);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      expect(coordinator.hasToken("resource-governor")).toBe(true);
      expect(deps.trimBuffers).not.toHaveBeenCalled();

      governor.dispose();
    });

    it("computes utilizationPercent from combined heap + external and reports both in the payload", () => {
      const deps = createMockDeps();
      // 300MB heap + 276MB external = 576MB → exactly 75% of 768MB.
      mockMemoryUsage(300, 276);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      expect(deps.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "host-memory-warning",
          isWarning: true,
          utilizationPercent: 75,
          heapMb: 300,
          externalMb: 276,
        })
      );

      governor.dispose();
    });

    it("includes heapMb and externalMb on the warning-cleared event", () => {
      const deps = createMockDeps();
      mockMemoryUsage(300, 276);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      // 200MB heap + 100MB external = 300MB → 39.1%, below the clear band.
      mockMemoryUsage(200, 100);
      vi.advanceTimersByTime(2000);

      expect(deps.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "host-memory-warning",
          isWarning: false,
          heapMb: 200,
          externalMb: 100,
        })
      );

      governor.dispose();
    });

    it("still engages on heap-only pressure near the V8 cap (heap budget is the binding constraint)", () => {
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

      // 440MB heap + 5MB external = 445MB → only 57.9% of the 768MB process
      // budget, but 440/512 = 85.9% of the heap cap. A combined-only signal
      // would never see a runaway JS heap (heap maxes out at 67% of 768).
      mockMemoryUsage(440, 5);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);

      expect(coordinator.hasToken("resource-governor")).toBe(true);

      governor.dispose();
    });

    it("routes external-only pressure through warmup and trim, not a raw bypass", () => {
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

      // 89.1% from external — above engage, below critical.
      mockMemoryUsage(64, 620);

      const governor = new ResourceGovernor(deps);
      governor.start();

      // 4 ticks — below WARMUP_TICKS=5: no trim, no pause.
      vi.advanceTimersByTime(8000);
      expect(deps.trimBuffers).not.toHaveBeenCalled();
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      // Tick 5: warmup satisfied, one-shot trim fires, still no pause.
      vi.advanceTimersByTime(2000);
      expect(deps.trimBuffers).toHaveBeenCalledTimes(1);
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      // Tick 6: escalates to pause.
      vi.advanceTimersByTime(2000);
      expect(coordinator.hasToken("resource-governor")).toBe(true);

      governor.dispose();
    });

    it("does not warn just below the external-driven warning boundary", () => {
      const deps = createMockDeps();
      // 537/768 = 69.9% — below the 70% warning threshold (strict >).
      mockMemoryUsage(0, 537);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      const warningCalls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "host-memory-warning"
      );
      expect(warningCalls).toHaveLength(0);

      governor.dispose();
    });

    it("warns just above the external-driven warning boundary", () => {
      const deps = createMockDeps();
      // 538/768 = 70.05% — crosses the 70% warning threshold.
      mockMemoryUsage(0, 538);

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

    it("does not double-count arrayBuffers (a subset of external)", () => {
      const deps = createMockDeps();
      // 200MB heap + 200MB external (all of it ArrayBuffers) = 400MB → 52%.
      // Summing arrayBuffers on top would read 600MB → 78% and falsely warn.
      mockMemoryUsage(200, 200, 200);

      const governor = new ResourceGovernor(deps);
      governor.start();
      vi.advanceTimersByTime(2000);

      const warningCalls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "host-memory-warning"
      );
      expect(warningCalls).toHaveLength(0);

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

      mockMemoryUsage(450);

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

      mockMemoryUsage(490);

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

      // 75% of budget — below default 85% but above efficiency 70%
      mockMemoryUsage(384);

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

      // 75% of budget — above efficiency 70% but below default 85%
      mockMemoryUsage(384);

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

      // 60% of budget — below default warning 70% but above efficiency warning 55%
      mockMemoryUsage(307);

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
      mockMemoryUsage(256);

      const governor = new ResourceGovernor(deps);
      governor.start();

      // Complete warmup at low memory.
      vi.advanceTimersByTime(10000);
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      // Single-tick spike to 90%.
      mockMemoryUsage(461);
      vi.advanceTimersByTime(2000);

      // Drop back. EMA pushes smoothed to ~0.18*90 + 0.82*50 = 57.2 — well below 85.
      mockMemoryUsage(256);
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

      mockMemoryUsage(450);

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

      mockMemoryUsage(450);

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

      mockMemoryUsage(450);

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

      mockMemoryUsage(450);

      const governor = new ResourceGovernor(deps);
      governor.start();

      vi.advanceTimersByTime(ADVANCE_TO_ENGAGE_MS);
      expect(trimBuffers).toHaveBeenCalled();
      expect(coordinator.hasToken("resource-governor")).toBe(true);

      governor.dispose();
    });

    it("re-arms trim attempt when pressure clears without ever engaging", () => {
      const { coordinator } = createMockCoordinator();
      mockMemoryUsage(450);

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

      // 5 ticks at high pressure → trim attempt fires on tick 5.
      vi.advanceTimersByTime(10000);
      expect(deps.trimBuffers).toHaveBeenCalledTimes(1);
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      // Pressure clears. EMA decays so smoothed eventually crosses below the
      // engage threshold and the re-arm branch fires.
      mockMemoryUsage(128);
      vi.advanceTimersByTime(40000);
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      // Pressure returns. EMA needs ~16 ticks to climb from ~25% back above
      // the 85% engage threshold; trim must fire again for the new episode.
      mockMemoryUsage(450);
      vi.advanceTimersByTime(40000);
      expect(deps.trimBuffers).toHaveBeenCalledTimes(2);

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

      mockMemoryUsage(490);

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

      mockMemoryUsage(450);

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

      mockMemoryUsage(450);

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
      mockMemoryUsage(450);

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

      mockMemoryUsage(250);
      vi.advanceTimersByTime(2000);
      expect(coordinator.hasToken("resource-governor")).toBe(false);

      // Pressure returns immediately. Cooldown gate must still block re-engage.
      mockMemoryUsage(450);
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

      mockMemoryUsage(450);

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

      mockMemoryUsage(250);
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

      mockMemoryUsage(450);

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

      mockMemoryUsage(250);
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
