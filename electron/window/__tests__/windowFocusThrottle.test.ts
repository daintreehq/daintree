import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PtyClient } from "../../services/PtyClient.js";
import type { WorkspaceClient } from "../../services/WorkspaceClient.js";
import type { ProjectStatsService } from "../../services/ProjectStatsService.js";
import type { IdleTerminalNotificationService } from "../../services/IdleTerminalNotificationService.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron's app.on() signature uses any
type Handler = (...args: any[]) => void;

const linuxSource = vi.hoisted(() => ({
  onChange: null as ((onBattery: boolean) => void) | null,
  refresh: vi.fn(async () => {}),
  dispose: vi.fn(),
}));

// Hoisted, so it survives the `vi.resetModules()` each test opens with. Without
// it the Linux branch of setupPowerMonitor would start a real sysfs poll here.
vi.mock("../../services/linuxPowerSource.js", () => ({
  watchLinuxPowerSource: vi.fn((onChange: (onBattery: boolean) => void) => {
    linuxSource.onChange = onChange;
    return { refresh: linuxSource.refresh, dispose: linuxSource.dispose };
  }),
}));

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

const appHandlers = new Map<string, Handler>();
const powerHandlers = new Map<string, Handler>();

const mockSetDiskSpaceInterval = vi.fn();
const mockRefreshDiskSpace = vi.fn();
const mockSetAppMetricsInterval = vi.fn();
const mockRefreshAppMetrics = vi.fn();
const mockViewSend = vi.fn();

/** A registered app window whose focus/visibility the test drives directly. */
interface FakeWindow {
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  handlers: Map<string, Handler>;
  win: Electron.BrowserWindow;
}

let windows: FakeWindow[] = [];

function createFakeWindow(state: Partial<Omit<FakeWindow, "handlers" | "win">> = {}): FakeWindow {
  const handlers = new Map<string, Handler>();
  const fake = {
    focused: state.focused ?? true,
    visible: state.visible ?? true,
    minimized: state.minimized ?? false,
    handlers,
  } as FakeWindow;
  fake.win = {
    isDestroyed: () => false,
    isVisible: () => fake.visible,
    isMinimized: () => fake.minimized,
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
  } as unknown as Electron.BrowserWindow;
  windows.push(fake);
  return fake;
}

function createMockDeps() {
  const ptyClient = {
    setProcessTreePollInterval: vi.fn(),
    setPowerPolicy: vi.fn(),
  } as unknown as PtyClient;

  const workspaceClient = {
    updateMonitorConfig: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    refreshOnWake: vi.fn().mockResolvedValue(undefined),
    setPollingEnabled: vi.fn(),
    setPRPollCadence: vi.fn(),
    waitForReady: vi.fn().mockResolvedValue(undefined),
    pauseHealthCheck: vi.fn(),
    resumeHealthCheck: vi.fn(),
  } as unknown as WorkspaceClient;

  const statsService = {
    updatePollInterval: vi.fn(),
    refresh: vi.fn(),
  } as unknown as ProjectStatsService;

  const idleTerminalService = {
    updatePollInterval: vi.fn(),
  } as unknown as IdleTerminalNotificationService;

  return {
    deps: {
      getPtyClient: () => ptyClient,
      getWorkspaceClient: () => workspaceClient,
      getProjectStatsService: () => statsService,
      getIdleTerminalNotificationService: () => idleTerminalService,
    },
    ptyClient,
    workspaceClient,
    statsService,
    idleTerminalService,
  };
}

type Deps = ReturnType<typeof createMockDeps>;

function clearServiceMocks(mocks: Deps): void {
  vi.mocked(mocks.workspaceClient.updateMonitorConfig).mockClear();
  vi.mocked(mocks.workspaceClient.setPollingEnabled).mockClear();
  vi.mocked(mocks.workspaceClient.setPRPollCadence).mockClear();
  vi.mocked(mocks.workspaceClient.refresh).mockClear();
  vi.mocked(mocks.workspaceClient.refreshOnWake).mockClear();
  vi.mocked(mocks.statsService.updatePollInterval).mockClear();
  vi.mocked(mocks.statsService.refresh).mockClear();
  vi.mocked(mocks.ptyClient.setProcessTreePollInterval).mockClear();
  vi.mocked(mocks.ptyClient.setPowerPolicy).mockClear();
  vi.mocked(mocks.idleTerminalService.updatePollInterval).mockClear();
  mockSetDiskSpaceInterval.mockClear();
  mockRefreshDiskSpace.mockClear();
  mockSetAppMetricsInterval.mockClear();
  mockRefreshAppMetrics.mockClear();
  mockViewSend.mockClear();
}

let powerMonitorModule: typeof import("../powerMonitor.js");
let powerPolicyModule: typeof import("../powerPolicy.js");
let focusThrottleModule: typeof import("../focusThrottleState.js");

describe("WindowFocusThrottle", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // These tests drive Electron's battery events, which only exist off Linux —
    // and CI runs on Linux, so the platform is named rather than inherited.
    setPlatform("darwin");
    linuxSource.onChange = null;
    appHandlers.clear();
    powerHandlers.clear();
    windows = [];
    mockSetDiskSpaceInterval.mockClear();
    mockRefreshDiskSpace.mockClear();
    mockSetAppMetricsInterval.mockClear();
    mockRefreshAppMetrics.mockClear();
    mockViewSend.mockClear();
    vi.resetModules();

    vi.doMock("electron", () => ({
      app: {
        on: vi.fn((event: string, handler: Handler) => {
          appHandlers.set(event, handler);
        }),
      },
      BrowserWindow: {
        getFocusedWindow: vi.fn(() => windows.find((w) => w.focused)?.win ?? null),
        getAllWindows: vi.fn(() => windows.map((w) => w.win)),
      },
      powerMonitor: {
        on: vi.fn((event: string, handler: Handler) => {
          powerHandlers.set(event, handler);
        }),
        isOnBatteryPower: vi.fn(() => false),
      },
    }));

    vi.doMock("../../ipc/channels.js", () => ({
      CHANNELS: { EVENTS_PUSH: "events:push" },
    }));

    vi.doMock("../webContentsRegistry.js", () => ({
      getAppWebContents: vi.fn(),
      getAllAppWebContents: vi.fn(() => [{ isDestroyed: () => false, send: mockViewSend }]),
    }));

    vi.doMock("../../services/DiskSpaceMonitor.js", () => ({
      setDiskSpaceMonitorPollInterval: mockSetDiskSpaceInterval,
      refreshDiskSpaceMonitor: mockRefreshDiskSpace,
    }));

    vi.doMock("../../services/ProcessMemoryMonitor.js", () => ({
      setAppMetricsMonitorPollInterval: mockSetAppMetricsInterval,
      refreshAppMetricsMonitor: mockRefreshAppMetrics,
    }));

    powerMonitorModule = await import("../powerMonitor.js");
    powerPolicyModule = await import("../powerPolicy.js");
    focusThrottleModule = await import("../focusThrottleState.js");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    vi.useRealTimers();
  });

  function setup(): { mocks: Deps; main: FakeWindow } {
    const mocks = createMockDeps();
    powerMonitorModule.setupWindowFocusThrottle(mocks.deps);
    powerMonitorModule.setupPowerMonitor({
      getPtyClient: () => null,
      getWorkspaceClient: () => mocks.workspaceClient,
    });
    const main = createFakeWindow();
    powerMonitorModule.registerWindowForFocusThrottle(main.win);
    return { mocks, main };
  }

  function blur(win: FakeWindow): void {
    win.focused = false;
    appHandlers.get("browser-window-blur")!();
    vi.advanceTimersByTime(100);
  }

  function focus(win: FakeWindow): void {
    win.focused = true;
    appHandlers.get("browser-window-focus")!();
  }

  it("throttles every poller ×5 on blur when no window is focused", () => {
    const { mocks, main } = setup();

    blur(main);

    expect(mocks.workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 10_000,
      pollIntervalBackground: 50_000,
    });
    expect(mocks.workspaceClient.setPollingEnabled).toHaveBeenCalledWith(false);
    expect(mocks.workspaceClient.setPRPollCadence).toHaveBeenCalledWith(false);
    expect(mocks.statsService.updatePollInterval).toHaveBeenCalledWith(25_000);
    expect(mocks.ptyClient.setProcessTreePollInterval).toHaveBeenCalledWith(12_500);
    expect(mockSetDiskSpaceInterval).toHaveBeenCalledWith(1_500_000);
    expect(mockSetAppMetricsInterval).toHaveBeenCalledWith(150_000);
    expect(mocks.idleTerminalService.updatePollInterval).toHaveBeenCalledWith(1_500_000);
    expect(focusThrottleModule.isFocusThrottled()).toBe(true);
    expect(focusThrottleModule.getFocusThrottlePollMultiplier()).toBe(5);
  });

  it("does not throttle on blur when another window takes focus", () => {
    const { mocks, main } = setup();
    const second = createFakeWindow({ focused: false });
    powerMonitorModule.registerWindowForFocusThrottle(second.win);

    main.focused = false;
    second.focused = true;
    appHandlers.get("browser-window-blur")!();
    vi.advanceTimersByTime(100);

    expect(mocks.workspaceClient.updateMonitorConfig).not.toHaveBeenCalled();
    expect(mockSetDiskSpaceInterval).not.toHaveBeenCalled();
    expect(mocks.idleTerminalService.updatePollInterval).not.toHaveBeenCalled();
  });

  it("cancels the throttle when focus returns within the blur debounce", () => {
    const { mocks, main } = setup();

    main.focused = false;
    appHandlers.get("browser-window-blur")!();
    vi.advanceTimersByTime(50);
    focus(main);
    vi.advanceTimersByTime(100);

    expect(mocks.workspaceClient.updateMonitorConfig).not.toHaveBeenCalled();
    expect(mockSetDiskSpaceInterval).not.toHaveBeenCalled();
    expect(mocks.idleTerminalService.updatePollInterval).not.toHaveBeenCalled();
  });

  it("unthrottles and refreshes each poller once on focus", () => {
    const { mocks, main } = setup();
    blur(main);
    clearServiceMocks(mocks);

    focus(main);

    expect(mocks.workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 2_000,
      pollIntervalBackground: 10_000,
    });
    expect(mocks.workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
    expect(mocks.workspaceClient.setPRPollCadence).toHaveBeenCalledWith(true);
    expect(mocks.workspaceClient.refresh).toHaveBeenCalledTimes(1);

    // setPollingEnabled(true) must run before refresh() so the host is
    // polling-enabled when the refresh broadcast arrives.
    const enableOrder = vi.mocked(mocks.workspaceClient.setPollingEnabled).mock
      .invocationCallOrder[0];
    const refreshOrder = vi.mocked(mocks.workspaceClient.refresh).mock.invocationCallOrder[0];
    expect(enableOrder).toBeLessThan(refreshOrder);

    expect(mocks.statsService.updatePollInterval).toHaveBeenCalledWith(5_000);
    expect(mocks.statsService.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.ptyClient.setProcessTreePollInterval).toHaveBeenCalledWith(2_500);
    expect(mockSetDiskSpaceInterval).toHaveBeenCalledWith(300_000);
    expect(mockRefreshDiskSpace).toHaveBeenCalledTimes(1);
    expect(mockSetAppMetricsInterval).toHaveBeenCalledWith(30_000);
    expect(mockRefreshAppMetrics).toHaveBeenCalledTimes(1);
    expect(mocks.idleTerminalService.updatePollInterval).toHaveBeenCalledWith(300_000);
    expect(focusThrottleModule.isFocusThrottled()).toBe(false);
  });

  it("is idempotent — a repeated blur re-applies nothing", () => {
    const { mocks, main } = setup();

    blur(main);
    blur(main);

    expect(mocks.workspaceClient.updateMonitorConfig).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceClient.setPollingEnabled).toHaveBeenCalledTimes(1);
    expect(mocks.statsService.updatePollInterval).toHaveBeenCalledTimes(1);
    expect(mocks.ptyClient.setProcessTreePollInterval).toHaveBeenCalledTimes(1);
    expect(mockSetDiskSpaceInterval).toHaveBeenCalledTimes(1);
    expect(mockSetAppMetricsInterval).toHaveBeenCalledTimes(1);
    expect(mocks.idleTerminalService.updatePollInterval).toHaveBeenCalledTimes(1);
  });

  it("goes deep (×10) when the only window is minimized, and restore alone does not unthrottle", () => {
    const { mocks, main } = setup();

    main.focused = false;
    main.minimized = true;
    main.handlers.get("minimize")!();

    expect(mocks.workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 20_000,
      pollIntervalBackground: 100_000,
    });
    expect(mocks.workspaceClient.setPollingEnabled).toHaveBeenCalledWith(false);
    expect(mockSetDiskSpaceInterval).toHaveBeenCalledWith(3_000_000);
    expect(mocks.ptyClient.setPowerPolicy).toHaveBeenCalledWith("deep");
    clearServiceMocks(mocks);

    // Restored but not yet focused: visible again, still nobody looking.
    main.minimized = false;
    main.handlers.get("restore")!();
    expect(mocks.workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 10_000,
      pollIntervalBackground: 50_000,
    });
    expect(mocks.workspaceClient.setPollingEnabled).not.toHaveBeenCalled();
    expect(mocks.workspaceClient.refresh).not.toHaveBeenCalled();
    expect(mocks.ptyClient.setPowerPolicy).toHaveBeenCalledWith("saving");
    clearServiceMocks(mocks);

    // Focus is what brings the user back: one refresh, foreground cadence.
    focus(main);
    expect(mocks.workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
    expect(mocks.workspaceClient.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.ptyClient.setPowerPolicy).toHaveBeenCalledWith("active");
  });

  it("treats a hidden window like a minimized one", () => {
    const { mocks, main } = setup();

    main.focused = false;
    main.visible = false;
    main.handlers.get("hide")!();

    expect(powerPolicyModule.getPowerPolicy().level).toBe("deep");
    expect(mocks.workspaceClient.setPollingEnabled).toHaveBeenCalledWith(false);

    // showInactive(): visible again but never focused.
    main.visible = true;
    main.handlers.get("show")!();
    expect(powerPolicyModule.getPowerPolicy()).toMatchObject({
      level: "saving",
      canObserve: false,
    });
  });

  it("goes deep on a locked screen even though the window keeps focus", () => {
    const { mocks } = setup();

    powerHandlers.get("lock-screen")!();

    expect(powerPolicyModule.getPowerPolicy()).toMatchObject({ level: "deep", canObserve: false });
    expect(mocks.workspaceClient.setPollingEnabled).toHaveBeenCalledWith(false);
    expect(mocks.workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 20_000,
      pollIntervalBackground: 100_000,
    });
    clearServiceMocks(mocks);

    powerHandlers.get("unlock-screen")!();

    expect(powerPolicyModule.getPowerPolicy().level).toBe("active");
    expect(mocks.workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
    expect(mocks.workspaceClient.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.statsService.refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves deep on window focus when the unlock event never arrives", () => {
    const { mocks, main } = setup();

    powerHandlers.get("lock-screen")!();
    expect(powerPolicyModule.getPowerPolicy().level).toBe("deep");
    clearServiceMocks(mocks);

    // Unbalanced lock: the OS never fires unlock-screen, so focus is the only
    // evidence the screen came back. Without reconciliation here the policy
    // would stay deep until the app restarts.
    focus(main);

    expect(powerPolicyModule.getPowerPolicy()).toMatchObject({
      level: "active",
      canObserve: true,
    });
    expect(mocks.workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
    expect(mocks.workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 2_000,
      pollIntervalBackground: 10_000,
    });
  });

  it("re-reads the windows on unlock rather than assuming the prior focus", () => {
    const { mocks, main } = setup();

    powerHandlers.get("lock-screen")!();
    // Focus moved elsewhere while locked; no blur event reaches us.
    main.focused = false;
    clearServiceMocks(mocks);

    powerHandlers.get("unlock-screen")!();

    expect(powerPolicyModule.getPowerPolicy()).toMatchObject({
      level: "saving",
      canObserve: false,
    });
    expect(mocks.workspaceClient.setPollingEnabled).not.toHaveBeenCalled();
    expect(mocks.workspaceClient.refresh).not.toHaveBeenCalled();
  });

  it("doubles the pollers on battery while the user is still watching", () => {
    const { mocks } = setup();

    powerHandlers.get("on-battery")!();

    expect(powerPolicyModule.getPowerPolicy()).toMatchObject({ level: "saving", canObserve: true });
    expect(mocks.workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 4_000,
      pollIntervalBackground: 20_000,
    });
    // Still observable: workspace polling stays on and nothing is refreshed.
    expect(mocks.workspaceClient.setPollingEnabled).not.toHaveBeenCalled();
    expect(mocks.workspaceClient.refresh).not.toHaveBeenCalled();
    expect(focusThrottleModule.isFocusThrottled()).toBe(false);
    expect(focusThrottleModule.getFocusThrottlePollMultiplier()).toBe(2);
    expect(mocks.ptyClient.setPowerPolicy).toHaveBeenCalledWith("saving");
    clearServiceMocks(mocks);

    powerHandlers.get("on-ac")!();

    expect(mocks.workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 2_000,
      pollIntervalBackground: 10_000,
    });
    expect(mocks.ptyClient.setPowerPolicy).toHaveBeenCalledWith("active");
  });

  it("applies battery power reported at launch as soon as the throttle is set up", async () => {
    vi.mocked((await import("electron")).powerMonitor.isOnBatteryPower).mockReturnValue(true);
    powerMonitorModule.setupPowerMonitor({
      getPtyClient: () => null,
      getWorkspaceClient: () => null,
    });
    const mocks = createMockDeps();

    powerMonitorModule.setupWindowFocusThrottle(mocks.deps);

    expect(mocks.workspaceClient.updateMonitorConfig).toHaveBeenCalledWith({
      pollIntervalActive: 4_000,
      pollIntervalBackground: 20_000,
    });
    // The pty host and any loaded view booted assuming `active`.
    expect(mocks.ptyClient.setPowerPolicy).toHaveBeenCalledWith("saving");
    expect(mockViewSend).toHaveBeenCalledWith("events:push", {
      name: "system:power-policy-changed",
      payload: expect.objectContaining({ level: "saving" }),
    });
  });

  it("owes the wake refresh to whoever comes back when resume finds the screen locked", async () => {
    const { mocks } = setup();
    powerHandlers.get("lock-screen")!();
    powerHandlers.get("suspend")!();
    clearServiceMocks(mocks);

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mocks.workspaceClient.setPollingEnabled).not.toHaveBeenCalledWith(true);
    expect(mocks.workspaceClient.refreshOnWake).not.toHaveBeenCalled();

    powerHandlers.get("unlock-screen")!();

    expect(mocks.workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
    expect(mocks.workspaceClient.refreshOnWake).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceClient.refresh).not.toHaveBeenCalled();
  });

  it("refreshes once when the user unlocks during the resume delay", async () => {
    const { mocks } = setup();
    powerHandlers.get("lock-screen")!();
    powerHandlers.get("suspend")!();
    clearServiceMocks(mocks);

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(1000);
    powerHandlers.get("unlock-screen")!();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.workspaceClient.refreshOnWake).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceClient.refresh).not.toHaveBeenCalled();
  });

  it("settles an earlier wake's debt in the next recovery, not twice", async () => {
    const { mocks } = setup();
    powerHandlers.get("lock-screen")!();
    powerHandlers.get("suspend")!();
    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000); // woke to a locked screen: debt owed
    powerHandlers.get("suspend")!();
    clearServiceMocks(mocks);

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(1000);
    powerHandlers.get("unlock-screen")!(); // lands inside the second delay
    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.workspaceClient.refreshOnWake).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceClient.refresh).not.toHaveBeenCalled();
  });

  it("drops a recovery the machine slept through before it finished", async () => {
    const { mocks } = setup();
    let releaseReady: () => void = () => {};
    vi.mocked(mocks.workspaceClient.waitForReady).mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseReady = resolve))
    );
    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000); // handler now awaits the host
    powerHandlers.get("suspend")!();
    clearServiceMocks(mocks);

    releaseReady();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.workspaceClient.setPollingEnabled).not.toHaveBeenCalledWith(true);
    expect(mocks.workspaceClient.refreshOnWake).not.toHaveBeenCalled();
  });

  it("keeps the wake refresh owed when recovery fails before deciding", async () => {
    const { mocks, main } = setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(mocks.workspaceClient.waitForReady).mockRejectedValueOnce(new Error("not ready"));
    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);
    clearServiceMocks(mocks);

    blur(main);
    focus(main);

    expect(mocks.workspaceClient.refreshOnWake).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceClient.refresh).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns to an ordinary refresh once the wake has been paid", async () => {
    const { mocks, main } = setup();
    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.workspaceClient.refreshOnWake).toHaveBeenCalledTimes(1);
    clearServiceMocks(mocks);

    blur(main);
    focus(main);

    expect(mocks.workspaceClient.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceClient.refreshOnWake).not.toHaveBeenCalled();
  });

  it("reconciles a window that is already showing when it registers", () => {
    const { mocks, main } = setup();
    main.focused = false;
    windows = [];
    main.handlers.get("closed")!();
    expect(powerPolicyModule.getPowerPolicy().level).toBe("deep");
    clearServiceMocks(mocks);

    // A macOS reopen: the new window shows and focuses during async setup,
    // before it registers — and before the focus listener could see it tracked.
    const reopened = createFakeWindow({ focused: true });
    powerMonitorModule.registerWindowForFocusThrottle(reopened.win);

    expect(powerPolicyModule.getPowerPolicy().level).toBe("active");
    expect(mocks.workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
    expect(mocks.workspaceClient.refresh).toHaveBeenCalledTimes(1);
  });

  it("takes a focus event as proof a window is on screen", () => {
    const { main } = setup();
    main.focused = false;
    windows = [];
    main.handlers.get("closed")!();
    expect(powerPolicyModule.getPowerPolicy().level).toBe("deep");

    // Focus lands before the reopened window is registered.
    appHandlers.get("browser-window-focus")!();

    expect(powerPolicyModule.getPowerPolicy()).toMatchObject({ level: "active", canObserve: true });
  });

  it("does not reconcile a window registered before it is shown", () => {
    const { mocks, main } = setup();
    blur(main);
    clearServiceMocks(mocks);

    const pending = createFakeWindow({ focused: false, visible: false });
    powerMonitorModule.registerWindowForFocusThrottle(pending.win);

    expect(mocks.workspaceClient.updateMonitorConfig).not.toHaveBeenCalled();
    expect(powerPolicyModule.getPowerPolicy().level).toBe("saving");
  });

  it("goes deep when the last window closes", () => {
    const { mocks, main } = setup();

    main.focused = false;
    windows = [];
    main.handlers.get("closed")!();

    expect(powerPolicyModule.getPowerPolicy().level).toBe("deep");
    expect(mocks.ptyClient.setPowerPolicy).toHaveBeenCalledWith("deep");
  });

  it("broadcasts every policy change to the renderer views", () => {
    const { main } = setup();

    blur(main);

    expect(mockViewSend).toHaveBeenCalledWith("events:push", {
      name: "system:power-policy-changed",
      payload: expect.objectContaining({ level: "saving", canObserve: false }),
    });
  });

  it("skips deps-based services gracefully when getters return null", () => {
    powerMonitorModule.setupWindowFocusThrottle({
      getPtyClient: () => null,
      getWorkspaceClient: () => null,
      getProjectStatsService: () => null,
      getIdleTerminalNotificationService: () => null,
    });
    const main = createFakeWindow();
    powerMonitorModule.registerWindowForFocusThrottle(main.win);

    blur(main);

    // Module-level setters are always called (they no-op internally via idempotency guard)
    expect(mockSetDiskSpaceInterval).toHaveBeenCalledWith(1_500_000);
    expect(mockSetAppMetricsInterval).toHaveBeenCalledWith(150_000);
  });
});
