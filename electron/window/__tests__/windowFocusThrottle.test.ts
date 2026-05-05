import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
  },
  powerMonitor: {
    on: vi.fn(),
  },
}));

vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: { SYSTEM_WAKE: "system:wake" },
}));

vi.mock("../webContentsRegistry.js", () => ({
  getAppWebContents: vi.fn(),
}));

const mockSetDiskSpaceInterval = vi.fn();
const mockRefreshDiskSpace = vi.fn();
const mockSetAppMetricsInterval = vi.fn();
const mockRefreshAppMetrics = vi.fn();

vi.mock("../../services/DiskSpaceMonitor.js", () => ({
  setDiskSpaceMonitorPollInterval: mockSetDiskSpaceInterval,
  refreshDiskSpaceMonitor: mockRefreshDiskSpace,
}));

vi.mock("../../services/ProcessMemoryMonitor.js", () => ({
  setAppMetricsMonitorPollInterval: mockSetAppMetricsInterval,
  refreshAppMetricsMonitor: mockRefreshAppMetrics,
}));

import { app } from "electron";
import type { PtyClient } from "../../services/PtyClient.js";
import type { WorkspaceClient } from "../../services/WorkspaceClient.js";
import type { ProjectStatsService } from "../../services/ProjectStatsService.js";
import type { IdleTerminalNotificationService } from "../../services/IdleTerminalNotificationService.js";
import type { PreAgentSnapshotService } from "../../services/PreAgentSnapshotService.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron's app.on() signature uses any
type AppEventHandler = (...args: any[]) => void;
const appHandlers = new Map<string, AppEventHandler>();
(app.on as ReturnType<typeof vi.fn>).mockImplementation(
  (event: string, handler: AppEventHandler) => {
    appHandlers.set(event, handler);
    return app;
  }
);

function createMockDeps() {
  const ptyClient = {
    setProcessTreePollInterval: vi.fn(),
  } as unknown as PtyClient;

  const workspaceClient = {
    updateMonitorConfig: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    setPollingEnabled: vi.fn(),
    setPRPollCadence: vi.fn(),
  } as unknown as WorkspaceClient;

  const statsService = {
    updatePollInterval: vi.fn(),
    refresh: vi.fn(),
  } as unknown as ProjectStatsService;

  const idleTerminalService = {
    updatePollInterval: vi.fn(),
  } as unknown as IdleTerminalNotificationService;

  const preAgentSnapshotService = {
    updatePollInterval: vi.fn(),
  } as unknown as PreAgentSnapshotService;

  return {
    deps: {
      getPtyClient: () => ptyClient,
      getWorkspaceClient: () => workspaceClient,
      getProjectStatsService: () => statsService,
      getIdleTerminalNotificationService: () => idleTerminalService,
      getPreAgentSnapshotService: () => preAgentSnapshotService,
    },
    ptyClient,
    workspaceClient,
    statsService,
    idleTerminalService,
    preAgentSnapshotService,
  };
}

// Must import after mocks are set up
let setupWindowFocusThrottle: typeof import("../powerMonitor.js").setupWindowFocusThrottle;
let registerWindowForFocusThrottle: typeof import("../powerMonitor.js").registerWindowForFocusThrottle;

describe("WindowFocusThrottle", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    appHandlers.clear();
    mockSetDiskSpaceInterval.mockClear();
    mockRefreshDiskSpace.mockClear();
    mockSetAppMetricsInterval.mockClear();
    mockRefreshAppMetrics.mockClear();
    // Re-import to get fresh module state
    vi.resetModules();

    // Re-mock electron after resetModules
    vi.doMock("electron", () => ({
      app: {
        on: vi.fn((event: string, handler: AppEventHandler) => {
          appHandlers.set(event, handler);
          return { on: vi.fn() };
        }),
      },
      BrowserWindow: {
        getFocusedWindow: vi.fn(() => null),
        getAllWindows: vi.fn(() => []),
      },
      powerMonitor: {
        on: vi.fn(),
      },
    }));

    vi.doMock("../../ipc/channels.js", () => ({
      CHANNELS: { SYSTEM_WAKE: "system:wake" },
    }));

    vi.doMock("../webContentsRegistry.js", () => ({
      getAppWebContents: vi.fn(),
    }));

    vi.doMock("../../services/DiskSpaceMonitor.js", () => ({
      setDiskSpaceMonitorPollInterval: mockSetDiskSpaceInterval,
      refreshDiskSpaceMonitor: mockRefreshDiskSpace,
    }));

    vi.doMock("../../services/ProcessMemoryMonitor.js", () => ({
      setAppMetricsMonitorPollInterval: mockSetAppMetricsInterval,
      refreshAppMetricsMonitor: mockRefreshAppMetrics,
    }));

    const mod = await import("../powerMonitor.js");
    setupWindowFocusThrottle = mod.setupWindowFocusThrottle;
    registerWindowForFocusThrottle = mod.registerWindowForFocusThrottle;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throttles all services on blur when no window is focused", async () => {
    const {
      deps,
      workspaceClient,
      statsService,
      ptyClient,
      idleTerminalService,
      preAgentSnapshotService,
    } = createMockDeps();
    setupWindowFocusThrottle(deps);

    const blurHandler = appHandlers.get("browser-window-blur")!;
    expect(blurHandler).toBeDefined();

    const { BrowserWindow: BW } = await import("electron");
    (BW.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue(null);

    blurHandler();
    vi.advanceTimersByTime(100);

    expect(workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 10_000,
      pollIntervalBackground: 50_000,
    });
    expect(workspaceClient.setPollingEnabled).toHaveBeenCalledWith(false);
    expect(workspaceClient.setPRPollCadence).toHaveBeenCalledWith(false);
    expect(statsService.updatePollInterval).toHaveBeenCalledWith(25_000);
    expect(
      vi.mocked(ptyClient as unknown as { setProcessTreePollInterval: () => void })
        .setProcessTreePollInterval
    ).toHaveBeenCalledWith(12_500);

    // New services
    expect(mockSetDiskSpaceInterval).toHaveBeenCalledWith(1_500_000);
    expect(mockSetAppMetricsInterval).toHaveBeenCalledWith(150_000);
    expect(idleTerminalService.updatePollInterval).toHaveBeenCalledWith(1_500_000);
    expect(preAgentSnapshotService.updatePollInterval).toHaveBeenCalledWith(18_000_000);
  });

  it("does not throttle on blur when another window is focused", async () => {
    const { deps, workspaceClient, idleTerminalService, preAgentSnapshotService } =
      createMockDeps();
    setupWindowFocusThrottle(deps);

    const blurHandler = appHandlers.get("browser-window-blur")!;
    const { BrowserWindow: BW } = await import("electron");
    (BW.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue({} as unknown);

    blurHandler();
    vi.advanceTimersByTime(100);

    expect(workspaceClient.updateMonitorConfig).not.toHaveBeenCalled();
    expect(mockSetDiskSpaceInterval).not.toHaveBeenCalled();
    expect(mockSetAppMetricsInterval).not.toHaveBeenCalled();
    expect(idleTerminalService.updatePollInterval).not.toHaveBeenCalled();
    expect(preAgentSnapshotService.updatePollInterval).not.toHaveBeenCalled();
  });

  it("cancels throttle when focus arrives within debounce window", async () => {
    const { deps, workspaceClient, idleTerminalService, preAgentSnapshotService } =
      createMockDeps();
    setupWindowFocusThrottle(deps);

    const blurHandler = appHandlers.get("browser-window-blur")!;
    const focusHandler = appHandlers.get("browser-window-focus")!;

    blurHandler();
    vi.advanceTimersByTime(50); // Within 100ms debounce
    focusHandler();
    vi.advanceTimersByTime(100);

    expect(workspaceClient.updateMonitorConfig).not.toHaveBeenCalled();
    expect(mockSetDiskSpaceInterval).not.toHaveBeenCalled();
    expect(mockSetAppMetricsInterval).not.toHaveBeenCalled();
    expect(idleTerminalService.updatePollInterval).not.toHaveBeenCalled();
    expect(preAgentSnapshotService.updatePollInterval).not.toHaveBeenCalled();
  });

  it("unthrottles and refreshes on focus", async () => {
    const {
      deps,
      workspaceClient,
      statsService,
      ptyClient,
      idleTerminalService,
      preAgentSnapshotService,
    } = createMockDeps();
    setupWindowFocusThrottle(deps);

    const blurHandler = appHandlers.get("browser-window-blur")!;
    const focusHandler = appHandlers.get("browser-window-focus")!;
    const { BrowserWindow: BW } = await import("electron");
    (BW.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue(null);

    // First throttle
    blurHandler();
    vi.advanceTimersByTime(100);

    // Reset mocks to verify unthrottle calls
    vi.mocked(workspaceClient.updateMonitorConfig).mockClear();
    vi.mocked(workspaceClient.setPollingEnabled).mockClear();
    vi.mocked(workspaceClient.setPRPollCadence).mockClear();
    vi.mocked(statsService.updatePollInterval).mockClear();
    mockSetDiskSpaceInterval.mockClear();
    mockRefreshDiskSpace.mockClear();
    mockSetAppMetricsInterval.mockClear();
    mockRefreshAppMetrics.mockClear();

    // Then unthrottle
    focusHandler();

    expect(workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 2_000,
      pollIntervalBackground: 10_000,
    });
    expect(workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
    expect(workspaceClient.setPRPollCadence).toHaveBeenCalledWith(true);
    expect(workspaceClient.refresh).toHaveBeenCalled();

    // setPollingEnabled(true) must run before refresh() so the host is
    // polling-enabled when the refresh broadcast arrives.
    const enableOrder = vi.mocked(workspaceClient.setPollingEnabled).mock.invocationCallOrder[0];
    const refreshOrder = vi.mocked(workspaceClient.refresh).mock.invocationCallOrder[0];
    expect(enableOrder).toBeLessThan(refreshOrder);

    expect(statsService.updatePollInterval).toHaveBeenCalledWith(5_000);
    expect(statsService.refresh).toHaveBeenCalled();
    expect(
      vi.mocked(ptyClient as unknown as { setProcessTreePollInterval: () => void })
        .setProcessTreePollInterval
    ).toHaveBeenCalledWith(2_500);

    // New services: restore normal intervals
    expect(mockSetDiskSpaceInterval).toHaveBeenCalledWith(300_000);
    expect(mockRefreshDiskSpace).toHaveBeenCalled();
    expect(mockSetAppMetricsInterval).toHaveBeenCalledWith(30_000);
    expect(mockRefreshAppMetrics).toHaveBeenCalled();
    expect(idleTerminalService.updatePollInterval).toHaveBeenCalledWith(300_000);
    expect(preAgentSnapshotService.updatePollInterval).toHaveBeenCalledWith(3_600_000);
  });

  it("is idempotent — double throttle only calls services once", async () => {
    const {
      deps,
      workspaceClient,
      statsService,
      ptyClient,
      idleTerminalService,
      preAgentSnapshotService,
    } = createMockDeps();
    setupWindowFocusThrottle(deps);

    const blurHandler = appHandlers.get("browser-window-blur")!;
    const { BrowserWindow: BW } = await import("electron");
    (BW.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue(null);

    blurHandler();
    vi.advanceTimersByTime(100);
    blurHandler();
    vi.advanceTimersByTime(100);

    expect(workspaceClient.updateMonitorConfig).toHaveBeenCalledTimes(1);
    expect(workspaceClient.setPollingEnabled).toHaveBeenCalledTimes(1);
    expect(statsService.updatePollInterval).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(ptyClient as unknown as { setProcessTreePollInterval: () => void })
        .setProcessTreePollInterval
    ).toHaveBeenCalledTimes(1);
    expect(mockSetDiskSpaceInterval).toHaveBeenCalledTimes(1);
    expect(mockSetAppMetricsInterval).toHaveBeenCalledTimes(1);
    expect(idleTerminalService.updatePollInterval).toHaveBeenCalledTimes(1);
    expect(preAgentSnapshotService.updatePollInterval).toHaveBeenCalledTimes(1);
  });

  it("handles minimize → throttle and restore → unthrottle via per-window events", async () => {
    const { deps, workspaceClient, statsService, idleTerminalService, preAgentSnapshotService } =
      createMockDeps();
    setupWindowFocusThrottle(deps);

    const { BrowserWindow: BW } = await import("electron");
    (BW.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const windowHandlers = new Map<string, (...args: unknown[]) => void>();
    const mockWin = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        windowHandlers.set(event, handler);
      }),
    } as unknown as Electron.BrowserWindow;

    registerWindowForFocusThrottle(mockWin);

    // Minimize triggers throttle
    windowHandlers.get("minimize")!();
    expect(workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 10_000,
      pollIntervalBackground: 50_000,
    });
    expect(workspaceClient.setPollingEnabled).toHaveBeenCalledWith(false);
    expect(mockSetDiskSpaceInterval).toHaveBeenCalledWith(1_500_000);
    expect(mockSetAppMetricsInterval).toHaveBeenCalledWith(150_000);
    expect(idleTerminalService.updatePollInterval).toHaveBeenCalledWith(1_500_000);
    expect(preAgentSnapshotService.updatePollInterval).toHaveBeenCalledWith(18_000_000);

    vi.mocked(workspaceClient.updateMonitorConfig).mockClear();
    vi.mocked(workspaceClient.setPollingEnabled).mockClear();
    mockSetDiskSpaceInterval.mockClear();
    mockSetAppMetricsInterval.mockClear();

    // Restore triggers unthrottle
    windowHandlers.get("restore")!();
    expect(workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 2_000,
      pollIntervalBackground: 10_000,
    });
    expect(workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
    expect(statsService.refresh).toHaveBeenCalled();
    expect(mockSetDiskSpaceInterval).toHaveBeenCalledWith(300_000);
    expect(mockRefreshDiskSpace).toHaveBeenCalled();
    expect(mockSetAppMetricsInterval).toHaveBeenCalledWith(30_000);
    expect(mockRefreshAppMetrics).toHaveBeenCalled();
  });

  it("skips deps-based services gracefully when getters return null", async () => {
    const deps = {
      getPtyClient: () => null,
      getWorkspaceClient: () => null,
      getProjectStatsService: () => null,
      getIdleTerminalNotificationService: () => null,
      getPreAgentSnapshotService: () => null,
    };
    setupWindowFocusThrottle(deps);

    const blurHandler = appHandlers.get("browser-window-blur")!;
    const { BrowserWindow: BW } = await import("electron");
    (BW.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue(null);

    blurHandler();
    vi.advanceTimersByTime(100);

    // Module-level setters are always called (they no-op internally via idempotency guard)
    expect(mockSetDiskSpaceInterval).toHaveBeenCalledWith(1_500_000);
    expect(mockSetAppMetricsInterval).toHaveBeenCalledWith(150_000);
  });
});
