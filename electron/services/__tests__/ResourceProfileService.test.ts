import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import type { WorkspaceClient } from "../WorkspaceClient.js";
import type { HibernationService } from "../HibernationService.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";
import type { ProjectStatsService } from "../ProjectStatsService.js";

// Mock electron modules before importing
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

// Neutral perf_hooks stub: returns zero lag and zero utilization, so the new
// 5s lag-monitor timer fires harmlessly inside fake-timer windows.
vi.mock("node:perf_hooks", () => ({
  monitorEventLoopDelay: () => ({
    enable: vi.fn(),
    disable: vi.fn(),
    percentile: () => 0,
    reset: vi.fn(),
    max: 0,
  }),
  performance: {
    eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),
  },
}));

import os from "os";
import { app, powerMonitor } from "electron";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { ResourceProfileService, type ResourceProfileDeps } from "../ResourceProfileService.js";
import { RESOURCE_PROFILE_CONFIGS } from "../../../shared/types/resourceProfile.js";
import { resetAppMetricsSnapshotForTesting } from "../../utils/appMetricsSnapshot.js";

const EIGHT_GB = 8 * 1024 * 1024 * 1024;

const mockGetAppMetrics = app.getAppMetrics as Mock;
const mockIsOnBatteryPower = powerMonitor.isOnBatteryPower as unknown as Mock;
const mockGetCurrentThermalState = powerMonitor.getCurrentThermalState as unknown as Mock;
const mockPowerMonitorOn = powerMonitor.on as unknown as Mock;
const mockPowerMonitorRemoveListener = powerMonitor.removeListener as unknown as Mock;

function makeMetric(type: string, privateMb: number): Electron.ProcessMetric {
  return {
    pid: Math.floor(Math.random() * 10000),
    type,
    creationTime: Date.now(),
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

// Simulates the actual macOS/Linux shape where privateBytes is reported as 0
// (the API field exists but is unpopulated outside Windows). Used to lock in
// the workingSetSize-only memory signal — a regression to `privateBytes ??
// workingSetSize` would silently treat these processes as zero-footprint.
function makeMetricMacShape(type: string, workingSetMb: number): Electron.ProcessMetric {
  return {
    pid: Math.floor(Math.random() * 10000),
    type,
    creationTime: Date.now(),
    cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
    memory: {
      workingSetSize: workingSetMb * 1024,
      peakWorkingSetSize: workingSetMb * 1024,
      privateBytes: 0,
    },
    sandboxed: false,
    integrityLevel: "untrusted",
  } as unknown as Electron.ProcessMetric;
}

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
  // The fleet refresh fires fire-and-forget promises inside the eval timer.
  // After advancing fake timers we need to drain the microtask queue so the
  // `.then(...)` writers commit `cachedActiveAgentCount` before computeTargetProfile
  // runs on the next tick.
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}
interface MockHibernationService {
  setMemoryPressureThresholdMs: Mock;
}
interface MockProjectViewManager {
  setCachedViewLimit: Mock;
  setLowMemoryFreeThresholdMb: Mock;
  setEfficiencyFreeze: Mock;
  setPaintGateTimeoutMs: Mock;
  setPaintGateHardTimeoutMs: Mock;
  setWarmPaintGateTimeoutMs: Mock;
  setWarmPaintGateHardTimeoutMs: Mock;
}
interface MockProjectStatsService {
  updatePollInterval: Mock;
}

function createDeps(overrides?: Partial<ResourceProfileDeps>): ResourceProfileDeps {
  const mockPtyClient: MockPtyClient = {
    setResourceProfile: vi.fn(),
    getAllTerminalsAsync: vi.fn().mockResolvedValue([]),
  };
  const mockWorkspaceClient: MockWorkspaceClient = {
    updateMonitorConfig: vi.fn(),
    getAllStatesAsync: vi.fn().mockResolvedValue([]),
  };
  const mockHibernationService: MockHibernationService = {
    setMemoryPressureThresholdMs: vi.fn(),
  };
  const mockProjectViewManager: MockProjectViewManager = {
    setCachedViewLimit: vi.fn(),
    setLowMemoryFreeThresholdMb: vi.fn(),
    setEfficiencyFreeze: vi.fn(),
    setPaintGateTimeoutMs: vi.fn(),
    setPaintGateHardTimeoutMs: vi.fn(),
    setWarmPaintGateTimeoutMs: vi.fn(),
    setWarmPaintGateHardTimeoutMs: vi.fn(),
  };
  const mockProjectStatsService: MockProjectStatsService = {
    updatePollInterval: vi.fn(),
  };

  return {
    getPtyClient: () => mockPtyClient as unknown as PtyClient,
    getWorkspaceClient: () => mockWorkspaceClient as unknown as WorkspaceClient,
    getHibernationService: () => mockHibernationService as unknown as HibernationService,
    getAllProjectViewManagers: () => [mockProjectViewManager as unknown as ProjectViewManager],
    getProjectStatsService: () => mockProjectStatsService as unknown as ProjectStatsService,
    getUserCachedViewLimit: () => 2,
    ...overrides,
  };
}

function makeMockPvm(): MockProjectViewManager {
  return {
    setCachedViewLimit: vi.fn(),
    setLowMemoryFreeThresholdMb: vi.fn(),
    setEfficiencyFreeze: vi.fn(),
    setPaintGateTimeoutMs: vi.fn(),
    setPaintGateHardTimeoutMs: vi.fn(),
    setWarmPaintGateTimeoutMs: vi.fn(),
    setWarmPaintGateHardTimeoutMs: vi.fn(),
  };
}

describe("ResourceProfileService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_830_001);
    vi.clearAllMocks();
    // Pin total RAM so threshold-crossing tests behave identically across CI hosts.
    // 8 GB yields ~1229 MB HIGH / ~655 MB LOW, matching the originally-tuned constants.
    vi.spyOn(os, "totalmem").mockReturnValue(EIGHT_GB);
    // Module-level snapshot cache would otherwise serve a previous test's
    // mocked metrics within the TTL window.
    resetAppMetricsSnapshotForTesting();
    mockGetAppMetrics.mockReturnValue([]);
    mockIsOnBatteryPower.mockReturnValue(false);
    mockGetCurrentThermalState.mockReturnValue("unknown" as const);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts in balanced profile", () => {
    const service = new ResourceProfileService(createDeps());
    expect(service.getProfile()).toBe("balanced");
    service.stop();
  });

  it("does not transition during warmup ticks", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 800), makeMetric("Tab", 500)]);

    // Advance through 2 warmup ticks
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(service.getProfile()).toBe("balanced");
    service.stop();
  });

  it("transitions to efficiency after sustained pressure past hysteresis", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    // High memory + battery = pressure score >= 3
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 800), makeMetric("Tab", 500)]);

    // 2 warmup ticks
    vi.advanceTimersByTime(60_000);
    expect(service.getProfile()).toBe("balanced");

    // First real eval — candidate set, timer starts
    vi.advanceTimersByTime(30_000);
    expect(service.getProfile()).toBe("balanced");

    // 30s downgrade hold (one more tick)
    vi.advanceTimersByTime(30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("does not oscillate — resets candidate when signals change", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    const onAcHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1] as (() => void) | undefined;

    // High pressure
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);

    // Past warmup
    vi.advanceTimersByTime(60_000);
    // First eval with pressure
    vi.advanceTimersByTime(30_000);
    expect(service.getProfile()).toBe("balanced");

    // Pressure relieved before hold completes
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    onAcHandler!();
    vi.advanceTimersByTime(30_000);

    // Should still be balanced — candidate reset
    expect(service.getProfile()).toBe("balanced");
    service.stop();
  });

  it("transitions to performance after 90s sustained low load", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Low pressure = performance candidate (score 0)
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    // Past warmup
    vi.advanceTimersByTime(60_000);
    // First eval
    vi.advanceTimersByTime(30_000);
    expect(service.getProfile()).toBe("balanced");

    // 90s upgrade hold = 3 more ticks
    vi.advanceTimersByTime(30_000);
    expect(service.getProfile()).toBe("balanced");
    vi.advanceTimersByTime(30_000);
    expect(service.getProfile()).toBe("balanced");
    vi.advanceTimersByTime(30_000);
    expect(service.getProfile()).toBe("performance");

    service.stop();
  });

  it("renderer saturation contributes pressure — blocks the performance upgrade", () => {
    const deps = createDeps({ hasSustainedRendererSaturation: () => true });
    const service = new ResourceProfileService(deps);
    service.start();

    // Identical low-load conditions to the performance-upgrade test above;
    // the only difference is the sustained renderer-saturation signal.
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    // Past warmup + first eval + full 90s upgrade hold
    vi.advanceTimersByTime(60_000 + 30_000 + 3 * 30_000);
    expect(service.getProfile()).toBe("balanced");

    service.stop();
  });

  it("broadcasts to renderer on profile change", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);

    // Past warmup + hysteresis
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);

    expect(broadcastToRenderer).toHaveBeenCalledWith(
      "events:push",
      expect.objectContaining({
        name: "resource:profile-changed",
        payload: expect.objectContaining({
          profile: "efficiency",
          config: RESOURCE_PROFILE_CONFIGS.efficiency,
        }),
      })
    );

    service.stop();
  });

  it("calls workspace client and hibernation service on profile change", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);

    const ws = deps.getWorkspaceClient() as unknown as MockWorkspaceClient;
    const hib = deps.getHibernationService() as unknown as MockHibernationService;

    expect(ws.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: RESOURCE_PROFILE_CONFIGS.efficiency.pollIntervalActive,
      pollIntervalBackground: RESOURCE_PROFILE_CONFIGS.efficiency.pollIntervalBackground,
      fetchIntervalActiveMs: RESOURCE_PROFILE_CONFIGS.efficiency.fetchIntervalActiveMs,
      fetchIntervalBackgroundMs: RESOURCE_PROFILE_CONFIGS.efficiency.fetchIntervalBackgroundMs,
      backgroundGitWatcherCap: RESOURCE_PROFILE_CONFIGS.efficiency.backgroundGitWatcherCap,
    });
    expect(hib.setMemoryPressureThresholdMs).toHaveBeenCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.memoryPressureInactiveMs
    );

    const stats = deps.getProjectStatsService() as unknown as MockProjectStatsService;
    expect(stats.updatePollInterval).toHaveBeenCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.projectStatsPollInterval
    );

    service.stop();
  });

  it("handles null deps gracefully", () => {
    const deps = createDeps({
      getPtyClient: () => null,
      getWorkspaceClient: () => null,
      getHibernationService: () => null,
      getAllProjectViewManagers: () => [],
      getProjectStatsService: () => null,
    });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);

    // Should not throw
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("freezes but never destroys cached views on memory-pressure efficiency entry", () => {
    // Even under HIGH memory pressure, efficiency entry must NOT clamp cached
    // views to 1 — destruction is owned solely by PVM's evictStaleViews()
    // lowMemoryFreeThresholdMb floor (genuine low free RAM). Entry only freezes
    // (CPU/timer suppression) so the user's working set stays warm and rapid
    // project switching doesn't trigger cold-start storms (#10742).
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setCachedViewLimit).not.toHaveBeenCalled();
    expect(pvm.setEfficiencyFreeze).toHaveBeenCalledWith(true);

    service.stop();
  });

  it("does not clamp cached view limit when efficiency is triggered by non-memory signals", () => {
    // Battery (+1) + thermal critical (+2) + zero memory = score 3 → efficiency.
    // setCachedViewLimit(1) MUST NOT fire — it would destroy cached
    // WebContentsViews (each 100–500 MB). setEfficiencyFreeze(true) still fires
    // because freeze suppresses CPU/timer wake-ups.
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    (service as unknown as { thermalState: string }).thermalState = "critical";

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setCachedViewLimit).not.toHaveBeenCalled();
    expect(pvm.setEfficiencyFreeze).toHaveBeenCalledWith(true);

    service.stop();
  });

  it("does not clamp cached view limit even when memory contributes to efficiency entry", () => {
    // Battery (+1) + thermal serious (+1) + LOW memory (+1) = score 3 → efficiency.
    // Memory contributed, but the clamp is gone regardless of the memory score —
    // only setEfficiencyFreeze(true) fires on entry.
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    (service as unknown as { thermalState: string }).thermalState = "serious";

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setCachedViewLimit).not.toHaveBeenCalled();
    expect(pvm.setEfficiencyFreeze).toHaveBeenCalledWith(true);

    service.stop();
  });

  it("still restores user cached view limit on exit from efficiency", () => {
    // Entry never clamps. On exit, the restore call must still fire — the
    // user-configured limit might have changed mid-efficiency, and PVM's own
    // evictStaleViews floor could have clamped while we were inside.
    const deps = createDeps({ getUserCachedViewLimit: () => 3 });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    const onAcHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1] as (() => void) | undefined;

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    (service as unknown as { thermalState: string }).thermalState = "critical";
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setCachedViewLimit).not.toHaveBeenCalled();

    // Clear thermal + battery — back to balanced.
    (service as unknown as { thermalState: string }).thermalState = "nominal";
    onAcHandler!();
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    vi.advanceTimersByTime(30_000 * 4);

    expect(service.getProfile()).not.toBe("efficiency");
    expect(pvm.setCachedViewLimit).toHaveBeenLastCalledWith(3);
    expect(pvm.setEfficiencyFreeze).toHaveBeenLastCalledWith(false);

    service.stop();
  });

  it("enables and disables setEfficiencyFreeze across an efficiency → balanced cycle", () => {
    const deps = createDeps({ getUserCachedViewLimit: () => 2 });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    const onAcHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1] as (() => void) | undefined;

    // Drive into efficiency.
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setEfficiencyFreeze).toHaveBeenLastCalledWith(true);

    // Relieve to balanced.
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    onAcHandler!();
    vi.advanceTimersByTime(30_000 * 4);

    expect(service.getProfile()).toBe("balanced");
    expect(pvm.setEfficiencyFreeze).toHaveBeenLastCalledWith(false);
    expect(pvm.setEfficiencyFreeze).toHaveBeenCalledTimes(2);

    service.stop();
  });

  it("still unfreezes when setCachedViewLimit throws on the exit path", () => {
    const deps = createDeps({ getUserCachedViewLimit: () => 2 });
    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    const onAcHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1] as (() => void) | undefined;

    // Drive into efficiency.
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");
    expect(pvm.setEfficiencyFreeze).toHaveBeenLastCalledWith(true);

    // Make the restore call fail — setEfficiencyFreeze(false) must still run.
    pvm.setCachedViewLimit.mockImplementationOnce(() => {
      throw new Error("simulated eviction failure");
    });

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    onAcHandler!();
    vi.advanceTimersByTime(30_000 * 4);

    expect(service.getProfile()).not.toBe("efficiency");
    expect(pvm.setEfficiencyFreeze).toHaveBeenLastCalledWith(false);

    service.stop();
  });

  it("does not call setEfficiencyFreeze on a balanced → performance transition", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setEfficiencyFreeze).not.toHaveBeenCalled();

    service.stop();
  });

  it("restores user cached view limit when upgrading from efficiency to balanced", () => {
    const deps = createDeps({ getUserCachedViewLimit: () => 3 });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    const onAcHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1] as (() => void) | undefined;

    // Drive into efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    // Entry no longer clamps cached views.
    expect(pvm.setCachedViewLimit).not.toHaveBeenCalled();

    // Relieve to moderate pressure (score 1 = balanced)
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    onAcHandler!();

    // First real eval sets candidate; 90s upgrade hold = 3 more ticks to apply
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(service.getProfile()).toBe("balanced");
    // Only the exit restore touches the limit now.
    expect(pvm.setCachedViewLimit).toHaveBeenLastCalledWith(3);
    expect(pvm.setCachedViewLimit).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it("restores user cached view limit when upgrading from efficiency to performance", () => {
    const deps = createDeps({ getUserCachedViewLimit: () => 2 });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    const onAcHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1] as (() => void) | undefined;

    // Drive into efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    // Relieve to zero pressure (score 0 = performance)
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    onAcHandler!();

    // First real eval sets candidate; 90s upgrade hold = 3 more ticks to apply
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(service.getProfile()).toBe("performance");
    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    // Entry never clamped, so only the exit restore touches the limit.
    expect(pvm.setCachedViewLimit).toHaveBeenLastCalledWith(2);
    expect(pvm.setCachedViewLimit).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it("does not touch cached view limit on balanced → performance transition", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Low pressure from the start — balanced → performance, no efficiency involved
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    // Warmup (2 ticks = 60s) + first real eval (30s) + 90s upgrade hold (3 ticks)
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setCachedViewLimit).not.toHaveBeenCalled();

    service.stop();
  });

  it("handles null project view manager on efficiency transition", () => {
    const deps = createDeps({ getAllProjectViewManagers: () => [] });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);

    // Should not throw
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  describe("applyCurrentProfileTo (late-created PVM)", () => {
    it("pushes the current efficiency settings to a PVM registered after the transition", () => {
      const deps = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();
      service._forceProfileForTesting("efficiency");

      const latePvm = makeMockPvm();
      service.applyCurrentProfileTo(latePvm as unknown as ProjectViewManager);

      expect(latePvm.setEfficiencyFreeze).toHaveBeenCalledWith(true);
      expect(latePvm.setLowMemoryFreeThresholdMb).toHaveBeenCalledWith(
        RESOURCE_PROFILE_CONFIGS.efficiency.lowMemoryFreeThresholdMb
      );
      expect(latePvm.setPaintGateTimeoutMs).toHaveBeenCalledWith(
        RESOURCE_PROFILE_CONFIGS.efficiency.paintGateTimeoutMs
      );
      expect(latePvm.setWarmPaintGateHardTimeoutMs).toHaveBeenCalledWith(
        RESOURCE_PROFILE_CONFIGS.efficiency.warmPaintGateHardTimeoutMs
      );
      // Efficiency entry never clamps cached views — it only freezes them.
      expect(latePvm.setCachedViewLimit).not.toHaveBeenCalled();

      service.stop();
    });

    it("does not freeze or clamp a late PVM while the profile is balanced", () => {
      const deps = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      const latePvm = makeMockPvm();
      service.applyCurrentProfileTo(latePvm as unknown as ProjectViewManager);

      expect(latePvm.setEfficiencyFreeze).not.toHaveBeenCalled();
      expect(latePvm.setCachedViewLimit).not.toHaveBeenCalled();
      expect(latePvm.setLowMemoryFreeThresholdMb).toHaveBeenCalledWith(
        RESOURCE_PROFILE_CONFIGS.balanced.lowMemoryFreeThresholdMb
      );

      service.stop();
    });
  });

  it("pushes the balanced profile's threshold on start() even without a transition", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;

    service.start();

    expect(pvm.setLowMemoryFreeThresholdMb).toHaveBeenCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.lowMemoryFreeThresholdMb
    );
    expect(pvm.setLowMemoryFreeThresholdMb).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it("pushes the balanced profile's paint-gate timeouts on start()", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;

    service.start();

    expect(pvm.setPaintGateTimeoutMs).toHaveBeenCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.paintGateTimeoutMs
    );
    expect(pvm.setPaintGateHardTimeoutMs).toHaveBeenCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.paintGateHardTimeoutMs
    );
    expect(pvm.setWarmPaintGateTimeoutMs).toHaveBeenCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.warmPaintGateTimeoutMs
    );
    expect(pvm.setWarmPaintGateHardTimeoutMs).toHaveBeenCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.warmPaintGateHardTimeoutMs
    );

    service.stop();
  });

  it("pushes efficiency paint-gate timeouts on transition into efficiency", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setPaintGateTimeoutMs).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.paintGateTimeoutMs
    );
    expect(pvm.setPaintGateHardTimeoutMs).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.paintGateHardTimeoutMs
    );
    expect(pvm.setWarmPaintGateTimeoutMs).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.warmPaintGateTimeoutMs
    );
    expect(pvm.setWarmPaintGateHardTimeoutMs).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.warmPaintGateHardTimeoutMs
    );

    service.stop();
  });

  it("restores balanced paint-gate timeouts on upgrade from efficiency", () => {
    const deps = createDeps({ getUserCachedViewLimit: () => 3 });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    const onAcHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1] as (() => void) | undefined;

    // Drive into efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setPaintGateTimeoutMs).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.paintGateTimeoutMs
    );

    // Relieve to balanced
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    onAcHandler!();
    vi.advanceTimersByTime(30_000 * 4);

    expect(service.getProfile()).toBe("balanced");
    expect(pvm.setPaintGateTimeoutMs).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.paintGateTimeoutMs
    );
    expect(pvm.setPaintGateHardTimeoutMs).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.paintGateHardTimeoutMs
    );
    expect(pvm.setWarmPaintGateTimeoutMs).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.warmPaintGateTimeoutMs
    );
    expect(pvm.setWarmPaintGateHardTimeoutMs).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.warmPaintGateHardTimeoutMs
    );

    service.stop();
  });

  it("pushes the efficiency profile's lowMemoryFreeThresholdMb on transition", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setLowMemoryFreeThresholdMb).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.lowMemoryFreeThresholdMb
    );

    service.stop();
  });

  it("pushes the balanced profile's threshold on upgrade from efficiency", () => {
    const deps = createDeps({ getUserCachedViewLimit: () => 3 });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    const onAcHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1] as (() => void) | undefined;

    // Drive into efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setLowMemoryFreeThresholdMb).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.lowMemoryFreeThresholdMb
    );

    // Relieve to balanced
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    onAcHandler!();
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(service.getProfile()).toBe("balanced");
    expect(pvm.setLowMemoryFreeThresholdMb).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.lowMemoryFreeThresholdMb
    );

    service.stop();
  });

  it("pushes null threshold on performance transition", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Low pressure from the start — balanced → performance.
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    const pvm = deps.getAllProjectViewManagers()[0] as unknown as MockProjectViewManager;
    expect(pvm.setLowMemoryFreeThresholdMb).toHaveBeenLastCalledWith(null);

    service.stop();
  });

  it("handles null pvm gracefully when pushing threshold", () => {
    const deps = createDeps({ getAllProjectViewManagers: () => [] });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);

    // Should not throw despite null pvm
    expect(() => vi.advanceTimersByTime(60_000 + 30_000 + 30_000)).not.toThrow();
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("balanced config matches hardcoded defaults", () => {
    const balanced = RESOURCE_PROFILE_CONFIGS.balanced;
    expect(balanced.pollIntervalActive).toBe(2000);
    expect(balanced.pollIntervalBackground).toBe(10000);
    expect(balanced.processTreePollInterval).toBe(2500);
    expect(balanced.projectStatsPollInterval).toBe(5000);
    expect(balanced.webglUpperThreshold).toBe(12);
    expect(balanced.webglLowerThreshold).toBe(10);
    expect(balanced.memoryPressureInactiveMs).toBe(30 * 60 * 1000);
    expect(balanced.lowMemoryFreeThresholdMb).toBe(768);
  });

  it("performance and efficiency WebGL thresholds stay pinned", () => {
    // Performance pushes closer to Chromium's 16-context cap.
    expect(RESOURCE_PROFILE_CONFIGS.performance.webglUpperThreshold).toBe(14);
    expect(RESOURCE_PROFILE_CONFIGS.performance.webglLowerThreshold).toBe(12);
    // Efficiency kicks to DOM-mode sooner on constrained hardware.
    expect(RESOURCE_PROFILE_CONFIGS.efficiency.webglUpperThreshold).toBe(8);
    expect(RESOURCE_PROFILE_CONFIGS.efficiency.webglLowerThreshold).toBe(6);
  });

  it("every profile keeps webglLowerThreshold <= webglUpperThreshold", () => {
    // The mode-switch hysteresis assumes lower <= upper. A profile that
    // inverted them would oscillate forever at the boundary.
    for (const config of Object.values(RESOURCE_PROFILE_CONFIGS)) {
      expect(config.webglLowerThreshold).toBeLessThanOrEqual(config.webglUpperThreshold);
    }
  });

  it("battery on its own contributes to pressure score", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    // Moderate memory (+1) + battery (+1) = 2 => balanced
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);

    // Past warmup + hysteresis for downgrade
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("balanced");

    service.stop();
  });

  it("high active-agent count contributes to pressure", async () => {
    const deps = createDeps();
    const mockPty = deps.getPtyClient() as unknown as MockPtyClient;
    mockPty.getAllTerminalsAsync.mockResolvedValue(makeActiveAgentTerminals(10));
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();
    await flushAsync();

    // Low memory (0) + battery (+1) + 10 agents (+1 at FLEET_COUNT_HIGH=8) = 2 => balanced
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("balanced");

    service.stop();
  });

  it("exactly 8 active agents alone (FLEET_COUNT_HIGH boundary) reach balanced", async () => {
    const deps = createDeps();
    const mockPty = deps.getPtyClient() as unknown as MockPtyClient;
    mockPty.getAllTerminalsAsync.mockResolvedValue(makeActiveAgentTerminals(8));
    const service = new ResourceProfileService(deps);
    service.start();
    await flushAsync();

    // Discriminating: with no other pressure, score 0 → "performance" after
    // upgrade hold. Adding 8 agents pulls the score to +1 → blocks performance.
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("balanced");

    service.stop();
  });

  it("16 active agents alone reach balanced from performance", async () => {
    const deps = createDeps();
    const mockPty = deps.getPtyClient() as unknown as MockPtyClient;
    mockPty.getAllTerminalsAsync.mockResolvedValue(makeActiveAgentTerminals(16));
    const service = new ResourceProfileService(deps);
    service.start();
    await flushAsync();

    // Low memory (0) + no battery (0) + 16 agents (+2 at FLEET_COUNT_VERY_HIGH=16) = 2 => balanced
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("balanced");

    service.stop();
  });

  it("24 active agents alone drive to efficiency", async () => {
    const deps = createDeps();
    const mockPty = deps.getPtyClient() as unknown as MockPtyClient;
    mockPty.getAllTerminalsAsync.mockResolvedValue(makeActiveAgentTerminals(24));
    const service = new ResourceProfileService(deps);
    service.start();
    await flushAsync();

    // Low memory (0) + no battery (0) + 24 agents (+3 at FLEET_COUNT_CRITICAL=24) = 3 => efficiency.
    // This is the core fix: fleet size alone could never reach efficiency under the
    // old flat +1 worktree-count signal.
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("uses workingSetSize when privateBytes is 0 (macOS/Linux shape) — regression for issue #8633", () => {
    // 8 GB → LOW ~655 MB, HIGH ~1229 MB. Battery (+1) + thermal serious (+1)
    // alone is score 2 = balanced. With workingSetSize 700 MB > LOW threshold
    // memory contributes +1 → score 3 = efficiency. If the production code
    // regressed to `privateBytes ?? workingSetSize`, privateBytes = 0 would
    // resolve first, memory contributes 0, score stays 2, profile stays balanced.
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();
    (service as unknown as { thermalState: string }).thermalState = "serious";

    mockGetAppMetrics.mockReturnValue([makeMetricMacShape("Browser", 700)]);

    // Warmup (2 ticks) + first eval + 90s downgrade hold
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("7 active agents (below FLEET_COUNT_HIGH) contribute zero pressure", async () => {
    const deps = createDeps();
    const mockPty = deps.getPtyClient() as unknown as MockPtyClient;
    mockPty.getAllTerminalsAsync.mockResolvedValue(makeActiveAgentTerminals(7));
    const service = new ResourceProfileService(deps);
    service.start();
    await flushAsync();

    // Low memory (0) + no battery (0) + 7 agents (0) = 0 => performance (after upgrade hold)
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    service.stop();
  });

  it("trashed and idle terminals are excluded from the active-agent count", async () => {
    const deps = createDeps();
    const mockPty = deps.getPtyClient() as unknown as MockPtyClient;
    // 24 entries total but only 7 qualify as live agents: the rest are either
    // trashed, idle/completed, or lack an agent identity.
    const mix: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 7; i += 1) {
      mix.push({ id: `live-${i}`, agentState: "working", detectedAgentId: "claude" });
    }
    for (let i = 0; i < 8; i += 1) {
      mix.push({
        id: `trash-${i}`,
        agentState: "working",
        detectedAgentId: "claude",
        isTrashed: true,
      });
    }
    for (let i = 0; i < 5; i += 1) {
      mix.push({ id: `idle-${i}`, agentState: "idle", detectedAgentId: "claude" });
    }
    for (let i = 0; i < 4; i += 1) {
      mix.push({ id: `noid-${i}`, agentState: "working" }); // no agent identity
    }
    mockPty.getAllTerminalsAsync.mockResolvedValue(mix);
    const service = new ResourceProfileService(deps);
    service.start();
    await flushAsync();

    // Only 7 live agents (below FLEET_COUNT_HIGH=8) — fleet score 0.
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    service.stop();
  });

  it("scales fleet tiers with device RAM — 31 agents on 64 GB contribute zero pressure", async () => {
    // 64 GB → high tier boundary = ceil(64 × 8/16) = 32, so 31 agents sit
    // below it and the service can still reach performance. On the 8 GB
    // baseline the same fleet would score +2 (≥16).
    vi.spyOn(os, "totalmem").mockReturnValue(64 * 1024 * 1024 * 1024);

    const deps = createDeps();
    const mockPty = deps.getPtyClient() as unknown as MockPtyClient;
    mockPty.getAllTerminalsAsync.mockResolvedValue(makeActiveAgentTerminals(31));
    const service = new ResourceProfileService(deps);
    service.start();
    await flushAsync();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    service.stop();
  });

  it("fleet tiers never drop below the 8/16/24 floors on small-RAM devices", async () => {
    // 4 GB → ceil(4 × 8/16) = 2 unclamped; the floor keeps the boundary at 8,
    // so 7 agents still contribute zero pressure.
    vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 * 1024 * 1024);

    const deps = createDeps();
    const mockPty = deps.getPtyClient() as unknown as MockPtyClient;
    mockPty.getAllTerminalsAsync.mockResolvedValue(makeActiveAgentTerminals(7));
    const service = new ResourceProfileService(deps);
    service.start();
    await flushAsync();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    service.stop();
  });

  it("scales thresholds up on high-RAM devices so 1.3 GB usage is not pressure", () => {
    // 64 GB Mac: HIGH threshold = 9830 MB, LOW = 5243 MB.
    // 1300 MB of privateBytes should contribute zero pressure, letting the
    // service upgrade to "performance" instead of dropping to "efficiency".
    vi.spyOn(os, "totalmem").mockReturnValue(64 * 1024 * 1024 * 1024);

    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);

    // Warmup (2 ticks = 60s) + first real eval (30s) + 90s upgrade hold (3 ticks)
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    service.stop();
  });

  it("thermal critical + battery drives to efficiency", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    // Low memory (0) + battery (+1) + thermal critical (+2) = 3 => efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    (service as unknown as { thermalState: string }).thermalState = "critical";

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("thermal serious + battery + moderate memory = efficiency", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    // Moderate memory (+1) + battery (+1) + thermal serious (+1) = 3 => efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    (service as unknown as { thermalState: string }).thermalState = "serious";

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("thermal fair and nominal do not contribute to pressure", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    // Moderate memory (+1) + battery (+1) + thermal fair (0) = 2 => balanced
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    (service as unknown as { thermalState: string }).thermalState = "fair";

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("balanced");

    service.stop();
  });

  it("speed limit under 50 + moderate memory drives to efficiency", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Moderate memory (+1) + speed limit 40 (+2) = 3 => efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    mockIsOnBatteryPower.mockReturnValue(false);
    (service as unknown as { speedLimit: number }).speedLimit = 40;

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("speed limit 50-99 contributes +1 to pressure", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Moderate memory (+1) + speed limit 75 (+1) = 2 => balanced
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    mockIsOnBatteryPower.mockReturnValue(false);
    (service as unknown as { speedLimit: number }).speedLimit = 75;

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("balanced");

    service.stop();
  });

  it("speed limit 100 does not contribute to pressure", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Low memory (0) + speed limit 100 (0) = 0 => performance
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);
    (service as unknown as { speedLimit: number }).speedLimit = 100;

    // Warmup (2 ticks = 60s) + first real eval (30s) + 90s upgrade hold (3 ticks)
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    service.stop();
  });

  it("routes thermal-state-change event through handler to profile scoring", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    // Capture the thermal handler registered with powerMonitor.on
    const thermalHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "thermal-state-change"
    )?.[1] as ((details: { state: string }) => void) | undefined;
    expect(thermalHandler).toBeDefined();

    // Simulate Electron 41 powerMonitor event (single object, not two args)
    thermalHandler!({ state: "critical" });

    // Low memory (0) + thermal critical (+2) + battery (+1) = 3 => efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("routes speed-limit-change event through handler to profile scoring", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Capture the speed-limit handler registered with powerMonitor.on
    const speedHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "speed-limit-change"
    )?.[1] as ((details: { limit: number }) => void) | undefined;
    expect(speedHandler).toBeDefined();

    // Simulate Electron 41 powerMonitor event (single object)
    speedHandler!({ limit: 30 });

    // Low memory (0) + speed limit 30 (+2) = 2 => balanced (need more for efficiency)
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("balanced");

    service.stop();
  });

  it("removeListener receives the exact same handler reference passed to on", () => {
    const service = new ResourceProfileService(createDeps());
    service.start();
    service.stop();

    // Get the handlers passed to on
    const thermalOnArg = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "thermal-state-change"
    )?.[1];
    const speedOnArg = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "speed-limit-change"
    )?.[1];
    const batteryOnArg = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-battery"
    )?.[1];
    const acOnArg = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1];

    // Get the handlers passed to removeListener
    const thermalOffArg = mockPowerMonitorRemoveListener.mock.calls.find(
      (call: string[]) => call[0] === "thermal-state-change"
    )?.[1];
    const speedOffArg = mockPowerMonitorRemoveListener.mock.calls.find(
      (call: string[]) => call[0] === "speed-limit-change"
    )?.[1];
    const batteryOffArg = mockPowerMonitorRemoveListener.mock.calls.find(
      (call: string[]) => call[0] === "on-battery"
    )?.[1];
    const acOffArg = mockPowerMonitorRemoveListener.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1];

    expect(thermalOnArg).toBeDefined();
    expect(thermalOffArg).toBeDefined();
    expect(thermalOnArg).toBe(thermalOffArg);
    expect(speedOnArg).toBeDefined();
    expect(speedOffArg).toBeDefined();
    expect(speedOnArg).toBe(speedOffArg);
    expect(batteryOnArg).toBeDefined();
    expect(batteryOffArg).toBeDefined();
    expect(batteryOnArg).toBe(batteryOffArg);
    expect(acOnArg).toBeDefined();
    expect(acOffArg).toBeDefined();
    expect(acOnArg).toBe(acOffArg);
  });

  it("registers powerMonitor listeners on start", () => {
    const service = new ResourceProfileService(createDeps());
    service.start();

    expect(mockPowerMonitorOn).toHaveBeenCalledWith("thermal-state-change", expect.any(Function));
    expect(mockPowerMonitorOn).toHaveBeenCalledWith("speed-limit-change", expect.any(Function));
    expect(mockPowerMonitorOn).toHaveBeenCalledWith("on-battery", expect.any(Function));
    expect(mockPowerMonitorOn).toHaveBeenCalledWith("on-ac", expect.any(Function));

    service.stop();
  });

  it("removes powerMonitor listeners on stop", () => {
    const service = new ResourceProfileService(createDeps());
    service.start();
    service.stop();

    expect(mockPowerMonitorRemoveListener).toHaveBeenCalledWith(
      "thermal-state-change",
      expect.any(Function)
    );
    expect(mockPowerMonitorRemoveListener).toHaveBeenCalledWith(
      "speed-limit-change",
      expect.any(Function)
    );
    expect(mockPowerMonitorRemoveListener).toHaveBeenCalledWith("on-battery", expect.any(Function));
    expect(mockPowerMonitorRemoveListener).toHaveBeenCalledWith("on-ac", expect.any(Function));
  });

  it("scales thresholds down on low-RAM devices so 500 MB usage is detected", async () => {
    // 4 GB machine: HIGH = 614 MB, LOW = 328 MB.
    // 500 MB of privateBytes must score LOW (+1), not HIGH (+2). To discriminate,
    // pair with 10 active agents (+1). LOW + agents = 2 → balanced;
    // HIGH + agents = 3 → efficiency. The "balanced" assertion only passes
    // if the 500 MB reading was scored as LOW.
    vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 * 1024 * 1024);

    const deps = createDeps();
    const mockPty = deps.getPtyClient() as unknown as MockPtyClient;
    mockPty.getAllTerminalsAsync.mockResolvedValue(makeActiveAgentTerminals(10));
    const service = new ResourceProfileService(deps);
    service.start();
    await flushAsync();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 500)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("balanced");

    service.stop();
  });

  it("primes thermal state from getCurrentThermalState at start", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mockGetCurrentThermalState.mockReturnValue("fair" as const);

    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    expect(mockGetCurrentThermalState).toHaveBeenCalled();
    const internals = service as unknown as { thermalState: string };
    expect(internals.thermalState).toBe("fair");

    service.stop();
  });

  it("primes battery state from isOnBatteryPower at start", () => {
    mockIsOnBatteryPower.mockReturnValue(true);

    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    const internals = service as unknown as { isOnBattery: boolean };
    expect(internals.isOnBattery).toBe(true);
    // isOnBatteryPower called exactly once (during start), not per-tick
    expect(mockIsOnBatteryPower).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it("on-battery event updates cached battery state", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    const onBatteryHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-battery"
    )?.[1] as (() => void) | undefined;
    expect(onBatteryHandler).toBeDefined();

    onBatteryHandler!();
    const internals = service as unknown as { isOnBattery: boolean };
    expect(internals.isOnBattery).toBe(true);

    service.stop();
  });

  it("on-ac event clears cached battery state", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    const onAcHandler = mockPowerMonitorOn.mock.calls.find(
      (call: string[]) => call[0] === "on-ac"
    )?.[1] as (() => void) | undefined;
    expect(onAcHandler).toBeDefined();

    const internals = service as unknown as { isOnBattery: boolean };
    expect(internals.isOnBattery).toBe(true);

    onAcHandler!();
    expect(internals.isOnBattery).toBe(false);

    service.stop();
  });

  it("cold start with thermal critical contributes to first evaluation", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mockGetCurrentThermalState.mockReturnValue("critical" as const);
    mockIsOnBatteryPower.mockReturnValue(true);

    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Low memory (0) + battery (+1) + thermal critical (+2) = 3 => efficiency
    // Without thermal priming the score would be 1 => balanced
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("isOnBatteryPower not called on evaluation ticks after priming", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Past warmup
    vi.advanceTimersByTime(60_000);
    // Several evaluation ticks
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    // isOnBatteryPower should only have been called once (during start)
    expect(mockIsOnBatteryPower).toHaveBeenCalledTimes(1);

    service.stop();
  });

  describe("system available memory signal", () => {
    // The Electron-augmented `process.getSystemMemoryInfo` lives on the real
    // process global, so we attach a stub directly and restore it after each
    // test. `vi.stubGlobal('process', ...)` would obliterate Node internals.
    let originalGetSystemMemoryInfo: unknown;

    beforeEach(() => {
      originalGetSystemMemoryInfo = (process as { getSystemMemoryInfo?: unknown })
        .getSystemMemoryInfo;
    });

    afterEach(() => {
      if (originalGetSystemMemoryInfo === undefined) {
        delete (process as { getSystemMemoryInfo?: unknown }).getSystemMemoryInfo;
      } else {
        (process as { getSystemMemoryInfo?: unknown }).getSystemMemoryInfo =
          originalGetSystemMemoryInfo;
      }
    });

    function stubSystemMemory(freeKb: number, purgeableKb: number, totalKb: number): void {
      (process as { getSystemMemoryInfo?: unknown }).getSystemMemoryInfo = vi.fn(() => ({
        free: freeKb,
        purgeable: purgeableKb,
        total: totalKb,
      }));
    }

    it("system available memory below 10% of total adds +2 to pressure", () => {
      // 8 GB total. 10% = 819 MB. Stub free+purgeable = 500 MB (well below LOW threshold).
      // Free 300 MB + purgeable 200 MB = 500 MB available.
      stubSystemMemory(300 * 1024, 200 * 1024, EIGHT_GB / 1024);

      const deps = createDeps();
      const service = new ResourceProfileService(deps);
      mockIsOnBatteryPower.mockReturnValue(true);
      service.start();

      // Low app memory (0) + battery (+1) + sys mem <10% (+2) = 3 => efficiency
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);

      vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("efficiency");

      service.stop();
    });

    it("system available memory between 10–20% of total adds +1 to pressure", () => {
      // 8 GB total. HIGH threshold (20%) = 1638 MB; LOW (10%) = 819 MB.
      // Stub free 1000 MB + purgeable 0 = 1000 MB (between LOW and HIGH).
      stubSystemMemory(1000 * 1024, 0, EIGHT_GB / 1024);

      const deps = createDeps();
      const service = new ResourceProfileService(deps);
      mockIsOnBatteryPower.mockReturnValue(true);
      service.start();

      // Low app memory (0) + battery (+1) + sys mem 12% (+1) = 2 => balanced
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);

      vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("balanced");

      service.stop();
    });

    it("system available memory above 20% does not contribute", () => {
      // Free 3 GB on 8 GB total = 37% available.
      stubSystemMemory(3 * 1024 * 1024, 0, EIGHT_GB / 1024);

      const deps = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Low memory (0) + no battery (0) + sys mem fine (0) = 0 => performance
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
      mockIsOnBatteryPower.mockReturnValue(false);

      vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("performance");

      service.stop();
    });

    it("includes purgeable memory in the 'available' calculation", () => {
      // 8 GB total. Free alone = 200 MB (well below 10% / 819 MB).
      // With purgeable = 4 GB folded in, available = 4.2 GB (above 20% / 1638 MB).
      // Asserting "performance" only passes if purgeable was added — without it
      // the score would jump to +2 (sys mem critical).
      stubSystemMemory(200 * 1024, 4 * 1024 * 1024, EIGHT_GB / 1024);

      const deps = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
      mockIsOnBatteryPower.mockReturnValue(false);

      vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("performance");

      service.stop();
    });

    it("treats missing purgeable field as 0", () => {
      // Non-macOS shape: only free is reported. Free = 500 MB on 8 GB = 6% available.
      (process as { getSystemMemoryInfo?: unknown }).getSystemMemoryInfo = vi.fn(() => ({
        free: 500 * 1024,
        total: EIGHT_GB / 1024,
      }));

      const deps = createDeps();
      const service = new ResourceProfileService(deps);
      mockIsOnBatteryPower.mockReturnValue(true);
      service.start();

      // sys mem <10% (+2) + battery (+1) = 3 => efficiency
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);

      vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("efficiency");

      service.stop();
    });

    it("contributes nothing when process.getSystemMemoryInfo is absent", () => {
      // Default state: no stub. Removed defensively in case the test runner
      // happens to expose it.
      delete (process as { getSystemMemoryInfo?: unknown }).getSystemMemoryInfo;

      const deps = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
      mockIsOnBatteryPower.mockReturnValue(false);

      vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("performance");

      service.stop();
    });

    it("swallows errors from getSystemMemoryInfo", () => {
      (process as { getSystemMemoryInfo?: unknown }).getSystemMemoryInfo = vi.fn(() => {
        throw new Error("simulated native failure");
      });

      const deps = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      // Should not throw; sys mem signal contributes 0.
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
      mockIsOnBatteryPower.mockReturnValue(false);

      expect(() =>
        vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000)
      ).not.toThrow();
      expect(service.getProfile()).toBe("performance");

      service.stop();
    });

    it("treats non-positive available memory as no signal", () => {
      // Edge case: API returns zero/negative free which would otherwise create
      // a false positive. The helper should return null and the signal should
      // not contribute, mirroring ProjectViewManager.
      stubSystemMemory(0, 0, EIGHT_GB / 1024);

      const deps = createDeps();
      const service = new ResourceProfileService(deps);
      service.start();

      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
      mockIsOnBatteryPower.mockReturnValue(false);

      vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000 + 30_000);
      expect(service.getProfile()).toBe("performance");

      service.stop();
    });
  });

  it("start() pushes the low-memory threshold to every registered PVM", () => {
    // Regression for #8605: in multi-window sessions, the initial threshold
    // must arm every window's PVM, not just the most recently opened one.
    const pvmA = makeMockPvm();
    const pvmB = makeMockPvm();
    const deps = createDeps({
      getAllProjectViewManagers: () => [
        pvmA as unknown as ProjectViewManager,
        pvmB as unknown as ProjectViewManager,
      ],
    });
    const service = new ResourceProfileService(deps);

    service.start();

    expect(pvmA.setLowMemoryFreeThresholdMb).toHaveBeenCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.lowMemoryFreeThresholdMb
    );
    expect(pvmB.setLowMemoryFreeThresholdMb).toHaveBeenCalledWith(
      RESOURCE_PROFILE_CONFIGS.balanced.lowMemoryFreeThresholdMb
    );

    service.stop();
  });

  it("efficiency transition fans out setEfficiencyFreeze to every PVM", () => {
    // Regression for #8605: profile transitions must reach every open window's
    // PVM so the controls aren't silently scoped to one window.
    const pvmA = makeMockPvm();
    const pvmB = makeMockPvm();
    const deps = createDeps({
      getAllProjectViewManagers: () => [
        pvmA as unknown as ProjectViewManager,
        pvmB as unknown as ProjectViewManager,
      ],
    });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    // Entry freezes both windows' cached views but destroys neither.
    expect(pvmA.setCachedViewLimit).not.toHaveBeenCalled();
    expect(pvmA.setEfficiencyFreeze).toHaveBeenCalledWith(true);
    expect(pvmA.setLowMemoryFreeThresholdMb).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.lowMemoryFreeThresholdMb
    );
    expect(pvmB.setCachedViewLimit).not.toHaveBeenCalled();
    expect(pvmB.setEfficiencyFreeze).toHaveBeenCalledWith(true);
    expect(pvmB.setLowMemoryFreeThresholdMb).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.lowMemoryFreeThresholdMb
    );

    service.stop();
  });

  it("one failing PVM does not block the remaining PVMs", () => {
    // Per-operation try/catch isolation must extend across PVMs: a throw on
    // one window's setEfficiencyFreeze must not skip the next window's calls.
    const pvmA = makeMockPvm();
    const pvmB = makeMockPvm();
    pvmA.setEfficiencyFreeze.mockImplementation(() => {
      throw new Error("simulated PVM A failure");
    });
    const deps = createDeps({
      getAllProjectViewManagers: () => [
        pvmA as unknown as ProjectViewManager,
        pvmB as unknown as ProjectViewManager,
      ],
    });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    // PVM A's setEfficiencyFreeze threw, but PVM B must receive the full
    // sequence, unblocked by A's failure — split try/catch per call/per PVM.
    expect(pvmA.setEfficiencyFreeze).toHaveBeenCalledWith(true);
    expect(pvmB.setEfficiencyFreeze).toHaveBeenCalledWith(true);
    expect(pvmB.setLowMemoryFreeThresholdMb).toHaveBeenLastCalledWith(
      RESOURCE_PROFILE_CONFIGS.efficiency.lowMemoryFreeThresholdMb
    );

    service.stop();
  });

  it("zero PVMs is a no-throw no-op", () => {
    const deps = createDeps({ getAllProjectViewManagers: () => [] });
    const service = new ResourceProfileService(deps);
    mockIsOnBatteryPower.mockReturnValue(true);

    expect(() => service.start()).not.toThrow();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    expect(() => vi.advanceTimersByTime(60_000 + 30_000 + 30_000)).not.toThrow();
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  describe("getWhySlowResourceSnapshot", () => {
    it("reports no reasons and a performance target under no pressure", () => {
      const service = new ResourceProfileService(createDeps());
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
      resetAppMetricsSnapshotForTesting();

      const snap = service.getWhySlowResourceSnapshot();

      expect(snap.pressureScore).toBe(0);
      expect(snap.reasons).toEqual([]);
      expect(snap.targetProfile).toBe("performance");
      expect(snap.currentProfile).toBe("balanced");
      expect(snap.lagPressureActive).toBe(false);
      expect(snap.interactiveOverrideActive).toBe(false);
    });

    it("maps a single low-memory signal (score 1) to a balanced target", () => {
      const service = new ResourceProfileService(createDeps());
      // Between LOW (~655MB) and HIGH (~1229MB) at 8GB → memoryScore 1.
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 800)]);
      resetAppMetricsSnapshotForTesting();

      const snap = service.getWhySlowResourceSnapshot();

      expect(snap.pressureScore).toBe(1);
      expect(snap.targetProfile).toBe("balanced");
      expect(snap.reasons).toEqual([
        { signal: "memory", contribution: 1, detail: expect.stringContaining("app memory") },
      ]);
    });

    it("keeps pressureScore equal to the summed reason contributions (drift guard)", () => {
      const service = new ResourceProfileService(createDeps());
      mockIsOnBatteryPower.mockReturnValue(true);
      service.start();
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
      resetAppMetricsSnapshotForTesting();

      const snap = service.getWhySlowResourceSnapshot();

      const summed = snap.reasons.reduce((total, r) => total + r.contribution, 0);
      expect(summed).toBe(snap.pressureScore);
      // And the target bucket is derived purely from that score.
      const expectedTarget =
        snap.pressureScore >= 3
          ? "efficiency"
          : snap.pressureScore === 0
            ? "performance"
            : "balanced";
      expect(snap.targetProfile).toBe(expectedTarget);

      service.stop();
    });

    it("surfaces the memory pressure signal with its contribution", () => {
      const service = new ResourceProfileService(createDeps());
      // > HIGH threshold (~1229MB at 8GB) → memory contributes +2.
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
      resetAppMetricsSnapshotForTesting();

      const snap = service.getWhySlowResourceSnapshot();

      const memory = snap.reasons.find((r) => r.signal === "memory");
      expect(memory).toBeDefined();
      expect(memory?.contribution).toBe(2);
      // Memory alone (2) stays under the efficiency latch (>=3) → balanced.
      expect(snap.pressureScore).toBe(2);
      expect(snap.targetProfile).toBe("balanced");
    });

    it("targetProfile never drifts from the pressure score → efficiency at ≥3", () => {
      const service = new ResourceProfileService(createDeps());
      mockIsOnBatteryPower.mockReturnValue(true);
      service.start();
      // Memory +2 and battery +1 = 3 → efficiency.
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
      resetAppMetricsSnapshotForTesting();

      const snap = service.getWhySlowResourceSnapshot();

      expect(snap.reasons.map((r) => r.signal).sort()).toEqual(["battery", "memory"]);
      expect(snap.pressureScore).toBe(3);
      expect(snap.targetProfile).toBe("efficiency");
      expect(snap.isOnBattery).toBe(true);

      service.stop();
    });
  });
});
