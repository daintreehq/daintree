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
  enqueueProjectStateUpdate: vi.fn<
    (id: string, updater: (state: unknown) => unknown) => Promise<void>
  >(async () => undefined),
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
  isHelpTerminal: vi.fn(() => false),
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

const projectCheckServiceMock = vi.hoisted(() => ({ dispose: vi.fn() }));

vi.mock("../../services/ProjectCheckService.js", () => ({
  projectCheckService: projectCheckServiceMock,
}));

const mcpServerMock = vi.hoisted(() => ({
  stop: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../services/McpServerService.js", () => ({
  mcpServerService: mcpServerMock,
}));

// The shutdown chain reaches this module through a dynamic import, so the export
// is exposed behind a getter that can be armed to throw. Arming it makes the
// chain's `const { drainRateLimitQueues } = await import(...)` statement itself
// fail, which a plain throwing mock function cannot — that would only prove the
// CALL is guarded. It is a stand-in, not a true module-resolution failure: the
// throw happens when the binding is read rather than when the loader rejects, so
// a refactor that split the import and the destructure across the `try` boundary
// could still pass. Armed after `setup()` so only the chain's import sees it.
const ipcUtilsMock = vi.hoisted(() => ({
  failLoad: false,
  drainRateLimitQueues: vi.fn(),
}));

vi.mock("../../ipc/utils.js", () => ({
  get drainRateLimitQueues() {
    if (ipcUtilsMock.failLoad) {
      throw new Error("app.asar replaced under the running process");
    }
    return ipcUtilsMock.drainRateLimitQueues;
  },
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

const connectivityRegistryMock = vi.hoisted(() => ({ dispose: vi.fn() }));
vi.mock("../../services/connectivity/index.js", () => ({
  getServiceConnectivityRegistry: vi.fn(() => connectivityRegistryMock),
}));

const notificationServiceMock = vi.hoisted(() => ({ dispose: vi.fn() }));
vi.mock("../../services/NotificationService.js", () => ({
  notificationService: notificationServiceMock,
}));

const pluginServiceMock = vi.hoisted(() => ({
  setWorkspaceClient: vi.fn(),
  shutdownManagedProcesses: vi.fn(async () => {}),
}));
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

const openWindowsTrackerMock = vi.hoisted(() => ({
  freezeAndSnapshotOpenWindows: vi.fn(),
}));

vi.mock("../../window/openWindowsTracker.js", () => openWindowsTrackerMock);

// Runs in the post-cleanup tail, outside the hard-timeout race. Mocked so a test
// can wedge it and prove the run still settles (issue #11104).
const performanceTraceMock = vi.hoisted(() => ({
  stopPerformanceTraceIfActive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../utils/performanceTrace.js", () => performanceTraceMock);

import type { ShutdownDeps } from "../shutdown.js";
import {
  CLEANUP_TIMEOUT_MS,
  PROJECT_GRACEFUL_KILL_TIMEOUT_MS,
  SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_TAIL_TIMEOUT_MS,
} from "../shutdownConfig.js";

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
    const exited = new Promise<void>((resolve) => {
      appMock.exit.mockImplementationOnce(() => resolve());
    });
    await beforeQuitCb(event);

    // Should still preventDefault and run cleanup
    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitWarningMock.showQuitWarning).not.toHaveBeenCalled();

    // Shutdown loads cleanup services asynchronously; await its completion
    // instead of racing vi.waitFor's one-second polling deadline under load.
    await exited;
    expect(appMock.exit).toHaveBeenCalledWith(0);
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
    const exited = new Promise<void>((resolve) => {
      appMock.exit.mockImplementationOnce(() => resolve());
    });
    await beforeQuitCb(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitWarningMock.showQuitWarning).not.toHaveBeenCalled();

    await exited;
    expect(appMock.exit).toHaveBeenCalledWith(0);
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

    // haltDeferredQueue runs in the chain's synchronous prefix; the drain sits
    // behind the chain's dynamic import of ipc/utils, so wait for it rather than
    // counting microtasks. The invariant under test is the ORDER, not the timing.
    expect(deferredInitQueueMock.haltDeferredQueue).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(drainRateLimitQueues).toHaveBeenCalled();
    });
    const haltOrder = deferredInitQueueMock.haltDeferredQueue.mock.invocationCallOrder[0];
    const drainOrder = vi.mocked(drainRateLimitQueues).mock.invocationCallOrder[0];
    expect(haltOrder).toBeLessThan(drainOrder);

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
  });

  it("snapshots the open-window manifest before the database closes", async () => {
    // Continuous persistence covers force-quit, but a debounce still owing an
    // unsaved project switch is only captured here — and the capture has to
    // beat closeSharedDb, which would otherwise silently reopen the DB (#11492).
    const { beforeQuitCb } = await setup();
    await beforeQuitCb(makeEvent());

    expect(openWindowsTrackerMock.freezeAndSnapshotOpenWindows).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(closeSharedDbMock.closeSharedDb).toHaveBeenCalled();
    });
    const snapshotOrder =
      openWindowsTrackerMock.freezeAndSnapshotOpenWindows.mock.invocationCallOrder[0];
    const closeOrder = closeSharedDbMock.closeSharedDb.mock.invocationCallOrder[0];
    expect(snapshotOrder).toBeLessThan(closeOrder);

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
  });

  it("does not snapshot the open-window manifest when the quit is cancelled", async () => {
    // A cancelled quit must leave the manifest live — freezing is permanent.
    quitWarningMock.getActiveAgentCount.mockReturnValue(2);
    quitWarningMock.showQuitWarning.mockResolvedValue(false);

    const mainWindow = {} as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      windowRegistry: {
        getPrimary: () => ({ browserWindow: mainWindow }),
      } as unknown as ShutdownDeps["windowRegistry"],
    });
    await beforeQuitCb(makeEvent());

    expect(openWindowsTrackerMock.freezeAndSnapshotOpenWindows).not.toHaveBeenCalled();
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
    it("disposes hibernation, idle-terminal, system-sleep, and the connectivity registry", async () => {
      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(hibernationMock.stop).toHaveBeenCalledTimes(1);
      expect(idleTerminalMock.stop).toHaveBeenCalledTimes(1);
      expect(systemSleepMock.dispose).toHaveBeenCalledTimes(1);
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

    it("kills in-flight project checks so detached runners don't outlive the app", async () => {
      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      // POSIX checks spawn detached, so nothing else reaps them on quit.
      expect(projectCheckServiceMock.dispose).toHaveBeenCalledTimes(1);
    });

    it("clears PluginService's WorkspaceClient reference during shutdown", async () => {
      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(pluginServiceMock.setWorkspaceClient).toHaveBeenCalledWith(null);
    });

    it("waits for the plugin-spawned children to be killed before exiting (#12216)", async () => {
      // Held open so the assertion proves ORDERING, not just that the call
      // happened: an immediately-resolved mock would pass either way.
      let releaseSweep: (() => void) | undefined;
      pluginServiceMock.shutdownManagedProcesses.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseSweep = resolve;
          })
      );

      const { beforeQuitCb } = await setup({});
      const quitting = beforeQuitCb(makeEvent());

      // Electron signals nothing to a `child_process.spawn` tree on quit, so
      // without this sweep a plugin's dev server simply outlives the app.
      await vi.waitFor(() => {
        expect(pluginServiceMock.shutdownManagedProcesses).toHaveBeenCalled();
      });
      expect(appMock.exit).not.toHaveBeenCalled();

      releaseSweep?.();
      await quitting;
      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
    });

    it("still exits cleanly when the plugin process sweep rejects (#12216)", async () => {
      pluginServiceMock.shutdownManagedProcesses.mockRejectedValueOnce(new Error("sweep boom"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({});
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
      expect(pluginServiceMock.shutdownManagedProcesses).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "[MAIN] Plugin managed-process shutdown failed:",
        expect.any(Error)
      );
      warnSpy.mockRestore();
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
        getPartialGracefulKillResults: vi.fn(() => []),
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

    it("skips the assistant's overlay terminal but journals the pane beside it", async () => {
      // #12183: a quit journaled the assistant as an ordinary AgentSessionRecord,
      // so it could surface in the resume picker and reopen the assistant's
      // conversation as a grid pane running the underlying CLI.
      projectStoreMock.getAllProjects.mockReturnValue([{ id: "proj-1" }] as never);
      const ptyClient = makePtyClient({
        getAllTerminalsAsync: vi.fn(async () => [
          agentTerminal,
          { ...agentTerminal, id: "assistant", isAssistantTerminal: true },
        ]),
        gracefulKillByProject: vi.fn(async () => [
          { id: "t1", agentSessionId: "sess-1" },
          { id: "assistant", agentSessionId: "sess-assistant" },
        ]),
      });
      const { beforeQuitCb } = await setup({ getPtyClient: () => ptyClient });

      await beforeQuitCb(makeEvent());
      await vi.waitFor(() => expect(appMock.exit).toHaveBeenCalled());

      expect(persistAgentSessionMock).toHaveBeenCalledTimes(1);
      const record = persistAgentSessionMock.mock.calls[0][0] as Record<string, unknown>;
      expect(record.sessionId).toBe("sess-1");

      // The session-id writeback skips it too, matching the mirrored block in
      // `gracefulTeardownAndJournalProject`.
      const [, updater] = projectStoreMock.enqueueProjectStateUpdate.mock.calls[0]!;
      const state = {
        terminals: [
          { id: "t1", agentSessionId: undefined },
          { id: "assistant", agentSessionId: undefined },
        ],
      };
      updater(state);
      expect(state.terminals).toEqual([
        { id: "t1", agentSessionId: "sess-1" },
        { id: "assistant", agentSessionId: undefined },
      ]);
    });

    it("still captures and journals when the rate-limit drain import fails", async () => {
      // The motivating failure: an installer replaced app.asar under the running
      // process, so the chain's `await import(...)` no longer yields the module. It
      // sits ahead of the graceful kill, and unguarded its rejection took every
      // session capture and journal record with it.
      projectStoreMock.getAllProjects.mockReturnValue([{ id: "proj-1" }] as never);
      const ptyClient = makePtyClient({
        getAllTerminalsAsync: vi.fn(async () => [agentTerminal]),
        gracefulKillByProject: vi.fn(async () => [{ id: "t1", agentSessionId: "sess-1" }]),
      });
      const { beforeQuitCb } = await setup({ getPtyClient: () => ptyClient });

      try {
        ipcUtilsMock.failLoad = true;
        await beforeQuitCb(makeEvent());
        await vi.waitFor(() => expect(appMock.exit).toHaveBeenCalled());

        expect(ipcUtilsMock.drainRateLimitQueues).not.toHaveBeenCalled();
        expect(projectStoreMock.enqueueProjectStateUpdate).toHaveBeenCalled();
        expect(persistAgentSessionMock).toHaveBeenCalledTimes(1);
        expect(
          (persistAgentSessionMock.mock.calls[0][0] as Record<string, unknown>).sessionId
        ).toBe("sess-1");
        // A best-effort drain must not downgrade the exit to dirty either.
        expect(appMock.exit).toHaveBeenCalledWith(0);
      } finally {
        ipcUtilsMock.failLoad = false;
      }
    });

    it("still captures and journals when the rate-limit drain itself throws", async () => {
      // The other half of the guard: the module loads, the drain blows up.
      const { drainRateLimitQueues } = await import("../../ipc/utils.js");
      vi.mocked(drainRateLimitQueues).mockImplementationOnce(() => {
        throw new Error("rate-limit queue wedged");
      });
      projectStoreMock.getAllProjects.mockReturnValue([{ id: "proj-1" }] as never);
      const gracefulKillByProject = vi.fn(async () => [{ id: "t1", agentSessionId: "sess-1" }]);
      const ptyClient = makePtyClient({
        getAllTerminalsAsync: vi.fn(async () => [agentTerminal]),
        gracefulKillByProject,
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

      // preserveSession keeps a plain shell's session file: without it the
      // fallback path in PtyManager.kill deletes it, so a quit discarded
      // scrollback that sleeping the same project preserved (#11802).
      expect(gracefulKillByProject).toHaveBeenCalledWith("proj-1", { preserveSession: true });
      expect(projectStoreMock.enqueueProjectStateUpdate).toHaveBeenCalled();
      expect(persistAgentSessionMock).toHaveBeenCalledTimes(1);
      expect((persistAgentSessionMock.mock.calls[0][0] as Record<string, unknown>).sessionId).toBe(
        "sess-1"
      );
      // A best-effort drain must not downgrade the exit to dirty either.
      expect(appMock.exit).toHaveBeenCalledWith(0);
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

    it("keeps one project's captures when another project's kill rejects", async () => {
      // The per-project timeout already isolates a slow project; a rejected IPC
      // has to be isolated for the same reason. Unhandled, it escapes to the
      // outer catch and takes the state write and the journal with it — for every
      // project, including the ones that captured fine.
      projectStoreMock.getAllProjects.mockReturnValue([
        { id: "proj-1" },
        { id: "proj-2" },
      ] as never);
      const ptyClient = makePtyClient({
        getAllTerminalsAsync: vi.fn(async () => [{ ...agentTerminal, id: "t2" }]),
        gracefulKillByProject: vi.fn(async (pid: string) => {
          if (pid === "proj-1") throw new Error("pty-host gone");
          return [{ id: "t2", agentSessionId: "sess-2" }];
        }),
      });
      const { beforeQuitCb } = await setup({ getPtyClient: () => ptyClient });

      await beforeQuitCb(makeEvent());
      await vi.waitFor(() => expect(appMock.exit).toHaveBeenCalled());

      expect(projectStoreMock.enqueueProjectStateUpdate).toHaveBeenCalledWith(
        "proj-2",
        expect.any(Function)
      );
      expect(persistAgentSessionMock).toHaveBeenCalledTimes(1);
      expect((persistAgentSessionMock.mock.calls[0][0] as Record<string, unknown>).sessionId).toBe(
        "sess-2"
      );
    });

    it("keeps a project's streamed captures when its graceful kill outruns the deadline", async () => {
      // #12180. One pane running its full budget used to push the project's
      // whole kill past the 4s race, which resolved to `[]` — so the ids that
      // HAD been captured were dropped from both the snapshot writeback and the
      // journal, and those panes came back unreachable on the next launch.
      vi.useFakeTimers();
      projectStoreMock.getAllProjects.mockReturnValue([{ id: "proj-1" }] as never);
      const getPartialGracefulKillResults = vi.fn(() => [{ id: "t1", agentSessionId: "sess-1" }]);
      const ptyClient = makePtyClient({
        getAllTerminalsAsync: vi.fn(async () => [agentTerminal]),
        // Never settles: the slow pane is still going when the deadline fires.
        gracefulKillByProject: vi.fn(() => new Promise(() => {})),
        getPartialGracefulKillResults,
      });
      const { beforeQuitCb } = await setup({ getPtyClient: () => ptyClient });

      const quit = beforeQuitCb(makeEvent());
      await vi.advanceTimersByTimeAsync(PROJECT_GRACEFUL_KILL_TIMEOUT_MS);
      await vi.runAllTimersAsync();
      await quit;

      expect(getPartialGracefulKillResults).toHaveBeenCalledWith("proj-1");
      expect(projectStoreMock.enqueueProjectStateUpdate).toHaveBeenCalledWith(
        "proj-1",
        expect.any(Function)
      );
      expect(persistAgentSessionMock).toHaveBeenCalledTimes(1);
      expect((persistAgentSessionMock.mock.calls[0][0] as Record<string, unknown>).sessionId).toBe(
        "sess-1"
      );
      vi.useRealTimers();
    });

    it("writes nothing for a project that outran the deadline with no streamed captures", async () => {
      vi.useFakeTimers();
      projectStoreMock.getAllProjects.mockReturnValue([{ id: "proj-1" }] as never);
      const ptyClient = makePtyClient({
        getAllTerminalsAsync: vi.fn(async () => [agentTerminal]),
        gracefulKillByProject: vi.fn(() => new Promise(() => {})),
        getPartialGracefulKillResults: vi.fn(() => []),
      });
      const { beforeQuitCb } = await setup({ getPtyClient: () => ptyClient });

      const quit = beforeQuitCb(makeEvent());
      await vi.advanceTimersByTimeAsync(PROJECT_GRACEFUL_KILL_TIMEOUT_MS);
      await vi.runAllTimersAsync();
      await quit;

      expect(projectStoreMock.enqueueProjectStateUpdate).not.toHaveBeenCalled();
      expect(persistAgentSessionMock).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("still journals when persisting a project's captures rejects", async () => {
      // The journal is the other half of the resume story and recoverable on its
      // own (session history reads it), so a failed state write must not skip it.
      projectStoreMock.getAllProjects.mockReturnValue([{ id: "proj-1" }] as never);
      projectStoreMock.enqueueProjectStateUpdate.mockRejectedValueOnce(new Error("disk full"));
      const ptyClient = makePtyClient({
        getAllTerminalsAsync: vi.fn(async () => [agentTerminal]),
        gracefulKillByProject: vi.fn(async () => [{ id: "t1", agentSessionId: "sess-1" }]),
      });
      const { beforeQuitCb } = await setup({ getPtyClient: () => ptyClient });

      await beforeQuitCb(makeEvent());
      await vi.waitFor(() => expect(appMock.exit).toHaveBeenCalled());

      expect(persistAgentSessionMock).toHaveBeenCalledTimes(1);
      expect((persistAgentSessionMock.mock.calls[0][0] as Record<string, unknown>).sessionId).toBe(
        "sess-1"
      );
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

  // Issue #11104. On macOS, quitAndInstall() reaches native Squirrel.Mac, which
  // closes every window before Electron emits `before-quit` — so the update path
  // could never reach this chain and silently skipped journaling, the DB
  // checkpoint, audit flushes and subprocess teardown, hand-copying three
  // clean-exit markers instead. The chain is now reachable without `before-quit`.
  describe("update-install shutdown (issue #11104)", () => {
    beforeEach(() => {
      // clearAllMocks() resets call records, NOT implementations — anything an
      // earlier test wedged would otherwise hang every test after it.
      mcpServerMock.stop.mockReturnValue(Promise.resolve());
      performanceTraceMock.stopPerformanceTraceIfActive.mockReturnValue(Promise.resolve());
    });

    async function setupCoordinated(overrides?: Partial<ShutdownDeps>) {
      const { registerShutdownHandler } = await import("../shutdown.js");
      const coordinator = await import("../shutdownCoordinator.js");
      const deps = makeDeps(overrides);
      registerShutdownHandler(deps);
      const beforeQuitCb = appMock.on.mock.calls.find(
        (args: string[]) => args[0] === "before-quit"
      )![1] as (event: { preventDefault: () => void }) => Promise<void>;
      return { deps, beforeQuitCb, coordinator };
    }

    it("runs the full cleanup chain for an update install without any before-quit", async () => {
      const { coordinator } = await setupCoordinated();
      const onReadyToInstall = vi.fn();

      const status = coordinator.requestGracefulShutdownForUpdate(onReadyToInstall);
      expect(status).toBe("started");

      await vi.waitFor(() => expect(onReadyToInstall).toHaveBeenCalled());

      // The work the update path used to lose entirely.
      expect(closeSharedDbMock.closeSharedDb).toHaveBeenCalled();
      expect(dbMaintenanceMock.dispose).toHaveBeenCalled();
      expect(mcpServerMock.stop).toHaveBeenCalled();
      expect(closeTelemetryMock).toHaveBeenCalled();
      // The install decides how the process ends — the chain must not exit itself.
      expect(appMock.exit).not.toHaveBeenCalled();
    });

    it("hands off with a clean outcome and writes the markers the update path used to hand-copy", async () => {
      const { coordinator } = await setupCoordinated();
      const onReadyToInstall = vi.fn();

      coordinator.requestGracefulShutdownForUpdate(onReadyToInstall);
      await vi.waitFor(() => expect(onReadyToInstall).toHaveBeenCalled());

      expect(onReadyToInstall).toHaveBeenCalledWith("clean");
      expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
      expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
    });

    it("does not install before the cleanup chain settles", async () => {
      let releaseCleanup: () => void = () => {};
      mcpServerMock.stop.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        })
      );

      const { coordinator } = await setupCoordinated();
      const onReadyToInstall = vi.fn();
      coordinator.requestGracefulShutdownForUpdate(onReadyToInstall);

      // Chain is wedged mid-cleanup: nothing may be installed or marked clean yet.
      await vi.waitFor(() => expect(mcpServerMock.stop).toHaveBeenCalled());
      expect(onReadyToInstall).not.toHaveBeenCalled();
      expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();

      releaseCleanup();
      await vi.waitFor(() => expect(onReadyToInstall).toHaveBeenCalled());
      expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
      // Markers must land before the installer takes the process (lesson #7158).
      expect(crashRecoveryMock.cleanupOnExit.mock.invocationCallOrder[0]).toBeLessThan(
        onReadyToInstall.mock.invocationCallOrder[0]
      );
    });

    it("still installs on a dirty outcome but leaves the crash marker intact", async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mcpServerMock.stop.mockReturnValue(new Promise(() => {}));

      try {
        const { coordinator } = await setupCoordinated();
        const onReadyToInstall = vi.fn();
        coordinator.requestGracefulShutdownForUpdate(onReadyToInstall);

        await vi.advanceTimersByTimeAsync(CLEANUP_TIMEOUT_MS);
        await vi.runAllTimersAsync();

        // The user asked to update — a timed-out cleanup must not swallow that.
        expect(onReadyToInstall).toHaveBeenCalledWith("dirty");
        // But it must not claim a clean exit it never achieved.
        expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
        expect(crashLoopGuardMock.markCleanExit).not.toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("prevents a quit that lands while the update cleanup is still running", async () => {
      let releaseCleanup: () => void = () => {};
      mcpServerMock.stop.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        })
      );

      const { beforeQuitCb, coordinator } = await setupCoordinated();
      coordinator.requestGracefulShutdownForUpdate(vi.fn());
      await vi.waitFor(() => expect(mcpServerMock.stop).toHaveBeenCalled());

      // A Cmd+Q here would otherwise close the windows and kill the process out
      // from under the in-flight chain — losing the very work it is doing.
      const event = makeEvent();
      await beforeQuitCb(event);
      expect(event.preventDefault).toHaveBeenCalled();

      releaseCleanup();
    });

    it("allows the quit that Squirrel issues once the install has been handed off", async () => {
      const { beforeQuitCb, coordinator } = await setupCoordinated();
      const onReadyToInstall = vi.fn();
      coordinator.requestGracefulShutdownForUpdate(onReadyToInstall);
      await vi.waitFor(() => expect(onReadyToInstall).toHaveBeenCalled());

      // quitAndInstall() closes the windows and calls app.quit() behind our back.
      // Blocking that quit would strand every install behind the force-exit watchdog.
      const event = makeEvent();
      await beforeQuitCb(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("refuses an update install once a normal quit already owns the shutdown", async () => {
      const { beforeQuitCb, coordinator } = await setupCoordinated();
      await beforeQuitCb(makeEvent());

      // Attaching a second terminal action here would race quitAndInstall()
      // against the app.exit() the quit path already owns.
      const onReadyToInstall = vi.fn();
      expect(coordinator.requestGracefulShutdownForUpdate(onReadyToInstall)).toBe(
        "already-shutting-down"
      );

      await vi.waitFor(() => expect(appMock.exit).toHaveBeenCalledWith(0));
      expect(onReadyToInstall).not.toHaveBeenCalled();
    });

    it("runs the cleanup chain once when a second install request races the first", async () => {
      const { coordinator } = await setupCoordinated();
      const first = vi.fn();
      const second = vi.fn();

      expect(coordinator.requestGracefulShutdownForUpdate(first)).toBe("started");
      expect(coordinator.requestGracefulShutdownForUpdate(second)).toBe("already-shutting-down");

      await vi.waitFor(() => expect(first).toHaveBeenCalled());
      expect(second).not.toHaveBeenCalled();
      expect(closeSharedDbMock.closeSharedDb).toHaveBeenCalledTimes(1);
    });

    // The before-quit listener holds off every quit while a chain is cleaning, so a
    // chain that never settles would leave the app impossible to quit at all. The
    // perf-trace flush is the live risk: it runs after the cleanup race (so the
    // hard timeout doesn't cover it) and contentTracing.stopRecording() has no cap.
    it("abandons a wedged trace flush at the tail budget and still hands off", async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      performanceTraceMock.stopPerformanceTraceIfActive.mockReturnValue(new Promise(() => {}));

      try {
        const { coordinator } = await setupCoordinated();
        const onReadyToInstall = vi.fn();
        coordinator.requestGracefulShutdownForUpdate(onReadyToInstall);

        // Advance ONLY the tail budget — deliberately short of the coordinator's
        // absolute deadline, so this proves the tail bound itself and can't pass
        // on the strength of the outer backstop.
        await vi.advanceTimersByTimeAsync(SHUTDOWN_TAIL_TIMEOUT_MS);

        expect(onReadyToInstall).toHaveBeenCalled();
      } finally {
        performanceTraceMock.stopPerformanceTraceIfActive.mockReturnValue(Promise.resolve());
        consoleSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    // The backstop behind every other budget. Once a chain is cleaning, the
    // before-quit listener holds off every quit — so a chain that never settles at
    // all would leave an app that literally cannot be quit.
    it("forces the terminal action when the chain never settles at all", async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const coordinator = await import("../shutdownCoordinator.js");
        coordinator.setShutdownRunner(() => new Promise(() => {}));

        const onSettled = vi.fn();
        expect(coordinator.startShutdown("app-quit", onSettled)).toBe("started");

        await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);

        expect(onSettled).toHaveBeenCalledWith("dirty");
        // A deadline-forced handoff never reaches the chain's own
        // clearSafetyBeltTimer(), so the coordinator must defuse the belt itself —
        // otherwise it fires seconds later and app.exit(1)s straight through the
        // updater's install window.
        expect(signalShutdownMock.clearSafetyBeltTimer).toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("reports unavailable — and cleans up nothing — when no shutdown handler is registered", async () => {
      const coordinator = await import("../shutdownCoordinator.js");

      const onReadyToInstall = vi.fn();
      expect(coordinator.requestGracefulShutdownForUpdate(onReadyToInstall)).toBe("unavailable");

      expect(onReadyToInstall).not.toHaveBeenCalled();
      expect(closeSharedDbMock.closeSharedDb).not.toHaveBeenCalled();
      expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
    });
  });
});
