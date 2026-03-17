import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../services/McpServerService.js", () => ({
  mcpServerService: { stop: vi.fn(() => Promise.resolve()) },
}));

vi.mock("../../ipc/utils.js", () => ({
  drainRateLimitQueues: vi.fn(),
}));

const signalShutdownMock = vi.hoisted(() => ({
  isSignalShutdown: vi.fn(() => false),
}));

vi.mock("../signalShutdownState.js", () => signalShutdownMock);

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
    getProjectMcpManager: vi.fn(() => null),
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
});
