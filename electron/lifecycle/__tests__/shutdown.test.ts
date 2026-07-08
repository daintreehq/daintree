import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  on: vi.fn(),
  exit: vi.fn(),
  getPath: vi.fn(() => "/tmp/test-shutdown"),
}));

const persistAgentSessionMock = vi.hoisted(() =>
  vi.fn((_record: unknown, _userData?: string) => Promise.resolve())
);

vi.mock("../../services/pty/agentSessionHistory.js", () => ({
  persistAgentSession: persistAgentSessionMock,
}));

// Retention is read from the electron-store singleton, which isn't wired in
// this unit test; stub the accessor so the shutdown journaling path gets a
// plain value instead of touching the real store.
vi.mock("../../services/pty/agentSessionRetention.js", () => ({
  getAgentSessionRetentionDays: vi.fn(() => 30),
}));

const dialogMock = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
}));

vi.mock("electron", () => ({
  app: appMock,
  dialog: dialogMock,
}));

const projectStoreMock = vi.hoisted(() => ({
  getAllProjects: vi.fn(() => []),
  getProjectState: vi.fn(),
  saveProjectState: vi.fn(),
  enqueueProjectStateUpdate: vi.fn(async () => undefined),
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

const crashRecoveryMock = vi.hoisted(() => ({
  cleanupOnExit: vi.fn(),
  takeBackup: vi.fn(),
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: vi.fn(() => crashRecoveryMock),
}));

const crashLoopGuardMock = vi.hoisted(() => ({
  markCleanExit: vi.fn(),
}));

vi.mock("../../services/CrashLoopGuardService.js", () => ({
  getCrashLoopGuard: vi.fn(() => crashLoopGuardMock),
}));

const quitWarningMock = vi.hoisted(() => ({
  getActiveAgentCount: vi.fn(() => 0),
  showQuitWarning: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../utils/quitWarning.js", () => quitWarningMock);

const agentStoreMock = vi.hoisted(() => ({
  getAgentsByAvailability: vi.fn(() => []),
}));

vi.mock("../../services/AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: vi.fn(() => agentStoreMock),
  disposeAgentAvailabilityStore: vi.fn(),
}));

vi.mock("../../services/PtyClient.js", () => ({
  disposePtyClient: vi.fn(),
}));

vi.mock("../../services/WorkspaceClient.js", () => ({
  disposeWorkspaceClient: vi.fn(),
}));

const mcpServerMock = vi.hoisted(() => ({
  stop: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../services/McpServerService.js", () => ({
  mcpServerService: mcpServerMock,
}));

vi.mock("../../ipc/utils.js", () => ({
  drainRateLimitQueues: vi.fn(),
}));

const signalShutdownMock = vi.hoisted(() => ({
  isSignalShutdown: vi.fn(() => false),
  clearSafetyBeltTimer: vi.fn(),
}));

vi.mock("../signalShutdownState.js", () => signalShutdownMock);

const dbMaintenanceMock = vi.hoisted(() => ({
  dispose: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../services/DatabaseMaintenanceService.js", () => ({
  getDatabaseMaintenanceService: vi.fn(() => dbMaintenanceMock),
}));

const closeSharedDbMock = vi.hoisted(() => ({
  closeSharedDb: vi.fn(),
}));

vi.mock("../../services/persistence/db.js", () => closeSharedDbMock);

const closeTelemetryMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../../services/TelemetryService.js", () => ({
  closeTelemetry: closeTelemetryMock,
}));

const isSmokeTestMock = vi.hoisted(() => ({ value: false }));

vi.mock("../../setup/environment.js", () => ({
  get isSmokeTest() {
    return isSmokeTestMock.value;
  },
}));

const hibernationMock = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock("../../services/HibernationService.js", () => ({
  getHibernationService: vi.fn(() => hibernationMock),
}));

const idleTerminalMock = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock("../../services/IdleTerminalNotificationService.js", () => ({
  getIdleTerminalNotificationService: vi.fn(() => idleTerminalMock),
}));

const systemSleepMock = vi.hoisted(() => ({ dispose: vi.fn() }));
vi.mock("../../services/SystemSleepService.js", () => ({
  getSystemSleepService: vi.fn(() => systemSleepMock),
}));

const agentConnectivityMock = vi.hoisted(() => ({ dispose: vi.fn() }));
const connectivityRegistryMock = vi.hoisted(() => ({ dispose: vi.fn() }));
vi.mock("../../services/connectivity/index.js", () => ({
  agentConnectivityService: agentConnectivityMock,
  getServiceConnectivityRegistry: vi.fn(() => connectivityRegistryMock),
}));

const notificationServiceMock = vi.hoisted(() => ({ dispose: vi.fn() }));
vi.mock("../../services/NotificationService.js", () => ({
  notificationService: notificationServiceMock,
}));

const pluginServiceMock = vi.hoisted(() => ({ setWorkspaceClient: vi.fn() }));
vi.mock("../../services/PluginService.js", () => ({
  pluginService: pluginServiceMock,
}));

const ccrConfigMock = vi.hoisted(() => ({ stopWatching: vi.fn(() => Promise.resolve()) }));
const resourceProfileMock = vi.hoisted(() => ({ stop: vi.fn() }));
const worktreePortBrokerMock = vi.hoisted(() => ({ dispose: vi.fn() }));
const mainProcessWatchdogMock = vi.hoisted(() => ({ dispose: vi.fn() }));
const agentNotificationMock = vi.hoisted(() => ({ dispose: vi.fn() }));
const autoUpdaterMock = vi.hoisted(() => ({ dispose: vi.fn() }));
const windowsStoreNotifierMock = vi.hoisted(() => ({ dispose: vi.fn() }));

const serviceRefsMock = vi.hoisted(() => {
  let ccr: { stopWatching: () => Promise<void> } | null = null;
  let resourceProfile: { stop: () => void } | null = null;
  let worktreePortBroker: { dispose: () => void } | null = null;
  let watchdog: { dispose: () => void } | null = null;
  let agentNotification: { dispose: () => void } | null = null;
  let autoUpdater: { dispose: () => void } | null = null;
  let windowsStoreNotifier: { dispose: () => void } | null = null;
  return {
    setInitialState: (state: {
      ccr?: typeof ccr;
      resourceProfile?: typeof resourceProfile;
      worktreePortBroker?: typeof worktreePortBroker;
      watchdog?: typeof watchdog;
      agentNotification?: typeof agentNotification;
      autoUpdater?: typeof autoUpdater;
      windowsStoreNotifier?: typeof windowsStoreNotifier;
    }) => {
      ccr = state.ccr ?? null;
      resourceProfile = state.resourceProfile ?? null;
      worktreePortBroker = state.worktreePortBroker ?? null;
      watchdog = state.watchdog ?? null;
      agentNotification = state.agentNotification ?? null;
      autoUpdater = state.autoUpdater ?? null;
      windowsStoreNotifier = state.windowsStoreNotifier ?? null;
    },
    getCcrConfigService: vi.fn(() => ccr),
    setCcrConfigService: vi.fn((v: typeof ccr) => {
      ccr = v;
    }),
    getResourceProfileService: vi.fn(() => resourceProfile),
    setResourceProfileService: vi.fn((v: typeof resourceProfile) => {
      resourceProfile = v;
    }),
    getWorktreePortBrokerRef: vi.fn(() => worktreePortBroker),
    setWorktreePortBrokerRef: vi.fn((v: typeof worktreePortBroker) => {
      worktreePortBroker = v;
    }),
    setWorkspaceClientRef: vi.fn(),
    getMainProcessWatchdogClientRef: vi.fn(() => watchdog),
    setMainProcessWatchdogClientRef: vi.fn((v: typeof watchdog) => {
      watchdog = v;
    }),
    getAgentNotificationServiceRef: vi.fn(() => agentNotification),
    setAgentNotificationServiceRef: vi.fn((v: typeof agentNotification) => {
      agentNotification = v;
    }),
    getAutoUpdaterServiceRef: vi.fn(() => autoUpdater),
    setAutoUpdaterServiceRef: vi.fn((v: typeof autoUpdater) => {
      autoUpdater = v;
    }),
    getWindowsStoreNotifierServiceRef: vi.fn(() => windowsStoreNotifier),
    setWindowsStoreNotifierServiceRef: vi.fn((v: typeof windowsStoreNotifier) => {
      windowsStoreNotifier = v;
    }),
  };
});

vi.mock("../../window/serviceRefs.js", () => serviceRefsMock);

const deferredInitQueueMock = vi.hoisted(() => ({
  haltDeferredQueue: vi.fn(),
}));

vi.mock("../../window/deferredInitQueue.js", () => deferredInitQueueMock);

import type { ShutdownDeps } from "../shutdown.js";

function makeDeps(overrides?: Partial<ShutdownDeps>): ShutdownDeps {
  return {
    getPtyClient: vi.fn(() => null),
    setPtyClient: vi.fn(),
    getWorkspaceClient: vi.fn(() => null),
    getCleanupIpcHandlers: vi.fn(() => null),
    setCleanupIpcHandlers: vi.fn(),
    getCleanupErrorHandlers: vi.fn(() => null),
    setCleanupErrorHandlers: vi.fn(),
    getStopEventLoopLagMonitor: vi.fn(() => null),
    setStopEventLoopLagMonitor: vi.fn(),
    getStopProcessMemoryMonitor: vi.fn(() => null),
    setStopProcessMemoryMonitor: vi.fn(),
    getStopAppMetricsMonitor: vi.fn(() => null),
    setStopAppMetricsMonitor: vi.fn(),
    getStopDiskSpaceMonitor: vi.fn(() => null),
    setStopDiskSpaceMonitor: vi.fn(),
    ...overrides,
  };
}

function makeEvent() {
  return { preventDefault: vi.fn() };
}

describe("registerShutdownHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.DAINTREE_E2E_MODE;
    isSmokeTestMock.value = false;
    signalShutdownMock.isSignalShutdown.mockReturnValue(false);
    quitWarningMock.getActiveAgentCount.mockReturnValue(0);
    quitWarningMock.showQuitWarning.mockResolvedValue(true);
    ccrConfigMock.stopWatching.mockResolvedValue(undefined);
    serviceRefsMock.setInitialState({});
  });

  async function setup(overrides?: Partial<ShutdownDeps>) {
    const { registerShutdownHandler } = await import("../shutdown.js");
    const deps = makeDeps(overrides);
    registerShutdownHandler(deps);
    const beforeQuitCb = appMock.on.mock.calls.find(
      (args: string[]) => args[0] === "before-quit"
    )![1] as (event: { preventDefault: () => void }) => Promise<void>;
    return { deps, beforeQuitCb };
  }

  it("skips cleanup entirely in smoke test mode", async () => {
    isSmokeTestMock.value = true;
    const { beforeQuitCb } = await setup();
    const event = makeEvent();
    await beforeQuitCb(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();
  });

  it("runs cleanup without dialog when no window and no signal", async () => {
    const { beforeQuitCb } = await setup();
    const event = makeEvent();
    await beforeQuitCb(event);

    // Should still preventDefault and run cleanup
    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitWarningMock.showQuitWarning).not.toHaveBeenCalled();

    // Wait for cleanup promise chain to settle
    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
    expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalled();
  });

  it("runs cleanup without dialog on signal shutdown even with active agents", async () => {
    signalShutdownMock.isSignalShutdown.mockReturnValue(true);
    quitWarningMock.getActiveAgentCount.mockReturnValue(3);

    const mainWindow = { isMinimized: vi.fn() } as unknown as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      windowRegistry: {
        getPrimary: () => ({ browserWindow: mainWindow }),
      } as unknown as ShutdownDeps["windowRegistry"],
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitWarningMock.showQuitWarning).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
    expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalled();
  });

  it("skips dialog in e2e mode even when active agents exist", async () => {
    process.env.DAINTREE_E2E_MODE = "1";
    quitWarningMock.getActiveAgentCount.mockReturnValue(2);

    const mainWindow = {} as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      windowRegistry: {
        getPrimary: () => ({ browserWindow: mainWindow }),
      } as unknown as ShutdownDeps["windowRegistry"],
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitWarningMock.showQuitWarning).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
    expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalled();
  });

  it("shows dialog when window exists, agents active, and user cancels", async () => {
    quitWarningMock.getActiveAgentCount.mockReturnValue(2);
    quitWarningMock.showQuitWarning.mockResolvedValue(false);

    const mainWindow = {} as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      windowRegistry: {
        getPrimary: () => ({ browserWindow: mainWindow }),
      } as unknown as ShutdownDeps["windowRegistry"],
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitWarningMock.showQuitWarning).toHaveBeenCalled();
    expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();
  });

  it("halts the deferred init queue before the cleanup chain starts", async () => {
    const { drainRateLimitQueues } = await import("../../ipc/utils.js");
    const { beforeQuitCb } = await setup();
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(deferredInitQueueMock.haltDeferredQueue).toHaveBeenCalledTimes(1);
    const haltOrder = deferredInitQueueMock.haltDeferredQueue.mock.invocationCallOrder[0];
    const drainOrder = vi.mocked(drainRateLimitQueues).mock.invocationCallOrder[0];
    expect(haltOrder).toBeLessThan(drainOrder);

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
  });

  it("halts the deferred init queue after the user confirms quit", async () => {
    quitWarningMock.getActiveAgentCount.mockReturnValue(2);
    quitWarningMock.showQuitWarning.mockResolvedValue(true);

    const mainWindow = {} as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      windowRegistry: {
        getPrimary: () => ({ browserWindow: mainWindow }),
      } as unknown as ShutdownDeps["windowRegistry"],
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(deferredInitQueueMock.haltDeferredQueue).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
  });

  it("does not halt the deferred init queue when the user cancels quit", async () => {
    quitWarningMock.getActiveAgentCount.mockReturnValue(2);
    quitWarningMock.showQuitWarning.mockResolvedValue(false);

    const mainWindow = {} as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      windowRegistry: {
        getPrimary: () => ({ browserWindow: mainWindow }),
      } as unknown as ShutdownDeps["windowRegistry"],
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(deferredInitQueueMock.haltDeferredQueue).not.toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();
  });

  it("shows dialog when window exists, agents active, and user confirms", async () => {
    quitWarningMock.getActiveAgentCount.mockReturnValue(2);
    quitWarningMock.showQuitWarning.mockResolvedValue(true);

    const mainWindow = {} as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      windowRegistry: {
        getPrimary: () => ({ browserWindow: mainWindow }),
      } as unknown as ShutdownDeps["windowRegistry"],
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(quitWarningMock.showQuitWarning).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
    expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalled();
  });

  it("skips dialog when window exists but no active agents", async () => {
    quitWarningMock.getActiveAgentCount.mockReturnValue(0);

    const mainWindow = {} as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      windowRegistry: {
        getPrimary: () => ({ browserWindow: mainWindow }),
      } as unknown as ShutdownDeps["windowRegistry"],
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(quitWarningMock.showQuitWarning).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
    expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalled();
  });

  it("runs cleanup when no window and signal shutdown", async () => {
    signalShutdownMock.isSignalShutdown.mockReturnValue(true);

    const { beforeQuitCb } = await setup();
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitWarningMock.showQuitWarning).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
    expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalled();
  });

  describe("SQLite connection close", () => {
    it("disposes db maintenance before closeSharedDb", async () => {
      const callOrder: string[] = [];
      dbMaintenanceMock.dispose.mockImplementation(async () => {
        callOrder.push("dispose");
      });
      closeSharedDbMock.closeSharedDb.mockImplementation(() => {
        callOrder.push("closeSharedDb");
      });

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(callOrder).toEqual(["dispose", "closeSharedDb"]);
    });

    it("still calls closeSharedDb and exits when dispose fails", async () => {
      dbMaintenanceMock.dispose.mockRejectedValue(new Error("dispose boom"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(closeSharedDbMock.closeSharedDb).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "[MAIN] Database maintenance dispose failed:",
        expect.any(Error)
      );
      warnSpy.mockRestore();
    });

    it("still exits when closeSharedDb throws", async () => {
      closeSharedDbMock.closeSharedDb.mockImplementation(() => {
        throw new Error("close boom");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(warnSpy).toHaveBeenCalledWith(
        "[MAIN] Failed to close SQLite connection:",
        expect.any(Error)
      );
      warnSpy.mockRestore();
    });
  });

  describe("Sentry telemetry flush before exit", () => {
    afterEach(() => {
      appMock.exit.mockReset();
      mcpServerMock.stop.mockReset();
      mcpServerMock.stop.mockReturnValue(Promise.resolve());
      closeTelemetryMock.mockReset();
      closeTelemetryMock.mockResolvedValue(undefined);
    });

    it("waits for closeTelemetry to resolve before app.exit(0) on clean shutdown", async () => {
      let resolveClose!: () => void;
      const closeDeferred = new Promise<void>((r) => {
        resolveClose = r;
      });
      closeTelemetryMock.mockReturnValue(closeDeferred);

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      // Give the cleanup chain a chance to reach closeTelemetry.
      await vi.waitFor(() => {
        expect(closeTelemetryMock).toHaveBeenCalled();
      });
      // The await must hold — exit MUST NOT fire until closeTelemetry resolves.
      expect(appMock.exit).not.toHaveBeenCalled();

      resolveClose();

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
    });

    it("waits for closeTelemetry to resolve before app.exit(0) on cleanup error (mcpServer error is silently caught)", async () => {
      mcpServerMock.stop.mockReturnValue(Promise.reject(new Error("MCP stop failed")));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let resolveClose!: () => void;
      const closeDeferred = new Promise<void>((r) => {
        resolveClose = r;
      });
      closeTelemetryMock.mockReturnValue(closeDeferred);

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(closeTelemetryMock).toHaveBeenCalled();
      });
      expect(appMock.exit).not.toHaveBeenCalled();

      resolveClose();

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      consoleSpy.mockRestore();
    });
  });

  describe("hard shutdown timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("calls app.exit(1) when cleanup hangs past hard timeout and leaves the crash marker on disk", async () => {
      mcpServerMock.stop.mockReturnValue(new Promise(() => {}));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      const event = makeEvent();
      await beforeQuitCb(event);

      await vi.advanceTimersByTimeAsync(10_000);
      // Drain the post-timeout async chain (closeTelemetry await + app.exit).
      await vi.runAllTimersAsync();

      expect(appMock.exit).toHaveBeenCalledWith(1);
      expect(appMock.exit).toHaveBeenCalledTimes(1);
      expect(closeTelemetryMock).toHaveBeenCalled();
      // Critical: a hard-timeout exit must NOT mark itself clean. The intact
      // marker file is the dirty-exit signal the next launch reads.
      expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
      expect(crashLoopGuardMock.markCleanExit).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[MAIN] Error during cleanup:",
        expect.objectContaining({
          message: expect.stringContaining("Hard shutdown timeout"),
        })
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "[MAIN] Error during cleanup:",
        expect.objectContaining({
          message: expect.stringContaining("service-disposal"),
        })
      );

      consoleSpy.mockRestore();
    });

    it("calls cleanupOnExit and markCleanExit only after the cleanup chain resolves on a clean shutdown", async () => {
      mcpServerMock.stop.mockReturnValue(Promise.resolve());

      const { beforeQuitCb } = await setup({});
      const event = makeEvent();
      await beforeQuitCb(event);

      // Immediately after before-quit returns, the cleanup chain hasn't resolved
      // yet — markers must not have been touched.
      expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
      expect(crashLoopGuardMock.markCleanExit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      // Now the chain has resolved and the success branch has marked clean.
      expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
      expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });

    it("still calls markCleanExit and exits with 0 when cleanupOnExit throws (independent failure modes)", async () => {
      mcpServerMock.stop.mockReturnValue(Promise.resolve());
      crashRecoveryMock.cleanupOnExit.mockImplementationOnce(() => {
        throw new Error("delete marker boom");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.advanceTimersByTimeAsync(100);

      expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
      expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
      expect(appMock.exit).toHaveBeenCalledWith(0);
      expect(warnSpy).toHaveBeenCalledWith(
        "[MAIN] CrashRecoveryService.cleanupOnExit failed:",
        expect.any(Error)
      );

      warnSpy.mockRestore();
    });

    it("still marks clean exit and exits with 0 when closeTelemetry rejects (telemetry must not gate marker cleanup)", async () => {
      mcpServerMock.stop.mockReturnValue(Promise.resolve());
      closeTelemetryMock.mockReturnValueOnce(Promise.reject(new Error("telemetry boom")));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.advanceTimersByTimeAsync(100);

      expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
      expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
      expect(appMock.exit).toHaveBeenCalledWith(0);
      expect(warnSpy).toHaveBeenCalledWith("[MAIN] closeTelemetry failed:", expect.any(Error));

      warnSpy.mockRestore();
    });

    it("normal cleanup exits with code 0 and timeout does not fire", async () => {
      mcpServerMock.stop.mockReturnValue(Promise.resolve());

      const { beforeQuitCb } = await setup({});
      const event = makeEvent();
      await beforeQuitCb(event);

      await vi.advanceTimersByTimeAsync(100);

      expect(appMock.exit).toHaveBeenCalledWith(0);
      expect(appMock.exit).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15_000);

      expect(appMock.exit).toHaveBeenCalledTimes(1);
    });

    it("mcpServer error is silently caught and cleanup exits with 0", async () => {
      mcpServerMock.stop.mockReturnValue(Promise.reject(new Error("MCP stop failed")));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      const event = makeEvent();
      await beforeQuitCb(event);

      await vi.advanceTimersByTimeAsync(100);

      expect(appMock.exit).toHaveBeenCalledWith(0);
      expect(consoleSpy).not.toHaveBeenCalledWith(
        "[MAIN] Error during cleanup:",
        expect.objectContaining({
          message: "MCP stop failed",
        })
      );

      consoleSpy.mockRestore();
    });
  });

  // The global services below used to be torn down by the `win.on("closed")`
  // handler in electron/window/windowServices.ts when the last window closed.
  // Issue #8604: on macOS, last-window-close does NOT quit the app, so a dock
  // reactivation could race the async teardown. They now live in `before-quit`
  // so they are disposed exactly once at app quit time.
  describe("global service disposal moved from last-window-close (issue #8604)", () => {
    it("disposes hibernation, idle-terminal, system-sleep, and connectivity services", async () => {
      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(hibernationMock.stop).toHaveBeenCalledTimes(1);
      expect(idleTerminalMock.stop).toHaveBeenCalledTimes(1);
      expect(systemSleepMock.dispose).toHaveBeenCalledTimes(1);
      expect(agentConnectivityMock.dispose).toHaveBeenCalledTimes(1);
      expect(connectivityRegistryMock.dispose).toHaveBeenCalledTimes(1);
      expect(notificationServiceMock.dispose).toHaveBeenCalledTimes(1);
    });

    it("disposes optional refs only when present and nulls them after", async () => {
      serviceRefsMock.setInitialState({
        ccr: ccrConfigMock,
        resourceProfile: resourceProfileMock,
        worktreePortBroker: worktreePortBrokerMock,
        watchdog: mainProcessWatchdogMock,
        agentNotification: agentNotificationMock,
        autoUpdater: autoUpdaterMock,
        windowsStoreNotifier: windowsStoreNotifierMock,
      });

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(ccrConfigMock.stopWatching).toHaveBeenCalledTimes(1);
      expect(resourceProfileMock.stop).toHaveBeenCalledTimes(1);
      expect(worktreePortBrokerMock.dispose).toHaveBeenCalledTimes(1);
      expect(mainProcessWatchdogMock.dispose).toHaveBeenCalledTimes(1);
      expect(agentNotificationMock.dispose).toHaveBeenCalledTimes(1);
      expect(autoUpdaterMock.dispose).toHaveBeenCalledTimes(1);
      expect(windowsStoreNotifierMock.dispose).toHaveBeenCalledTimes(1);

      // Refs nulled so any late callbacks no-op.
      expect(serviceRefsMock.setCcrConfigService).toHaveBeenCalledWith(null);
      expect(serviceRefsMock.setResourceProfileService).toHaveBeenCalledWith(null);
      expect(serviceRefsMock.setWorktreePortBrokerRef).toHaveBeenCalledWith(null);
      expect(serviceRefsMock.setMainProcessWatchdogClientRef).toHaveBeenCalledWith(null);
      expect(serviceRefsMock.setAgentNotificationServiceRef).toHaveBeenCalledWith(null);
      expect(serviceRefsMock.setAutoUpdaterServiceRef).toHaveBeenCalledWith(null);
      expect(serviceRefsMock.setWindowsStoreNotifierServiceRef).toHaveBeenCalledWith(null);
    });

    it("clears PluginService's WorkspaceClient reference during shutdown", async () => {
      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(pluginServiceMock.setWorkspaceClient).toHaveBeenCalledWith(null);
    });

    it("still exits cleanly when a moved disposal throws", async () => {
      hibernationMock.stop.mockImplementationOnce(() => {
        throw new Error("hibernation boom");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(warnSpy).toHaveBeenCalledWith(
        "[MAIN] HibernationService.stop failed:",
        expect.any(Error)
      );
      // Sibling disposals still run.
      expect(idleTerminalMock.stop).toHaveBeenCalled();
      expect(notificationServiceMock.dispose).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("still exits cleanly when ccrConfigService.stopWatching rejects", async () => {
      serviceRefsMock.setInitialState({ ccr: ccrConfigMock });
      ccrConfigMock.stopWatching.mockRejectedValueOnce(new Error("ccr boom"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(warnSpy).toHaveBeenCalledWith(
        "[MAIN] CcrConfigService.stopWatching failed:",
        expect.any(Error)
      );
      // Ref still cleared after the failed stop.
      expect(serviceRefsMock.setCcrConfigService).toHaveBeenCalledWith(null);

      warnSpy.mockRestore();
    });

    it("stops CCR watcher and clears PluginService before WorkspaceClient disposal", async () => {
      const order: string[] = [];
      serviceRefsMock.setInitialState({ ccr: ccrConfigMock });

      ccrConfigMock.stopWatching.mockImplementationOnce(async () => {
        order.push("ccr:stop");
      });
      pluginServiceMock.setWorkspaceClient.mockImplementationOnce(() => {
        order.push("plugin:setWorkspaceClient(null)");
      });
      const workspaceDispose = vi.fn(async () => {
        order.push("workspace:dispose");
      });

      const { beforeQuitCb } = await setup({
        getWorkspaceClient: () => ({ dispose: workspaceDispose }) as never,
      });
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      // CCR + plugin unwiring must complete before workspaceClient.dispose()
      // runs; otherwise a file-change callback could fire into a disposing client.
      const ccrIdx = order.indexOf("ccr:stop");
      const pluginIdx = order.indexOf("plugin:setWorkspaceClient(null)");
      const workspaceIdx = order.indexOf("workspace:dispose");
      expect(ccrIdx).toBeGreaterThanOrEqual(0);
      expect(pluginIdx).toBeGreaterThanOrEqual(0);
      expect(workspaceIdx).toBeGreaterThanOrEqual(0);
      expect(ccrIdx).toBeLessThan(workspaceIdx);
      expect(pluginIdx).toBeLessThan(workspaceIdx);
    });

    it("nulls workspaceClientRef after disposeWorkspaceClient runs", async () => {
      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(serviceRefsMock.setWorkspaceClientRef).toHaveBeenCalledWith(null);
    });

    it("still tears down PTY/workspace/watchdog when an earlier optional-ref dispose throws", async () => {
      serviceRefsMock.setInitialState({
        autoUpdater: autoUpdaterMock,
        worktreePortBroker: worktreePortBrokerMock,
        watchdog: mainProcessWatchdogMock,
      });
      autoUpdaterMock.dispose.mockImplementationOnce(() => {
        throw new Error("auto-updater boom");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      // The throwing optional-ref dispose must not strand the rest of the
      // sync block — the WorktreePortBroker, watchdog, and ref-nullers all
      // sit after it in source order.
      expect(worktreePortBrokerMock.dispose).toHaveBeenCalled();
      expect(mainProcessWatchdogMock.dispose).toHaveBeenCalled();
      expect(serviceRefsMock.setAutoUpdaterServiceRef).toHaveBeenCalledWith(null);
      expect(serviceRefsMock.setWorkspaceClientRef).toHaveBeenCalledWith(null);
      expect(warnSpy).toHaveBeenCalledWith(
        "[MAIN] AutoUpdaterService.dispose failed:",
        expect.any(Error)
      );

      warnSpy.mockRestore();
    });
  });

  describe("eager backup at quit-intent (issue #8699)", () => {
    it("snapshots backup at quit-intent before the cleanup chain runs", async () => {
      const order: string[] = [];
      crashRecoveryMock.takeBackup.mockImplementationOnce(() => {
        order.push("eager-backup");
      });
      mcpServerMock.stop.mockImplementationOnce(async () => {
        order.push("cleanup-chain");
      });

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(crashRecoveryMock.takeBackup).toHaveBeenCalled();
      // Eager backup must run before any async cleanup so a hard-timeout exit
      // can never skip the post-quit-intent snapshot.
      const eagerIdx = order.indexOf("eager-backup");
      const chainIdx = order.indexOf("cleanup-chain");
      expect(eagerIdx).toBeGreaterThanOrEqual(0);
      expect(chainIdx).toBeGreaterThanOrEqual(0);
      expect(eagerIdx).toBeLessThan(chainIdx);
    });

    it("skips eager backup in smoke test mode", async () => {
      isSmokeTestMock.value = true;
      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());
      expect(crashRecoveryMock.takeBackup).not.toHaveBeenCalled();
    });

    it("continues shutdown when eager takeBackup throws", async () => {
      crashRecoveryMock.takeBackup.mockImplementationOnce(() => {
        throw new Error("eager backup boom");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "[MAIN] Eager takeBackup at quit-intent failed:",
        expect.any(Error)
      );
      warnSpy.mockRestore();
    });
  });

  describe("safety-belt timer cancellation (issue #8699)", () => {
    it("clears safety-belt timer before app.exit(0) on clean shutdown", async () => {
      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(signalShutdownMock.clearSafetyBeltTimer).toHaveBeenCalled();
      // Order matters: belt MUST be cancelled before app.exit, otherwise a
      // slow closeTelemetry() above could let the belt fire after exit(0)
      // and clobber the exit code with exit(1).
      const exitOrder = appMock.exit.mock.invocationCallOrder[0];
      const clearOrders = signalShutdownMock.clearSafetyBeltTimer.mock.invocationCallOrder;
      const lastClearOrder = clearOrders[clearOrders.length - 1];
      expect(lastClearOrder).toBeLessThan(exitOrder);
    });

    it("clears safety-belt timer before app.exit(1) on hard timeout", async () => {
      vi.useFakeTimers();
      mcpServerMock.stop.mockReturnValue(new Promise(() => {}));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.runAllTimersAsync();

      expect(appMock.exit).toHaveBeenCalledWith(1);
      expect(signalShutdownMock.clearSafetyBeltTimer).toHaveBeenCalled();
      const exitOrder = appMock.exit.mock.invocationCallOrder[0];
      const clearOrders = signalShutdownMock.clearSafetyBeltTimer.mock.invocationCallOrder;
      const lastClearOrder = clearOrders[clearOrders.length - 1];
      expect(lastClearOrder).toBeLessThan(exitOrder);

      consoleSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  describe("resume journaling on shutdown", () => {
    beforeEach(() => {
      // The hard-timeout test above leaves mcpServerMock.stop returning a
      // never-resolving promise; the suite's beforeEach only clearAllMocks
      // (history, not implementations), so reset it here or the cleanup chain
      // hangs and app.exit is never reached.
      mcpServerMock.stop.mockResolvedValue(undefined);
      persistAgentSessionMock.mockResolvedValue(undefined);
    });

    function makePtyClient(overrides?: Record<string, unknown>) {
      return {
        gracefulKillByProject: vi.fn(async () => []),
        getAllTerminalsAsync: vi.fn(async () => []),
        dispose: vi.fn(),
        ...overrides,
      } as never;
    }

    const agentTerminal = {
      id: "t1",
      launchAgentId: "claude",
      worktreeId: "wt-1",
      title: "Claude",
      projectId: "proj-1",
      cwd: "/repo",
      agentLaunchFlags: ["--resume"],
      agentModelId: "claude-opus-4-8",
    };

    it("journals a resume record for each captured agent session", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([{ id: "proj-1" }] as never);
      const ptyClient = makePtyClient({
        getAllTerminalsAsync: vi.fn(async () => [agentTerminal, { id: "t2", cwd: "/repo" }]),
        gracefulKillByProject: vi.fn(async () => [
          { id: "t1", agentSessionId: "sess-1" },
          { id: "t2", agentSessionId: null },
        ]),
      });
      const workspaceClient = {
        dispose: vi.fn(),
        getMonitorAsync: vi.fn(async () => ({ branch: "feature/x" })),
      };
      const { beforeQuitCb } = await setup({
        getPtyClient: () => ptyClient,
        getWorkspaceClient: () => workspaceClient as never,
      });

      await beforeQuitCb(makeEvent());
      await vi.waitFor(() => expect(appMock.exit).toHaveBeenCalled());

      expect(persistAgentSessionMock).toHaveBeenCalledTimes(1);
      const record = persistAgentSessionMock.mock.calls[0][0] as Record<string, unknown>;
      expect(record.sessionId).toBe("sess-1");
      expect(record.agentId).toBe("claude");
      expect(record.cwd).toBe("/repo");
      expect(record.branch).toBe("feature/x");
    });

    it("does not journal non-agent terminals or null-session captures", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([{ id: "proj-1" }] as never);
      const ptyClient = makePtyClient({
        getAllTerminalsAsync: vi.fn(async () => [{ id: "t2", cwd: "/repo" }]),
        gracefulKillByProject: vi.fn(async () => [{ id: "t2", agentSessionId: null }]),
      });
      const { beforeQuitCb } = await setup({ getPtyClient: () => ptyClient });

      await beforeQuitCb(makeEvent());
      await vi.waitFor(() => expect(appMock.exit).toHaveBeenCalled());

      expect(persistAgentSessionMock).not.toHaveBeenCalled();
    });

    it("journals captures from every project even if one persist call fails", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([
        { id: "proj-1" },
        { id: "proj-2" },
      ] as never);
      const ptyClient = makePtyClient({
        getAllTerminalsAsync: vi.fn(async () => [
          { ...agentTerminal, id: "t1", worktreeId: "wt-1" },
          { ...agentTerminal, id: "t2", worktreeId: "wt-2" },
        ]),
        gracefulKillByProject: vi.fn(async (pid: string) =>
          pid === "proj-1"
            ? [{ id: "t1", agentSessionId: "sess-1" }]
            : [{ id: "t2", agentSessionId: "sess-2" }]
        ),
      });
      const workspaceClient = {
        dispose: vi.fn(),
        getMonitorAsync: vi.fn(async () => ({ branch: "feature/x" })),
      };
      // First persist rejects; the loop's per-record try/catch must still
      // journal the second project's capture.
      persistAgentSessionMock
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValue(undefined);

      const { beforeQuitCb } = await setup({
        getPtyClient: () => ptyClient,
        getWorkspaceClient: () => workspaceClient as never,
      });

      await beforeQuitCb(makeEvent());
      await vi.waitFor(() => expect(appMock.exit).toHaveBeenCalled());

      expect(persistAgentSessionMock).toHaveBeenCalledTimes(2);
      const persistedIds = persistAgentSessionMock.mock.calls.map(
        (c) => (c[0] as Record<string, unknown>).sessionId
      );
      expect(persistedIds).toContain("sess-1");
      expect(persistedIds).toContain("sess-2");
    });

    it("still journals (branch undefined) when the branch lookup rejects", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([{ id: "proj-1" }] as never);
      const ptyClient = makePtyClient({
        getAllTerminalsAsync: vi.fn(async () => [agentTerminal]),
        gracefulKillByProject: vi.fn(async () => [{ id: "t1", agentSessionId: "sess-1" }]),
      });
      const workspaceClient = {
        dispose: vi.fn(),
        getMonitorAsync: vi.fn(async () => {
          throw new Error("workspace host gone");
        }),
      };
      const { beforeQuitCb } = await setup({
        getPtyClient: () => ptyClient,
        getWorkspaceClient: () => workspaceClient as never,
      });

      await beforeQuitCb(makeEvent());
      await vi.waitFor(() => expect(appMock.exit).toHaveBeenCalled());

      expect(persistAgentSessionMock).toHaveBeenCalledTimes(1);
      const record = persistAgentSessionMock.mock.calls[0][0] as Record<string, unknown>;
      expect(record.sessionId).toBe("sess-1");
      expect(record.branch).toBeUndefined();
    });
  });
});
