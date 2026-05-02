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

const EIGHT_GB = 8 * 1024 * 1024 * 1024;

const mockGetAppMetrics = app.getAppMetrics as Mock;
const mockIsOnBatteryPower = powerMonitor.isOnBatteryPower as unknown as Mock;
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
interface MockProjectViewManager {
  setCachedViewLimit: Mock;
}
interface MockProjectStatsService {
  updatePollInterval: Mock;
}

function createDeps(overrides?: Partial<ResourceProfileDeps>): ResourceProfileDeps {
  const mockPtyClient: MockPtyClient = {
    setResourceProfile: vi.fn(),
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
  };
  const mockProjectStatsService: MockProjectStatsService = {
    updatePollInterval: vi.fn(),
  };

  return {
    getPtyClient: () => mockPtyClient as unknown as PtyClient,
    getWorkspaceClient: () => mockWorkspaceClient as unknown as WorkspaceClient,
    getHibernationService: () => mockHibernationService as unknown as HibernationService,
    getProjectViewManager: () => mockProjectViewManager as unknown as ProjectViewManager,
    getProjectStatsService: () => mockProjectStatsService as unknown as ProjectStatsService,
    getUserCachedViewLimit: () => 2,
    ...overrides,
  };
}

describe("ResourceProfileService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Pin total RAM so threshold-crossing tests behave identically across CI hosts.
    // 8 GB yields ~1229 MB HIGH / ~655 MB LOW, matching the originally-tuned constants.
    vi.spyOn(os, "totalmem").mockReturnValue(EIGHT_GB);
    mockGetAppMetrics.mockReturnValue([]);
    mockIsOnBatteryPower.mockReturnValue(false);
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
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 800), makeMetric("Tab", 500)]);
    mockIsOnBatteryPower.mockReturnValue(true);

    // Advance through 2 warmup ticks
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(service.getProfile()).toBe("balanced");
    service.stop();
  });

  it("transitions to efficiency after sustained pressure past hysteresis", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // High memory + battery = pressure score >= 3
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 800), makeMetric("Tab", 500)]);
    mockIsOnBatteryPower.mockReturnValue(true);

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
    service.start();

    // High pressure
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    mockIsOnBatteryPower.mockReturnValue(true);

    // Past warmup
    vi.advanceTimersByTime(60_000);
    // First eval with pressure
    vi.advanceTimersByTime(30_000);
    expect(service.getProfile()).toBe("balanced");

    // Pressure relieved before hold completes
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);
    vi.advanceTimersByTime(30_000);

    // Should still be balanced — candidate reset
    expect(service.getProfile()).toBe("balanced");
    service.stop();
  });

  it("transitions to performance after 60s sustained low load", () => {
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

    // 60s upgrade hold = 2 more ticks
    vi.advanceTimersByTime(30_000);
    expect(service.getProfile()).toBe("balanced");
    vi.advanceTimersByTime(30_000);
    expect(service.getProfile()).toBe("performance");

    service.stop();
  });

  it("broadcasts to renderer on profile change", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    mockIsOnBatteryPower.mockReturnValue(true);

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
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    mockIsOnBatteryPower.mockReturnValue(true);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);

    const ws = deps.getWorkspaceClient() as unknown as MockWorkspaceClient;
    const hib = deps.getHibernationService() as unknown as MockHibernationService;

    expect(ws.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: RESOURCE_PROFILE_CONFIGS.efficiency.pollIntervalActive,
      pollIntervalBackground: RESOURCE_PROFILE_CONFIGS.efficiency.pollIntervalBackground,
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
      getProjectViewManager: () => null,
      getProjectStatsService: () => null,
    });
    const service = new ResourceProfileService(deps);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    mockIsOnBatteryPower.mockReturnValue(true);

    // Should not throw
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("clamps cached project views to 1 when transitioning to efficiency", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    mockIsOnBatteryPower.mockReturnValue(true);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getProjectViewManager() as unknown as MockProjectViewManager;
    expect(pvm.setCachedViewLimit).toHaveBeenCalledWith(1);
    expect(pvm.setCachedViewLimit).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it("restores user cached view limit when upgrading from efficiency to balanced", () => {
    const deps = createDeps({ getUserCachedViewLimit: () => 3 });
    const service = new ResourceProfileService(deps);
    service.start();

    // Drive into efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    mockIsOnBatteryPower.mockReturnValue(true);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    const pvm = deps.getProjectViewManager() as unknown as MockProjectViewManager;
    expect(pvm.setCachedViewLimit).toHaveBeenLastCalledWith(1);

    // Relieve to moderate pressure (score 1 = balanced)
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    // First real eval sets candidate; 60s upgrade hold = 2 more ticks to apply
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(service.getProfile()).toBe("balanced");
    expect(pvm.setCachedViewLimit).toHaveBeenLastCalledWith(3);
    expect(pvm.setCachedViewLimit).toHaveBeenCalledTimes(2);

    service.stop();
  });

  it("restores user cached view limit when upgrading from efficiency to performance", () => {
    const deps = createDeps({ getUserCachedViewLimit: () => 2 });
    const service = new ResourceProfileService(deps);
    service.start();

    // Drive into efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    mockIsOnBatteryPower.mockReturnValue(true);
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    // Relieve to zero pressure (score 0 = performance)
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    // First real eval sets candidate; 60s upgrade hold = 2 more ticks to apply
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(service.getProfile()).toBe("performance");
    const pvm = deps.getProjectViewManager() as unknown as MockProjectViewManager;
    expect(pvm.setCachedViewLimit).toHaveBeenLastCalledWith(2);
    expect(pvm.setCachedViewLimit).toHaveBeenCalledTimes(2);

    service.stop();
  });

  it("does not touch cached view limit on balanced → performance transition", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Low pressure from the start — balanced → performance, no efficiency involved
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    const pvm = deps.getProjectViewManager() as unknown as MockProjectViewManager;
    expect(pvm.setCachedViewLimit).not.toHaveBeenCalled();

    service.stop();
  });

  it("handles null project view manager on efficiency transition", () => {
    const deps = createDeps({ getProjectViewManager: () => null });
    const service = new ResourceProfileService(deps);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 1300)]);
    mockIsOnBatteryPower.mockReturnValue(true);

    // Should not throw
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("balanced config matches hardcoded defaults", () => {
    const balanced = RESOURCE_PROFILE_CONFIGS.balanced;
    expect(balanced.pollIntervalActive).toBe(2000);
    expect(balanced.pollIntervalBackground).toBe(10000);
    expect(balanced.processTreePollInterval).toBe(2500);
    expect(balanced.projectStatsPollInterval).toBe(5000);
    expect(balanced.maxWebGLContexts).toBe(12);
    expect(balanced.memoryPressureInactiveMs).toBe(30 * 60 * 1000);
  });

  it("battery on its own contributes to pressure score", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Moderate memory (+1) + battery (+1) = 2 => balanced
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    mockIsOnBatteryPower.mockReturnValue(true);

    // Past warmup + hysteresis for downgrade
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("balanced");

    service.stop();
  });

  it("high worktree count contributes to pressure", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.setWorktreeCount(10);
    service.start();

    // Low memory (0) + battery (+1) + worktrees (+1) = 2 => balanced
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(true);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("balanced");

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
    mockIsOnBatteryPower.mockReturnValue(false);

    // Warmup (2 ticks = 60s) + first real eval (30s) + 60s upgrade hold (2 ticks)
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    service.stop();
  });

  it("thermal critical + battery drives to efficiency", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Low memory (0) + battery (+1) + thermal critical (+2) = 3 => efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(true);
    (service as unknown as { thermalState: string }).thermalState = "critical";

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("thermal serious + battery + moderate memory = efficiency", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Moderate memory (+1) + battery (+1) + thermal serious (+1) = 3 => efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    mockIsOnBatteryPower.mockReturnValue(true);
    (service as unknown as { thermalState: string }).thermalState = "serious";

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("thermal fair and nominal do not contribute to pressure", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Moderate memory (+1) + battery (+1) + thermal fair (0) = 2 => balanced
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    mockIsOnBatteryPower.mockReturnValue(true);
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

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("performance");

    service.stop();
  });

  it("routes thermal-state-change event through handler to profile scoring", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
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
    mockIsOnBatteryPower.mockReturnValue(true);

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

    // Get the handlers passed to removeListener
    const thermalOffArg = mockPowerMonitorRemoveListener.mock.calls.find(
      (call: string[]) => call[0] === "thermal-state-change"
    )?.[1];
    const speedOffArg = mockPowerMonitorRemoveListener.mock.calls.find(
      (call: string[]) => call[0] === "speed-limit-change"
    )?.[1];

    expect(thermalOnArg).toBeDefined();
    expect(thermalOffArg).toBeDefined();
    expect(thermalOnArg).toBe(thermalOffArg);
    expect(speedOnArg).toBeDefined();
    expect(speedOffArg).toBeDefined();
    expect(speedOnArg).toBe(speedOffArg);
  });

  it("registers powerMonitor listeners on start", () => {
    const service = new ResourceProfileService(createDeps());
    service.start();

    expect(mockPowerMonitorOn).toHaveBeenCalledWith("thermal-state-change", expect.any(Function));
    expect(mockPowerMonitorOn).toHaveBeenCalledWith("speed-limit-change", expect.any(Function));

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
  });

  it("scales thresholds down on low-RAM devices so 500 MB usage is detected", () => {
    // 4 GB machine: HIGH = 614 MB, LOW = 328 MB.
    // 500 MB of privateBytes must score LOW (+1), not HIGH (+2). To discriminate,
    // pair with 10 worktrees (+1). LOW + worktrees = 2 → balanced;
    // HIGH + worktrees = 3 → efficiency. The "balanced" assertion only passes
    // if the 500 MB reading was scored as LOW.
    vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 * 1024 * 1024);

    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.setWorktreeCount(10);
    service.start();

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 500)]);
    mockIsOnBatteryPower.mockReturnValue(false);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("balanced");

    service.stop();
  });
});
