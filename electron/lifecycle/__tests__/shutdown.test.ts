import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  on: vi.fn(),
  exit: vi.fn(),
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
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

const crashRecoveryMock = vi.hoisted(() => ({
  cleanupOnExit: vi.fn(),
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

vi.mock("../../services/AgentRouter.js", () => ({
  disposeAgentRouter: vi.fn(),
}));

vi.mock("../../services/WorkflowEngine.js", () => ({
  disposeWorkflowEngine: vi.fn(),
}));

vi.mock("../../services/TaskOrchestrator.js", () => ({
  disposeTaskOrchestrator: vi.fn(),
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

const isSmokeTestMock = vi.hoisted(() => ({ value: false }));

vi.mock("../../setup/environment.js", () => ({
  get isSmokeTest() {
    return isSmokeTestMock.value;
  },
}));

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
    getMainWindow: vi.fn(() => null),
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
    isSmokeTestMock.value = false;
    signalShutdownMock.isSignalShutdown.mockReturnValue(false);
    quitWarningMock.getActiveAgentCount.mockReturnValue(0);
    quitWarningMock.showQuitWarning.mockResolvedValue(true);
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
    const { beforeQuitCb } = await setup({
      getMainWindow: vi.fn(() => null),
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    // Should still preventDefault and run cleanup
    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitWarningMock.showQuitWarning).not.toHaveBeenCalled();
    expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalled();

    // Wait for cleanup promise chain to settle
    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
  });

  it("runs cleanup without dialog on signal shutdown even with active agents", async () => {
    signalShutdownMock.isSignalShutdown.mockReturnValue(true);
    quitWarningMock.getActiveAgentCount.mockReturnValue(3);

    const mainWindow = { isMinimized: vi.fn() } as unknown as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      getMainWindow: vi.fn(() => mainWindow),
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitWarningMock.showQuitWarning).not.toHaveBeenCalled();
    expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
  });

  it("shows dialog when window exists, agents active, and user cancels", async () => {
    quitWarningMock.getActiveAgentCount.mockReturnValue(2);
    quitWarningMock.showQuitWarning.mockResolvedValue(false);

    const mainWindow = {} as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      getMainWindow: vi.fn(() => mainWindow),
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitWarningMock.showQuitWarning).toHaveBeenCalled();
    expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();
  });

  it("shows dialog when window exists, agents active, and user confirms", async () => {
    quitWarningMock.getActiveAgentCount.mockReturnValue(2);
    quitWarningMock.showQuitWarning.mockResolvedValue(true);

    const mainWindow = {} as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      getMainWindow: vi.fn(() => mainWindow),
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(quitWarningMock.showQuitWarning).toHaveBeenCalled();
    expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
  });

  it("skips dialog when window exists but no active agents", async () => {
    quitWarningMock.getActiveAgentCount.mockReturnValue(0);

    const mainWindow = {} as Electron.BrowserWindow;
    const { beforeQuitCb } = await setup({
      getMainWindow: vi.fn(() => mainWindow),
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(quitWarningMock.showQuitWarning).not.toHaveBeenCalled();
    expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
  });

  it("runs cleanup when no window and signal shutdown", async () => {
    signalShutdownMock.isSignalShutdown.mockReturnValue(true);

    const { beforeQuitCb } = await setup({
      getMainWindow: vi.fn(() => null),
    });
    const event = makeEvent();
    await beforeQuitCb(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitWarningMock.showQuitWarning).not.toHaveBeenCalled();
    expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });
  });

  describe("SQLite connection close", () => {
    it("calls closeSharedDb after DatabaseMaintenanceService.dispose", async () => {
      const callOrder: string[] = [];
      dbMaintenanceMock.dispose.mockImplementation(async () => {
        callOrder.push("dispose");
      });
      closeSharedDbMock.closeSharedDb.mockImplementation(() => {
        callOrder.push("closeSharedDb");
      });

      const { beforeQuitCb } = await setup({
        getMainWindow: vi.fn(() => null),
      });
      await beforeQuitCb(makeEvent());

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      expect(callOrder).toEqual(["dispose", "closeSharedDb"]);
    });

    it("still calls closeSharedDb and exits when dispose fails", async () => {
      dbMaintenanceMock.dispose.mockRejectedValue(new Error("dispose boom"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({
        getMainWindow: vi.fn(() => null),
      });
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

      const { beforeQuitCb } = await setup({
        getMainWindow: vi.fn(() => null),
      });
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

  describe("hard shutdown timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("calls app.exit(1) when cleanup hangs past hard timeout", async () => {
      mcpServerMock.stop.mockReturnValue(new Promise(() => {}));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({
        getMainWindow: vi.fn(() => null),
      });
      const event = makeEvent();
      await beforeQuitCb(event);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(appMock.exit).toHaveBeenCalledWith(1);
      expect(appMock.exit).toHaveBeenCalledTimes(1);
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

    it("normal cleanup exits with code 0 and timeout does not fire", async () => {
      mcpServerMock.stop.mockReturnValue(Promise.resolve());

      const { beforeQuitCb } = await setup({
        getMainWindow: vi.fn(() => null),
      });
      const event = makeEvent();
      await beforeQuitCb(event);

      await vi.advanceTimersByTimeAsync(100);

      expect(appMock.exit).toHaveBeenCalledWith(0);
      expect(appMock.exit).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15_000);

      expect(appMock.exit).toHaveBeenCalledTimes(1);
    });

    it("cleanup error triggers app.exit(1) via catch handler", async () => {
      mcpServerMock.stop.mockReturnValue(Promise.reject(new Error("MCP stop failed")));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { beforeQuitCb } = await setup({
        getMainWindow: vi.fn(() => null),
      });
      const event = makeEvent();
      await beforeQuitCb(event);

      await vi.advanceTimersByTimeAsync(100);

      expect(appMock.exit).toHaveBeenCalledWith(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        "[MAIN] Error during cleanup:",
        expect.objectContaining({
          message: "MCP stop failed",
        })
      );

      consoleSpy.mockRestore();
    });
  });
});
