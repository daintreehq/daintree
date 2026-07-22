import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import type { WorkspaceClient } from "../WorkspaceClient.js";
import type { HibernationService } from "../HibernationService.js";
import type { ProjectStatsService } from "../ProjectStatsService.js";

const lagState = vi.hoisted(() => ({
  // Returned by histogram.percentile(99) — nanoseconds.
  p99Nanoseconds: 0,
  // Returned by histogram.max — nanoseconds. Independent so payload
  // assertions can verify maxMs is sourced from .max, not percentile(99).
  maxNanoseconds: 0,
  utilization: 0,
  resetCount: 0,
}));

vi.mock("electron", () => ({
  app: {
    getAppMetrics: vi.fn(() => []),
  },
  powerMonitor: {
    isOnBatteryPower: vi.fn(() => false),
    getCurrentThermalState: vi.fn(() => "unknown" as const),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
}));

vi.mock("node:perf_hooks", () => ({
  monitorEventLoopDelay: () => ({
    enable: vi.fn(),
    disable: vi.fn(),
    percentile: () => lagState.p99Nanoseconds,
    reset: () => {
      lagState.resetCount += 1;
    },
    // max is diagnostic-only and tracked independently so tests can verify
    // the implementation reads .max instead of percentile(99).
    get max() {
      return lagState.maxNanoseconds;
    },
  }),
  performance: {
    eventLoopUtilization: (_current?: unknown, _previous?: unknown) => ({
      idle: 0,
      active: 0,
      utilization: lagState.utilization,
    }),
  },
}));

import os from "os";
import { app, powerMonitor } from "electron";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { logInfo } from "../../utils/logger.js";
import { ResourceProfileService, type ResourceProfileDeps } from "../ResourceProfileService.js";
import { resetAppMetricsSnapshotForTesting } from "../../utils/appMetricsSnapshot.js";

const EIGHT_GB = 8 * 1024 * 1024 * 1024;

const mockGetAppMetrics = app.getAppMetrics as Mock;
const mockIsOnBatteryPower = powerMonitor.isOnBatteryPower as unknown as Mock;
const mockGetCurrentThermalState = powerMonitor.getCurrentThermalState as unknown as Mock;
const mockPowerMonitorOn = powerMonitor.on as unknown as Mock;
const mockPowerMonitorRemoveListener = powerMonitor.removeListener as unknown as Mock;

interface MockPtyClient {
  setResourceProfile: Mock;
  getAllTerminalsAsync: Mock;
}

interface MockWorkspaceClient {
  updateMonitorConfig: Mock;
  getAllStatesAsync: Mock;
}

function makeActiveAgentTerminals(count: number): Array<Record<string, unknown>> {
  const terminals: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i += 1) {
    terminals.push({
      id: `t-${i}`,
      agentState: "working",
      detectedAgentId: "claude",
      isTrashed: false,
    });
  }
  return terminals;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

interface MockHibernationService {
  setMemoryPressureThresholdMs: Mock;
}

interface MockProjectStatsService {
  updatePollInterval: Mock;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeMetric(privateMb: number): Electron.ProcessMetric {
  return {
    pid: privateMb,
    type: "Browser",
    creationTime: 1,
    cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
    memory: {
      workingSetSize: privateMb * 1024,
      peakWorkingSetSize: privateMb * 1024,
      privateBytes: privateMb * 1024,
    },
    sandboxed: false,
    integrityLevel: "untrusted",
  } as unknown as Electron.ProcessMetric;
}

function createDeps(overrides?: Partial<ResourceProfileDeps>): {
  deps: ResourceProfileDeps;
  workspace: MockWorkspaceClient;
  pty: MockPtyClient;
  hibernation: MockHibernationService;
  stats: MockProjectStatsService;
} {
  const pty: MockPtyClient = {
    setResourceProfile: vi.fn(),
    getAllTerminalsAsync: vi.fn().mockResolvedValue([]),
  };
  const workspace: MockWorkspaceClient = {
    updateMonitorConfig: vi.fn(),
    getAllStatesAsync: vi.fn().mockResolvedValue([]),
  };
  const hibernation: MockHibernationService = {
    setMemoryPressureThresholdMs: vi.fn(),
  };
  const stats: MockProjectStatsService = {
    updatePollInterval: vi.fn(),
  };

  return {
    deps: {
      getPtyClient: () => pty as unknown as PtyClient,
      getWorkspaceClient: () => workspace as unknown as WorkspaceClient,
      getHibernationService: () => hibernation as unknown as HibernationService,
      getAllProjectViewManagers: () => [],
      getProjectStatsService: () => stats as unknown as ProjectStatsService,
      // Models the RAM-tier default (effectiveCachedProjectViews never returns 1).
      getUserCachedViewLimit: () => 2,
      ...overrides,
    },
    workspace,
    pty,
    hibernation,
    stats,
  };
}

function setLag(p99Ms: number, utilization: number, maxMs?: number): void {
  lagState.p99Nanoseconds = p99Ms * 1_000_000;
  // Default max to p99 so existing tests stay realistic (max ≥ p99 always);
  // tests that need to discriminate pass an explicit value.
  lagState.maxNanoseconds = (maxMs ?? p99Ms) * 1_000_000;
  lagState.utilization = utilization;
}

describe("ResourceProfileService adversarial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_830_001);
    vi.clearAllMocks();
    // Pin total RAM so MB-based test values cross the intended threshold bands
    // regardless of the CI host's actual memory.
    vi.spyOn(os, "totalmem").mockReturnValue(EIGHT_GB);
    // Module-level snapshot cache would otherwise serve a previous test's
    // mocked metrics within the TTL window.
    resetAppMetricsSnapshotForTesting();
    mockGetAppMetrics.mockReturnValue([]);
    mockIsOnBatteryPower.mockReturnValue(false);
    mockGetCurrentThermalState.mockReturnValue("unknown" as const);
    setLag(0, 0);
    lagState.resetCount = 0;
    lagState.maxNanoseconds = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("getSnapshot (#10500)", () => {
    function findPowerHandler(event: string): ((details?: unknown) => void) | undefined {
      return mockPowerMonitorOn.mock.calls.find((call: unknown[]) => call[0] === event)?.[1] as
        ((details?: unknown) => void) | undefined;
    }

    it("reflects battery, thermal, and speed-limit transitions via power events", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      const before = service.getSnapshot();
      expect(before.isOnBattery).toBe(false);
      expect(before.lagPressureActive).toBe(false);

      findPowerHandler("on-battery")!();
      findPowerHandler("thermal-state-change")!({ state: "serious" });
      findPowerHandler("speed-limit-change")!({ limit: 50 });

      const after = service.getSnapshot();
      expect(after.isOnBattery).toBe(true);
      expect(after.thermalState).toBe("serious");
      expect(after.speedLimit).toBe(50);
      // Power-only events must not flip the lag-pressure signal.
      expect(after.lagPressureActive).toBe(false);

      findPowerHandler("on-ac")!();
      expect(service.getSnapshot().isOnBattery).toBe(false);

      service.stop();
    });
  });

  it("does not thrash profiles when pressure oscillates around the hysteresis boundary", () => {
    const { deps } = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    const onBatteryHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-battery"
    )?.[1] as (() => void) | undefined;
    const onAcHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1] as (() => void) | undefined;

    vi.advanceTimersByTime(60_000);

    const oscillatingSignals = [
      { metrics: [makeMetric(1300)], battery: "on" as const },
      { metrics: [makeMetric(200)], battery: "off" as const },
      { metrics: [makeMetric(1300)], battery: "on" as const },
      { metrics: [makeMetric(200)], battery: "off" as const },
      { metrics: [makeMetric(900)], battery: "off" as const },
      { metrics: [makeMetric(200)], battery: "off" as const },
    ];

    for (const signal of oscillatingSignals) {
      mockGetAppMetrics.mockReturnValue(signal.metrics);
      if (signal.battery === "on") {
        onBatteryHandler!();
      } else {
        onAcHandler!();
      }
      vi.advanceTimersByTime(30_000);
      expect(service.getProfile()).toBe("balanced");
    }

    service.stop();
  });

  it("ignores an in-flight getAllTerminalsAsync resolution after stop", async () => {
    const pendingTerminals = deferred<Array<Record<string, unknown>>>();
    const { deps, pty } = createDeps();
    pty.getAllTerminalsAsync.mockReturnValueOnce(pendingTerminals.promise);

    const service = new ResourceProfileService(deps);
    service.start();
    service.stop();

    pendingTerminals.resolve(makeActiveAgentTerminals(20));
    await pendingTerminals.promise;
    await Promise.resolve();

    const internals = service as unknown as { cachedActiveAgentCount: number };
    expect(internals.cachedActiveAgentCount).toBe(0);
  });

  it("clears pending evaluation timers on stop", () => {
    const { deps, workspace, pty, hibernation } = createDeps();
    const service = new ResourceProfileService(deps);

    service.start();
    service.stop();

    mockGetAppMetrics.mockReturnValue([makeMetric(1300)]);
    mockIsOnBatteryPower.mockReturnValue(true);

    vi.advanceTimersByTime(5 * 30_000);

    expect(service.getProfile()).toBe("balanced");
    expect(workspace.updateMonitorConfig).not.toHaveBeenCalled();
    expect(pty.setResourceProfile).not.toHaveBeenCalled();
    expect(hibernation.setMemoryPressureThresholdMs).not.toHaveBeenCalled();
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });

  it("prefers the most constrained profile when memory and fleet pressure spike together", async () => {
    const { deps, pty } = createDeps();
    pty.getAllTerminalsAsync.mockResolvedValue(makeActiveAgentTerminals(9));
    const service = new ResourceProfileService(deps);

    service.start();
    await flushAsync();

    mockGetAppMetrics.mockReturnValue([makeMetric(1300)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);

    // HIGH memory (+2) + 9 agents (+1 at FLEET_COUNT_HIGH) = 3 => efficiency
    expect(service.getProfile()).toBe("efficiency");
    service.stop();
  });

  it("stop before start does not throw (removeListener is no-op)", () => {
    const { deps } = createDeps();
    const service = new ResourceProfileService(deps);

    // stop() without start() -> removeListener on unregistered handlers is safe
    expect(() => service.stop()).not.toThrow();
  });

  it("start after stop re-registers listeners", () => {
    const { deps } = createDeps();
    const service = new ResourceProfileService(deps);

    service.start();
    service.stop();

    mockPowerMonitorOn.mockClear();
    mockPowerMonitorRemoveListener.mockClear();

    service.start();

    expect(mockPowerMonitorOn).toHaveBeenCalledWith("thermal-state-change", expect.any(Function));
    expect(mockPowerMonitorOn).toHaveBeenCalledWith("speed-limit-change", expect.any(Function));
    expect(mockPowerMonitorOn).toHaveBeenCalledWith("on-battery", expect.any(Function));
    expect(mockPowerMonitorOn).toHaveBeenCalledWith("on-ac", expect.any(Function));

    service.stop();
  });

  it("does not register listeners twice on double start", () => {
    const { deps } = createDeps();
    const service = new ResourceProfileService(deps);

    service.start();
    const firstCallCount = mockPowerMonitorOn.mock.calls.length;
    service.start();

    expect(mockPowerMonitorOn).toHaveBeenCalledTimes(firstCallCount);

    service.stop();
  });

  it("thermal and speed-limit signals combine with active-agent count for efficiency", async () => {
    const { deps, pty } = createDeps();
    pty.getAllTerminalsAsync.mockResolvedValue(makeActiveAgentTerminals(9));
    const service = new ResourceProfileService(deps);

    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();
    await flushAsync();

    // Low memory (0) + battery (+1) + thermal serious (+1) + 9 agents (+1) = 3 => efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric(200)]);
    (service as unknown as { thermalState: string }).thermalState = "serious";

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("speed limit 0 (fully clamped) + high memory triggers efficiency without battery", () => {
    const { deps } = createDeps();
    const service = new ResourceProfileService(deps);

    service.start();

    // High memory (+2) + speed limit 0 (+2) = 4 => efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric(1300)]);
    mockIsOnBatteryPower.mockReturnValue(false);
    (service as unknown as { speedLimit: number }).speedLimit = 0;

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  describe("event-loop lag", () => {
    it("drops to efficiency on sustained lag without waiting for the 30s eval", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // No memory/battery/thermal pressure — only lag is the trigger.
      mockGetAppMetrics.mockReturnValue([]);
      mockIsOnBatteryPower.mockReturnValue(false);

      setLag(300, 0.85);
      // Two 5s ticks satisfy the 10s sustained-entry requirement.
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("balanced");
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");

      service.stop();
    });

    it("lag-triggered efficiency entry does not clamp cached view limit", () => {
      // Lag triggers efficiency directly from sampleLag(), bypassing
      // computeTargetProfile(). Efficiency entry never clamps cached views
      // regardless of trigger — only setEfficiencyFreeze(true) runs (freezing
      // the renderers suppresses the CPU wake-ups that lag pressure is about).
      const pvm = {
        setCachedViewLimit: vi.fn(),
        setLowMemoryFreeThresholdMb: vi.fn(),
        setEfficiencyFreeze: vi.fn(),
      };
      const { deps } = createDeps({
        getAllProjectViewManagers: () =>
          [pvm] as unknown as ReturnType<ResourceProfileDeps["getAllProjectViewManagers"]>,
      });
      const service = new ResourceProfileService(deps);
      service.start();

      mockGetAppMetrics.mockReturnValue([]);
      mockIsOnBatteryPower.mockReturnValue(false);

      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");

      expect(pvm.setCachedViewLimit).not.toHaveBeenCalled();
      expect(pvm.setEfficiencyFreeze).toHaveBeenCalledWith(true);

      service.stop();
    });

    it("memory-pressure efficiency entry freezes but never destroys cached views", () => {
      // Even when memory pressure drives efficiency, entry must not clamp the
      // cached-view limit — destruction is owned solely by PVM's evictStaleViews
      // floor under genuine low free RAM. This keeps the working set warm and
      // avoids cold-start storms on rapid project switching (#10742).
      const pvm = {
        setCachedViewLimit: vi.fn(),
        setLowMemoryFreeThresholdMb: vi.fn(),
        setEfficiencyFreeze: vi.fn(),
      };
      const { deps } = createDeps({
        getAllProjectViewManagers: () =>
          [pvm] as unknown as ReturnType<ResourceProfileDeps["getAllProjectViewManagers"]>,
        getUserCachedViewLimit: () => 3,
      });
      const service = new ResourceProfileService(deps);
      mockIsOnBatteryPower.mockReturnValue(true);
      service.start();

      // Drive into efficiency via memory + battery (high memory contribution).
      mockGetAppMetrics.mockReturnValue([makeMetric(1300)]);
      vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("efficiency");

      expect(pvm.setCachedViewLimit).not.toHaveBeenCalled();
      expect(pvm.setEfficiencyFreeze).toHaveBeenLastCalledWith(true);

      service.stop();
    });

    it("does not enter degraded mode on an isolated lag spike", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      setLag(400, 0.9);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("balanced");

      // Single clean tick resets the entry counter.
      setLag(50, 0.2);
      vi.advanceTimersByTime(5_000);

      // Another spike — should NOT trigger immediately because the counter reset.
      setLag(400, 0.9);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("balanced");

      service.stop();
    });

    it("AND-gates with ELU — high lag with low utilization is treated as a GC pause", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // p99 high, ELU low → suspected GC; do not enter degraded mode.
      setLag(400, 0.3);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("balanced");

      service.stop();
    });

    it("does not retrigger applyProfile when already at efficiency", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      mockIsOnBatteryPower.mockReturnValue(true);
      service.start();

      // Drive into efficiency via memory + battery first.
      mockGetAppMetrics.mockReturnValue([makeMetric(1300)]);
      vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("efficiency");

      const broadcastsBefore = (broadcastToRenderer as Mock).mock.calls.length;

      // Now lag spikes too — should NOT re-broadcast or reapply.
      setLag(400, 0.9);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);

      expect(service.getProfile()).toBe("efficiency");
      expect((broadcastToRenderer as Mock).mock.calls.length).toBe(broadcastsBefore);

      service.stop();
    });

    it("recovers after 45s of clean p99 readings", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Enter degraded.
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");
      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(true);

      // Nine clean 5s windows = 45s sustained recovery.
      setLag(50, 0.1);
      for (let i = 0; i < 9; i++) {
        vi.advanceTimersByTime(5_000);
      }

      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(false);

      service.stop();
    });

    it("exits via sliding window when 7 of 9 samples are clean", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Enter degraded.
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(true);

      // Push samples through the 9-sample window: 2 noisy + 7 clean,
      // ending with the 7th clean sample making the window 7-of-9 clean.
      const samples: Array<{ p99: number; util: number }> = [
        { p99: 200, util: 0.5 }, // noisy (above exit threshold)
        { p99: 50, util: 0.1 }, // clean
        { p99: 50, util: 0.1 }, // clean
        { p99: 200, util: 0.5 }, // noisy
        { p99: 50, util: 0.1 }, // clean
        { p99: 50, util: 0.1 }, // clean
        { p99: 50, util: 0.1 }, // clean
        { p99: 50, util: 0.1 }, // clean
        { p99: 50, util: 0.1 }, // clean — window now contains 7 clean / 2 noisy
      ];
      for (const s of samples) {
        setLag(s.p99, s.util);
        vi.advanceTimersByTime(5_000);
      }

      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(false);

      service.stop();
    });

    it("does not exit when only 6 of 9 samples are clean", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Enter degraded.
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(true);

      // 3 noisy + 6 clean = below the 7-of-9 threshold.
      const samples: Array<{ p99: number; util: number }> = [
        { p99: 200, util: 0.5 }, // noisy
        { p99: 50, util: 0.1 }, // clean
        { p99: 200, util: 0.5 }, // noisy
        { p99: 50, util: 0.1 }, // clean
        { p99: 200, util: 0.5 }, // noisy
        { p99: 50, util: 0.1 }, // clean
        { p99: 50, util: 0.1 }, // clean
        { p99: 50, util: 0.1 }, // clean
        { p99: 50, util: 0.1 }, // clean — window: 6 clean / 3 noisy
      ];
      for (const s of samples) {
        setLag(s.p99, s.util);
        vi.advanceTimersByTime(5_000);
      }

      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(true);

      service.stop();
    });

    it("does not force-clear before the hard cap elapses", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Enter degraded.
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);

      // Sustain moderate lag below the cap. After 115_000ms post-entry the
      // cap has NOT elapsed; the latch must still be active.
      setLag(400, 0.9);
      vi.advanceTimersByTime(115_000);

      const internals = service as unknown as { lagPressureActive: boolean };
      expect(internals.lagPressureActive).toBe(true);
      expect(logInfo).not.toHaveBeenCalledWith("event-loop-lag-force-cleared", expect.any(Object));

      service.stop();
    });

    it("force-clears the latch after the hard cap even with sustained lag", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Enter degraded.
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(true);

      // Keep lag in the moderate band (above exit, below escalation) so the
      // sliding window can never naturally clear it. The cap fires on the
      // first lag-sample tick where (now - lagPressureStartedAt) >= 120_000.
      // 120s lands exactly on the 5s-aligned cap-fire tick; one extra 5s tick
      // confirms the post-cap state has no immediate re-entry yet (the
      // moderate entry path needs 2 consecutive bad samples).
      setLag(400, 0.9);
      vi.advanceTimersByTime(125_000);

      const internals = service as unknown as {
        lagPressureActive: boolean;
        lagEscalatedActive: boolean;
        lagPressureStartedAt: number | null;
        lagEnterTicks: number;
      };
      expect(internals.lagPressureActive).toBe(false);
      expect(internals.lagEscalatedActive).toBe(false);
      expect(internals.lagPressureStartedAt).toBeNull();
      // One bad tick after cap-fire increments lagEnterTicks; not yet 2.
      expect(internals.lagEnterTicks).toBe(1);

      expect(logInfo).toHaveBeenCalledWith(
        "event-loop-lag-force-cleared",
        expect.objectContaining({
          p99Ms: 400,
          maxMs: 400,
          durationMs: expect.any(Number),
        })
      );

      service.stop();
    });

    it("enters the latch on a single severe spike above 500ms", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // A single 5s window with p99 > LAG_ESCALATE_P99_MS (500) and high ELU
      // bypasses the 2-tick moderate entry path.
      setLag(600, 0.9);
      vi.advanceTimersByTime(5_000);

      const internals = service as unknown as {
        lagPressureActive: boolean;
        lagEscalatedActive: boolean;
      };
      expect(internals.lagPressureActive).toBe(true);
      expect(internals.lagEscalatedActive).toBe(true);
      expect(service.getProfile()).toBe("efficiency");

      expect(logInfo).toHaveBeenCalledWith(
        "event-loop-lag-detected",
        expect.objectContaining({ p99Ms: 600 })
      );
      expect(logInfo).toHaveBeenCalledWith(
        "event-loop-lag-escalated",
        expect.objectContaining({ p99Ms: 600 })
      );

      service.stop();
    });

    it("rejects a single severe spike when ELU is low (GC stall pattern)", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // p99 above escalation threshold but ELU low — suspected GC pause,
      // not genuine saturation. Must not trip the immediate-entry path.
      setLag(700, 0.3);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);

      const internals = service as unknown as { lagPressureActive: boolean };
      expect(internals.lagPressureActive).toBe(false);
      expect(service.getProfile()).toBe("balanced");

      service.stop();
    });

    it("escalates after one tick above 500ms while degraded", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Enter degraded at 300ms first.
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect((service as unknown as { lagEscalatedActive: boolean }).lagEscalatedActive).toBe(
        false
      );

      // Spike past 500ms → escalation flag flips.
      setLag(600, 0.9);
      vi.advanceTimersByTime(5_000);
      expect((service as unknown as { lagEscalatedActive: boolean }).lagEscalatedActive).toBe(true);

      service.stop();
    });

    it("escalation skips refreshFleetState", async () => {
      const { deps, pty } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // start() invokes refreshFleetState once unconditionally.
      const initialCalls = pty.getAllTerminalsAsync.mock.calls.length;

      // Enter degraded.
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);

      // Escalate.
      setLag(600, 0.9);
      vi.advanceTimersByTime(5_000);
      expect((service as unknown as { lagEscalatedActive: boolean }).lagEscalatedActive).toBe(true);

      // The next 30s eval should NOT call refreshFleetState (no new IPC fetch).
      vi.advanceTimersByTime(30_000);
      expect(pty.getAllTerminalsAsync).toHaveBeenCalledTimes(initialCalls);

      service.stop();
    });

    it("lag-pressure floor blocks the slow scoring loop from upgrading out of efficiency", () => {
      const { deps, workspace } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Enter degraded via lag, with no other pressure signals.
      mockGetAppMetrics.mockReturnValue([]);
      mockIsOnBatteryPower.mockReturnValue(false);
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");

      // Reset broadcast counter to track only post-degraded broadcasts.
      (broadcastToRenderer as Mock).mockClear();
      workspace.updateMonitorConfig.mockClear();

      // Lag stays high (not in exit range). Advance 60s of eval ticks — even
      // though computeTargetProfile() now reports score 0 → "performance",
      // the floor must hold.
      setLag(300, 0.85);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);

      expect(service.getProfile()).toBe("efficiency");
      expect(broadcastToRenderer).not.toHaveBeenCalled();
      expect(workspace.updateMonitorConfig).not.toHaveBeenCalled();

      service.stop();
    });

    it("exit clears escalation state alongside pressure", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);

      setLag(600, 0.9);
      vi.advanceTimersByTime(5_000);
      expect((service as unknown as { lagEscalatedActive: boolean }).lagEscalatedActive).toBe(true);

      setLag(50, 0.1);
      for (let i = 0; i < 9; i++) {
        vi.advanceTimersByTime(5_000);
      }

      const internals = service as unknown as {
        lagPressureActive: boolean;
        lagEscalatedActive: boolean;
      };
      expect(internals.lagPressureActive).toBe(false);
      expect(internals.lagEscalatedActive).toBe(false);

      service.stop();
    });

    it("resets the histogram on every sample", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      const before = lagState.resetCount;
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(lagState.resetCount - before).toBe(3);

      service.stop();
    });

    it("entry log payload carries maxMs sourced from histogram.max, not p99", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // p99 = 300ms (entry threshold), max = 900ms (a single long block in
      // the window). Distinct values verify the implementation reads .max
      // rather than re-using percentile(99).
      setLag(300, 0.85, 900);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);

      expect(logInfo).toHaveBeenCalledWith(
        "event-loop-lag-detected",
        expect.objectContaining({ p99Ms: 300, maxMs: 900 })
      );

      service.stop();
    });

    it("escalation and clear log payloads carry maxMs", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Enter degraded — used to seed escalation, payload not asserted here.
      setLag(300, 0.85, 350);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);

      // Escalate with distinct max.
      setLag(600, 0.9, 1200);
      vi.advanceTimersByTime(5_000);
      expect(logInfo).toHaveBeenCalledWith(
        "event-loop-lag-escalated",
        expect.objectContaining({ p99Ms: 600, maxMs: 1200 })
      );

      // Recover with low p99 and a small residual max.
      setLag(50, 0.1, 80);
      for (let i = 0; i < 9; i++) {
        vi.advanceTimersByTime(5_000);
      }
      expect(logInfo).toHaveBeenCalledWith(
        "event-loop-lag-cleared",
        expect.objectContaining({ p99Ms: 50, maxMs: 80 })
      );

      service.stop();
    });

    it("entry thresholds are strict greater-than (boundary values do not trigger)", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Exactly at thresholds: p99 === 250 and util === 0.7. Neither satisfies `>`.
      setLag(250, 0.7);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("balanced");

      // p99 just over while util at boundary — still no entry.
      setLag(251, 0.7);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("balanced");

      // util just over while p99 at boundary — still no entry.
      setLag(250, 0.71);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("balanced");

      // Both strictly over → enters as expected.
      setLag(251, 0.71);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");

      service.stop();
    });

    it("normal scoring upgrades out of efficiency after lag recovery", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Drive into efficiency via lag.
      mockGetAppMetrics.mockReturnValue([]);
      mockIsOnBatteryPower.mockReturnValue(false);
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");

      // Recover.
      setLag(50, 0.1);
      for (let i = 0; i < 9; i++) {
        vi.advanceTimersByTime(5_000);
      }
      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(false);

      // From here, normal scoring should drive back up. While lag was active,
      // evaluate() returned early at the lag floor without exiting warmup,
      // so tickCount has only crossed the floor branch. Drive past the
      // 2-warmup ticks + 90s upgrade hold combination.
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      expect(service.getProfile()).toBe("performance");

      service.stop();
    });

    it("lag-only efficiency entry still unfreezes and restores limit on exit", () => {
      // Lag enters efficiency without clamping (no memory contribution). On
      // exit, the always-unconditional restore branch must still fire so
      // renderers don't stay frozen and the user-configured limit is reasserted
      // (even though entry never clamped — PVM's own evictStaleViews floor may
      // have clamped during the efficiency window).
      const pvm = {
        setCachedViewLimit: vi.fn(),
        setLowMemoryFreeThresholdMb: vi.fn(),
        setEfficiencyFreeze: vi.fn(),
      };
      const { deps } = createDeps({
        getAllProjectViewManagers: () =>
          [pvm] as unknown as ReturnType<ResourceProfileDeps["getAllProjectViewManagers"]>,
        getUserCachedViewLimit: () => 4,
      });
      const service = new ResourceProfileService(deps);
      service.start();

      mockGetAppMetrics.mockReturnValue([]);
      mockIsOnBatteryPower.mockReturnValue(false);
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");
      expect(pvm.setCachedViewLimit).not.toHaveBeenCalled();
      expect(pvm.setEfficiencyFreeze).toHaveBeenLastCalledWith(true);

      // Recover from lag.
      setLag(50, 0.1);
      for (let i = 0; i < 9; i++) {
        vi.advanceTimersByTime(5_000);
      }

      // Drive normal scoring back up.
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      expect(service.getProfile()).toBe("performance");

      expect(pvm.setEfficiencyFreeze).toHaveBeenLastCalledWith(false);
      expect(pvm.setCachedViewLimit).toHaveBeenLastCalledWith(4);

      service.stop();
    });

    it("getCurrentThermalState throwing does not crash start", () => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      mockGetCurrentThermalState.mockImplementation(() => {
        throw new Error("thermal unavailable");
      });

      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      expect(() => service.start()).not.toThrow();

      const internals = service as unknown as { thermalState: string };
      expect(internals.thermalState).toBe("unknown");

      service.stop();
    });

    it("isOnBatteryPower throwing during priming does not crash start", () => {
      mockIsOnBatteryPower.mockImplementation(() => {
        throw new Error("battery unavailable");
      });

      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      expect(() => service.start()).not.toThrow();

      const internals = service as unknown as { isOnBattery: boolean };
      expect(internals.isOnBattery).toBe(false);

      service.stop();
    });

    it("cold start with thermal critical contributes to first evaluation", () => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      mockGetCurrentThermalState.mockReturnValue("critical" as const);
      mockIsOnBatteryPower.mockReturnValue(true);

      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Low memory (0) + battery (+1) + thermal critical (+2) = 3 => efficiency
      // Without thermal priming the score would be 1 => balanced
      mockGetAppMetrics.mockReturnValue([makeMetric(200)]);
      vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("efficiency");

      service.stop();
    });

    it("stop/start resets tickCount and enforces warmup on restart", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);

      service.start();
      // Advance past warmup
      vi.advanceTimersByTime(60_000);
      expect((service as unknown as { tickCount: number }).tickCount).toBeGreaterThan(0);

      service.stop();
      service.start();

      expect((service as unknown as { tickCount: number }).tickCount).toBe(0);
      // High pressure signals should NOT transition during warmup after restart
      mockGetAppMetrics.mockReturnValue([makeMetric(1300)]);
      mockIsOnBatteryPower.mockReturnValue(true);
      vi.advanceTimersByTime(60_000);
      expect(service.getProfile()).toBe("balanced");

      service.stop();
    });

    it("isOnBatteryPower not called on evaluation ticks", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();
      const callsAfterStart = mockIsOnBatteryPower.mock.calls.length;

      // Several eval ticks
      vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
      expect(mockIsOnBatteryPower).toHaveBeenCalledTimes(callsAfterStart);

      service.stop();
    });

    it("malformed thermal event payload preserves last valid state", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      const thermalHandler = mockPowerMonitorOn.mock.calls.find(
        (call: string[]) => call[0] === "thermal-state-change"
      )?.[1] as ((details: { state: string }) => void) | undefined;
      expect(thermalHandler).toBeDefined();

      // Set a known-good state first
      thermalHandler!({ state: "critical" });
      expect((service as unknown as { thermalState: string }).thermalState).toBe("critical");

      // Bogus state value must not throw and must preserve last valid state
      expect(() => thermalHandler!({ state: "bogus" })).not.toThrow();
      expect((service as unknown as { thermalState: string }).thermalState).toBe("critical");

      service.stop();
    });

    it("stop tears down the lag timer and histogram", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      service.stop();

      // After stop, advancing timers must not change state or invoke histogram reset.
      const before = lagState.resetCount;
      setLag(600, 0.9);
      vi.advanceTimersByTime(60_000);
      expect(lagState.resetCount).toBe(before);

      const internals = service as unknown as {
        lagInterval: NodeJS.Timeout | null;
        lagHistogram: unknown;
      };
      expect(internals.lagInterval).toBeNull();
      expect(internals.lagHistogram).toBeNull();
    });
  });

  describe("interactive override (symptom B — keep active TUI scroll off efficiency)", () => {
    it("lifts lag-driven efficiency back to balanced immediately on request", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();
      mockGetAppMetrics.mockReturnValue([]);
      mockIsOnBatteryPower.mockReturnValue(false);

      setLag(300, 0.85); // sustained event-loop lag
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");

      service.requestInteractiveOverride(2_000);
      // The hold lifts out of efficiency synchronously (the win: restores the
      // pty-host's 16ms port-batch delay instead of efficiency's 40ms).
      expect(service.getProfile()).toBe("balanced");

      service.stop();
    });

    it("blocks lag from (re-)entering efficiency while interaction is ongoing", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();
      mockGetAppMetrics.mockReturnValue([]);
      mockIsOnBatteryPower.mockReturnValue(false);

      setLag(300, 0.85); // sustained lag that would normally latch efficiency in ~10s
      // Continuous interaction re-requests the override well within its window
      // (mirrors the renderer's throttled re-requests while scrolling). Drive 20s
      // of lag — well past the sustained-entry threshold — and assert efficiency
      // is never entered.
      for (let elapsed = 0; elapsed < 20_000; elapsed += 1_000) {
        service.requestInteractiveOverride(2_000);
        vi.advanceTimersByTime(1_000);
        expect(service.getProfile()).not.toBe("efficiency");
      }

      service.stop();
    });

    it("resumes normal lag-driven efficiency once interaction stops and the hold expires", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();
      mockGetAppMetrics.mockReturnValue([]);
      mockIsOnBatteryPower.mockReturnValue(false);

      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");

      service.requestInteractiveOverride(2_000);
      expect(service.getProfile()).toBe("balanced");

      // Interaction stopped — no further re-requests. Sustained lag continues, so
      // after the hold expires the latch re-engages on the normal cadence.
      vi.advanceTimersByTime(20_000);
      expect(service.getProfile()).toBe("efficiency");

      service.stop();
    });

    it("caps the hold so a runaway caller can't pin the profile off efficiency", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();
      mockGetAppMetrics.mockReturnValue([]);
      mockIsOnBatteryPower.mockReturnValue(false);

      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");

      // Request an absurdly long hold ONCE; it is clamped, so sustained lag
      // re-latches efficiency well before the requested duration elapses.
      service.requestInteractiveOverride(10 * 60_000);
      expect(service.getProfile()).toBe("balanced");
      vi.advanceTimersByTime(20_000);
      expect(service.getProfile()).toBe("efficiency");

      service.stop();
    });

    it("ignores a non-finite duration without poisoning later valid requests", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();
      mockGetAppMetrics.mockReturnValue([]);
      mockIsOnBatteryPower.mockReturnValue(false);

      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");

      // A malformed call (NaN) must no-op, not brick the deadline — NaN would
      // make `Date.now() < until` and `Math.max(until, ...)` permanently false.
      service.requestInteractiveOverride(Number.NaN);
      expect(service.getProfile()).toBe("efficiency"); // not lifted by garbage

      // A subsequent VALID request still works (the deadline wasn't poisoned).
      service.requestInteractiveOverride(2_000);
      expect(service.getProfile()).toBe("balanced");

      service.stop();
    });

    it("does not strand the lag latch while blocking entry from balanced", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();
      mockGetAppMetrics.mockReturnValue([]);
      mockIsOnBatteryPower.mockReturnValue(false);

      setLag(300, 0.85); // sustained lag throughout
      for (let elapsed = 0; elapsed < 15_000; elapsed += 1_000) {
        service.requestInteractiveOverride(2_000);
        vi.advanceTimersByTime(1_000);
      }
      // Entry was blocked, AND the latch flag itself was never set — so when the
      // override lapses, detection resumes from a clean state rather than a
      // held-but-not-applied latch.
      expect(service.getProfile()).not.toBe("efficiency");
      expect(service.getSnapshot().lagPressureActive).toBe(false);

      service.stop();
    });
  });

  describe("active-agent count filtering", () => {
    it("counts terminals across all ACTIVE_AGENT_STATES (working, waiting, directing)", async () => {
      const { deps, pty } = createDeps();
      pty.getAllTerminalsAsync.mockResolvedValue([
        { id: "a", agentState: "working", detectedAgentId: "claude" },
        { id: "b", agentState: "waiting", detectedAgentId: "gemini" },
        { id: "c", agentState: "directing", detectedAgentId: "claude" },
        { id: "d", agentState: "working", detectedAgentId: "codex" },
        { id: "e", agentState: "waiting", detectedAgentId: "claude" },
        { id: "f", agentState: "directing", detectedAgentId: "claude" },
        { id: "g", agentState: "working", detectedAgentId: "claude" },
        { id: "h", agentState: "working", detectedAgentId: "claude" },
      ]);
      const service = new ResourceProfileService(deps);
      service.start();
      await flushAsync();

      // 8 active agents → +1; no other pressure → balanced
      mockGetAppMetrics.mockReturnValue([makeMetric(200)]);
      mockIsOnBatteryPower.mockReturnValue(false);

      vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("balanced");

      service.stop();
    });

    it("accepts launchAgentId before runtime detection ever fired", async () => {
      const { deps, pty } = createDeps();
      // Cold-launched agents before first state-machine detection. Identity
      // comes from launchAgentId; everDetectedAgent is undefined (false-ish).
      pty.getAllTerminalsAsync.mockResolvedValue(
        Array.from({ length: 24 }, (_, i) => ({
          id: `launch-${i}`,
          agentState: "working",
          launchAgentId: "claude",
        }))
      );
      const service = new ResourceProfileService(deps);
      service.start();
      await flushAsync();

      // 24 agents alone (+3) → efficiency
      mockGetAppMetrics.mockReturnValue([makeMetric(200)]);
      mockIsOnBatteryPower.mockReturnValue(false);

      vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("efficiency");

      service.stop();
    });

    it("excludes terminals whose agent exited (everDetectedAgent=true, no detectedAgentId)", async () => {
      const { deps, pty } = createDeps();
      // Residual shell after agent exit: everDetectedAgent sticky, detectedAgentId cleared.
      // These would falsely inflate the fleet count if not filtered.
      pty.getAllTerminalsAsync.mockResolvedValue(
        Array.from({ length: 24 }, (_, i) => ({
          id: `exit-${i}`,
          agentState: "working",
          launchAgentId: "claude",
          everDetectedAgent: true,
          // no detectedAgentId
        }))
      );
      const service = new ResourceProfileService(deps);
      service.start();
      await flushAsync();

      mockGetAppMetrics.mockReturnValue([makeMetric(200)]);
      mockIsOnBatteryPower.mockReturnValue(false);

      // Zero qualifying agents → performance (after upgrade hold)
      vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("performance");

      service.stop();
    });

    it("resets fleet count to 0 when PtyClient returns [] under IPC failure", async () => {
      // Documents the real production behavior: PtyClient.getAllTerminalsAsync
      // catches its own IPC failures and resolves [], so the service's cache
      // resets to 0. The 90s upgrade hold prevents transient drops from
      // immediately upgrading the profile.
      const { deps, pty } = createDeps();
      pty.getAllTerminalsAsync.mockResolvedValueOnce(makeActiveAgentTerminals(24));
      const service = new ResourceProfileService(deps);
      service.start();
      await flushAsync();
      expect(
        (service as unknown as { cachedActiveAgentCount: number }).cachedActiveAgentCount
      ).toBe(24);

      // Subsequent refreshes fail in the PtyClient layer — surfaced as [].
      pty.getAllTerminalsAsync.mockResolvedValue([]);

      vi.advanceTimersByTime(30_000);
      await flushAsync();
      expect(
        (service as unknown as { cachedActiveAgentCount: number }).cachedActiveAgentCount
      ).toBe(0);

      service.stop();
    });

    it("excludes terminals with hasPty=false from the active-agent count", async () => {
      const { deps, pty } = createDeps();
      // 24 terminals that look 'live' by every other signal but their PTY exited.
      // ProjectStatsService applies the same hasPty filter; without it the
      // service would lock to efficiency indefinitely on a fleet that exited
      // without being trashed.
      pty.getAllTerminalsAsync.mockResolvedValue(
        Array.from({ length: 24 }, (_, i) => ({
          id: `orphan-${i}`,
          agentState: "working",
          detectedAgentId: "claude",
          hasPty: false,
        }))
      );
      const service = new ResourceProfileService(deps);
      service.start();
      await flushAsync();

      mockGetAppMetrics.mockReturnValue([makeMetric(200)]);
      mockIsOnBatteryPower.mockReturnValue(false);

      vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("performance");

      service.stop();
    });

    it("ignores a stale getAllTerminalsAsync result from a previous lifecycle", async () => {
      const pendingTerminals = deferred<Array<Record<string, unknown>>>();
      const { deps, pty } = createDeps();
      // The very first call (during the first start()) is the slow one.
      pty.getAllTerminalsAsync.mockReturnValueOnce(pendingTerminals.promise);
      // Calls after that resolve immediately with [] (fresh lifecycle: no fleet).
      pty.getAllTerminalsAsync.mockResolvedValue([]);

      const service = new ResourceProfileService(deps);
      service.start();
      service.stop();
      service.start();
      // Drain the fresh-lifecycle refresh to set cachedActiveAgentCount = 0.
      await flushAsync();

      // The slow promise from lifecycle #1 finally resolves with a huge fleet.
      // Without the generation guard, this would write 24 into the new
      // lifecycle's cache.
      pendingTerminals.resolve(makeActiveAgentTerminals(24));
      await pendingTerminals.promise;
      await flushAsync();

      const internals = service as unknown as { cachedActiveAgentCount: number };
      expect(internals.cachedActiveAgentCount).toBe(0);

      service.stop();
    });

    it("zeros cachedActiveAgentCount on restart even if the prior refresh succeeded", async () => {
      const { deps, pty } = createDeps();
      pty.getAllTerminalsAsync.mockResolvedValueOnce(makeActiveAgentTerminals(24));
      const service = new ResourceProfileService(deps);
      service.start();
      await flushAsync();
      expect(
        (service as unknown as { cachedActiveAgentCount: number }).cachedActiveAgentCount
      ).toBe(24);

      // Stop, then keep the next refresh deferred so it can't immediately
      // overwrite the cache. The restart itself must reset the count.
      service.stop();
      const pending = deferred<Array<Record<string, unknown>>>();
      pty.getAllTerminalsAsync.mockReturnValue(pending.promise);

      service.start();
      // No flushAsync — the new refresh hasn't resolved yet. The reset must
      // come from start() itself, not from the refresh result.
      expect(
        (service as unknown as { cachedActiveAgentCount: number }).cachedActiveAgentCount
      ).toBe(0);

      pending.resolve([]);
      service.stop();
    });
  });
});
