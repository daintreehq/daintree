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

import { app } from "electron";
import type { PtyClient } from "../../services/PtyClient.js";
import type { WorkspaceClient } from "../../services/WorkspaceClient.js";
import type { ProjectStatsService } from "../../services/ProjectStatsService.js";

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
  } as unknown as WorkspaceClient;

  const statsService = {
    updatePollInterval: vi.fn(),
    refresh: vi.fn(),
  } as unknown as ProjectStatsService;

  return {
    deps: {
      getPtyClient: () => ptyClient,
      getWorkspaceClient: () => workspaceClient,
      getProjectStatsService: () => statsService,
    },
    ptyClient,
    workspaceClient,
    statsService,
  };
}

// Must import after mocks are set up
let setupWindowFocusThrottle: typeof import("../powerMonitor.js").setupWindowFocusThrottle;
let registerWindowForFocusThrottle: typeof import("../powerMonitor.js").registerWindowForFocusThrottle;

describe("WindowFocusThrottle", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    appHandlers.clear();
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

    const mod = await import("../powerMonitor.js");
    setupWindowFocusThrottle = mod.setupWindowFocusThrottle;
    registerWindowForFocusThrottle = mod.registerWindowForFocusThrottle;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throttles all services on blur when no window is focused", async () => {
    const { deps, workspaceClient, statsService, ptyClient } = createMockDeps();
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
    expect(statsService.updatePollInterval).toHaveBeenCalledWith(25_000);
    expect(
      vi.mocked(ptyClient as unknown as { setProcessTreePollInterval: () => void })
        .setProcessTreePollInterval
    ).toHaveBeenCalledWith(12_500);
  });

  it("does not throttle on blur when another window is focused", async () => {
    const { deps, workspaceClient } = createMockDeps();
    setupWindowFocusThrottle(deps);

    const blurHandler = appHandlers.get("browser-window-blur")!;
    const { BrowserWindow: BW } = await import("electron");
    (BW.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue({} as unknown);

    blurHandler();
    vi.advanceTimersByTime(100);

    expect(workspaceClient.updateMonitorConfig).not.toHaveBeenCalled();
  });

  it("cancels throttle when focus arrives within debounce window", async () => {
    const { deps, workspaceClient } = createMockDeps();
    setupWindowFocusThrottle(deps);

    const blurHandler = appHandlers.get("browser-window-blur")!;
    const focusHandler = appHandlers.get("browser-window-focus")!;

    blurHandler();
    vi.advanceTimersByTime(50); // Within 100ms debounce
    focusHandler();
    vi.advanceTimersByTime(100);

    expect(workspaceClient.updateMonitorConfig).not.toHaveBeenCalled();
  });

  it("unthrottles and refreshes on focus", async () => {
    const { deps, workspaceClient, statsService, ptyClient } = createMockDeps();
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
    vi.mocked(statsService.updatePollInterval).mockClear();

    // Then unthrottle
    focusHandler();

    expect(workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 2_000,
      pollIntervalBackground: 10_000,
    });
    expect(workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
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
  });

  it("is idempotent — double throttle only calls services once", async () => {
    const { deps, workspaceClient } = createMockDeps();
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
  });

  it("handles minimize → throttle and restore → unthrottle via per-window events", async () => {
    const { deps, workspaceClient, statsService } = createMockDeps();
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

    vi.mocked(workspaceClient.updateMonitorConfig).mockClear();
    vi.mocked(workspaceClient.setPollingEnabled).mockClear();

    // Restore triggers unthrottle
    windowHandlers.get("restore")!();
    expect(workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 2_000,
      pollIntervalBackground: 10_000,
    });
    expect(workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
    expect(statsService.refresh).toHaveBeenCalled();
  });
});
