import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import type { WorkspaceClient } from "../WorkspaceClient.js";
import type { HibernationService } from "../HibernationService.js";
import type { ProjectStatsService } from "../ProjectStatsService.js";

const lagState = vi.hoisted(() => ({
  // Returned by histogram.percentile(99) — nanoseconds.
  p99Nanoseconds: 0,
  utilization: 0,
  resetCount: 0,
}));

vi.mock("electron", () => ({
  app: {
    getAppMetrics: vi.fn(() => []),
  },
  powerMonitor: {
    isOnBatteryPower: vi.fn(() => false),
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
import { ResourceProfileService, type ResourceProfileDeps } from "../ResourceProfileService.js";

const EIGHT_GB = 8 * 1024 * 1024 * 1024;

const mockGetAppMetrics = app.getAppMetrics as Mock;
const mockIsOnBatteryPower = powerMonitor.isOnBatteryPower as unknown as Mock;
const mockPowerMonitorOn = powerMonitor.on as unknown as Mock;
const mockPowerMonitorRemoveListener = powerMonitor.removeListener as unknown as Mock;

interface MockPtyClient {
  setResourceProfile: Mock;
}

interface MockWorkspaceClient {
  updateMonitorConfig: Mock;
  getAllStatesAsync: Mock;
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
      getProjectViewManager: () => null,
      getProjectStatsService: () => stats as unknown as ProjectStatsService,
      getUserCachedViewLimit: () => 1,
      ...overrides,
    },
    workspace,
    pty,
    hibernation,
    stats,
  };
}

function setLag(p99Ms: number, utilization: number): void {
  lagState.p99Nanoseconds = p99Ms * 1_000_000;
  lagState.utilization = utilization;
}

describe("ResourceProfileService adversarial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Pin total RAM so MB-based test values cross the intended threshold bands
    // regardless of the CI host's actual memory.
    vi.spyOn(os, "totalmem").mockReturnValue(EIGHT_GB);
    mockGetAppMetrics.mockReturnValue([]);
    mockIsOnBatteryPower.mockReturnValue(false);
    setLag(0, 0);
    lagState.resetCount = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not thrash profiles when pressure oscillates around the hysteresis boundary", () => {
    const { deps } = createDeps();
    const service = new ResourceProfileService(deps);

    service.start();

    vi.advanceTimersByTime(60_000);

    const oscillatingSignals = [
      { metrics: [makeMetric(1300)], battery: true },
      { metrics: [makeMetric(200)], battery: false },
      { metrics: [makeMetric(1300)], battery: true },
      { metrics: [makeMetric(200)], battery: false },
      { metrics: [makeMetric(900)], battery: false },
      { metrics: [makeMetric(200)], battery: false },
    ];

    for (const signal of oscillatingSignals) {
      mockGetAppMetrics.mockReturnValue(signal.metrics);
      mockIsOnBatteryPower.mockReturnValue(signal.battery);
      vi.advanceTimersByTime(30_000);
      expect(service.getProfile()).toBe("balanced");
    }

    service.stop();
  });

  it("ignores an in-flight getAllStatesAsync resolution after stop", async () => {
    const pendingStates = deferred<Array<{ id: string }>>();
    const { deps, workspace } = createDeps();
    workspace.getAllStatesAsync.mockReturnValueOnce(pendingStates.promise);

    const service = new ResourceProfileService(deps);
    service.start();
    service.stop();

    pendingStates.resolve([
      { id: "wt-1" },
      { id: "wt-2" },
      { id: "wt-3" },
      { id: "wt-4" },
      { id: "wt-5" },
      { id: "wt-6" },
      { id: "wt-7" },
      { id: "wt-8" },
      { id: "wt-9" },
    ]);
    await pendingStates.promise;
    await Promise.resolve();

    const internals = service as unknown as { cachedWorktreeCount: number };
    expect(internals.cachedWorktreeCount).toBe(0);
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

  it("prefers the most constrained profile when memory and worktree pressure spike together", () => {
    const { deps } = createDeps();
    const service = new ResourceProfileService(deps);

    service.setWorktreeCount(9);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric(1300)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);

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

  it("thermal and speed-limit signals combine with worktree count for efficiency", () => {
    const { deps } = createDeps();
    const service = new ResourceProfileService(deps);

    service.setWorktreeCount(9);
    service.start();

    // Low memory (0) + battery (+1) + thermal serious (+1) + worktrees (+1) = 3 => efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric(200)]);
    mockIsOnBatteryPower.mockReturnValue(true);
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
      service.start();

      // Drive into efficiency via memory + battery first.
      mockGetAppMetrics.mockReturnValue([makeMetric(1300)]);
      mockIsOnBatteryPower.mockReturnValue(true);
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

    it("recovers after 30s of clean p99 readings", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Enter degraded.
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect(service.getProfile()).toBe("efficiency");
      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(true);

      // Six clean 5s windows = 30s sustained recovery.
      setLag(50, 0.1);
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(5_000);
      }

      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(false);

      service.stop();
    });

    it("a single non-clean tick resets the recovery counter", () => {
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Enter degraded.
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(true);

      // Five clean ticks (one short of the 6-tick threshold).
      setLag(50, 0.1);
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(5_000);
      }
      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(true);

      // One non-clean tick (above exit threshold) resets the counter.
      setLag(200, 0.5);
      vi.advanceTimersByTime(5_000);

      // Now five more clean ticks should still NOT recover (counter restarted).
      setLag(50, 0.1);
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(5_000);
      }
      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(true);

      // Sixth clean tick clears it.
      vi.advanceTimersByTime(5_000);
      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(false);

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

    it("escalation skips refreshWorktreeCount", async () => {
      const { deps, workspace } = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // start() invokes refreshWorktreeCount once unconditionally.
      const initialCalls = workspace.getAllStatesAsync.mock.calls.length;

      // Enter degraded.
      setLag(300, 0.85);
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);

      // Escalate.
      setLag(600, 0.9);
      vi.advanceTimersByTime(5_000);
      expect((service as unknown as { lagEscalatedActive: boolean }).lagEscalatedActive).toBe(true);

      // The next 30s eval should NOT call refreshWorktreeCount.
      vi.advanceTimersByTime(30_000);
      expect(workspace.getAllStatesAsync).toHaveBeenCalledTimes(initialCalls);

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
      for (let i = 0; i < 6; i++) {
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
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(5_000);
      }
      expect((service as unknown as { lagPressureActive: boolean }).lagPressureActive).toBe(false);

      // From here, normal scoring should drive back up. While lag was active,
      // evaluate() returned early at the lag floor without exiting warmup,
      // so tickCount has only crossed the floor branch. Drive past the
      // 2-warmup ticks + 60s upgrade hold combination.
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      expect(service.getProfile()).toBe("performance");

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
});
