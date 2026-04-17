import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import type { WorkspaceClient } from "../WorkspaceClient.js";
import type { HibernationService } from "../HibernationService.js";

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

import os from "os";
import { app, powerMonitor } from "electron";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { ResourceProfileService, type ResourceProfileDeps } from "../ResourceProfileService.js";

const EIGHT_GB = 8 * 1024 * 1024 * 1024;

const mockGetAppMetrics = app.getAppMetrics as Mock;
const mockIsOnBatteryPower = powerMonitor.isOnBatteryPower as unknown as Mock;

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

  return {
    deps: {
      getPtyClient: () => pty as unknown as PtyClient,
      getWorkspaceClient: () => workspace as unknown as WorkspaceClient,
      getHibernationService: () => hibernation as unknown as HibernationService,
      getProjectViewManager: () => null,
      getUserCachedViewLimit: () => 1,
      ...overrides,
    },
    workspace,
    pty,
    hibernation,
  };
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

  it.todo(
    "loop-lag profile mismatches cannot be exercised yet because ResourceProfileService has no loop-lag signal"
  );
});
