import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import type { WorkspaceClient } from "../WorkspaceClient.js";
import type { HibernationService } from "../HibernationService.js";

// Mock electron modules before importing
vi.mock("electron", () => ({
  app: {
    getAppMetrics: vi.fn(() => []),
  },
  powerMonitor: {
    isOnBatteryPower: vi.fn(() => false),
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

import { app, powerMonitor } from "electron";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { ResourceProfileService, type ResourceProfileDeps } from "../ResourceProfileService.js";
import { RESOURCE_PROFILE_CONFIGS } from "../../../shared/types/resourceProfile.js";

const mockGetAppMetrics = app.getAppMetrics as Mock;
const mockIsOnBatteryPower = powerMonitor.isOnBatteryPower as unknown as Mock;

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

  return {
    getPtyClient: () => mockPtyClient as unknown as PtyClient,
    getWorkspaceClient: () => mockWorkspaceClient as unknown as WorkspaceClient,
    getHibernationService: () => mockHibernationService as unknown as HibernationService,
    ...overrides,
  };
}

describe("ResourceProfileService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetAppMetrics.mockReturnValue([]);
    mockIsOnBatteryPower.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
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
      "resource:profile-changed",
      expect.objectContaining({
        profile: "efficiency",
        config: RESOURCE_PROFILE_CONFIGS.efficiency,
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

    service.stop();
  });

  it("handles null deps gracefully", () => {
    const deps = createDeps({
      getPtyClient: () => null,
      getWorkspaceClient: () => null,
      getHibernationService: () => null,
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

  it("balanced config matches hardcoded defaults", () => {
    const balanced = RESOURCE_PROFILE_CONFIGS.balanced;
    expect(balanced.pollIntervalActive).toBe(2000);
    expect(balanced.pollIntervalBackground).toBe(10000);
    expect(balanced.processTreePollInterval).toBe(2500);
    expect(balanced.maxWebGLContexts).toBe(12);
    expect(balanced.memoryPressureInactiveMs).toBe(30 * 60 * 1000);
  });

  it("battery on its own contributes to pressure score", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.start();

    // Battery only (score 2) + moderate memory (score 1) = 3 => efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700)]);
    mockIsOnBatteryPower.mockReturnValue(true);

    // Past warmup + hysteresis for downgrade
    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });

  it("high worktree count contributes to pressure", () => {
    const deps = createDeps();
    const service = new ResourceProfileService(deps);
    service.setWorktreeCount(10);
    service.start();

    // Battery (2) + worktrees (1) = 3 => efficiency
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200)]);
    mockIsOnBatteryPower.mockReturnValue(true);

    vi.advanceTimersByTime(60_000 + 30_000 + 30_000);
    expect(service.getProfile()).toBe("efficiency");

    service.stop();
  });
});
