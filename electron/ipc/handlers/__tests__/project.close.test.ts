import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import os from "os";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showErrorBox: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
    openExternal: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(),
  getProjectById:
    vi.fn<(projectId: string) => { id: string; name: string; status?: string } | null>(),
  clearProjectState: vi.fn<(projectId: string) => Promise<void>>(),
  clearCurrentProject: vi.fn<() => void>(),
  updateProjectStatus:
    vi.fn<(projectId: string, status: "active" | "background" | "closed") => unknown>(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("../../../services/ProjectSwitchService.js", () => ({
  ProjectSwitchService: class MockProjectSwitchService {
    onSwitch = vi.fn();
  },
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerProjectCrudHandlers } from "../projectCrud/index.js";
import type { HandlerDependencies } from "../../types.js";

describe("project:close handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows killing terminals for the active project and clears it", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-active");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "project-active",
      name: "Active Project",
      status: "active",
    });
    projectStoreMock.clearProjectState.mockResolvedValue(undefined);

    const ptyClient = {
      getProjectStats: vi.fn(async () => ({
        terminalCount: 2,
        processIds: [111, 222],
        terminalTypes: { terminal: 2 },
      })),
      killByProject: vi.fn(async () => 2),
      onProjectSwitch: vi.fn(),
      setActiveProject: vi.fn(),
    };

    const deps = {
      mainWindow: {} as unknown,
      ptyClient,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const closeCall = calls.find((c) => c[0] === CHANNELS.PROJECT_CLOSE);
    expect(closeCall).toBeTruthy();

    const handler = closeCall?.[1] as unknown as (
      event: unknown,
      projectId: string,
      options?: { killTerminals?: boolean }
    ) => Promise<{ terminalsKilled: number; processesKilled: number }>;

    const result = await handler(
      { senderFrame: { url: "http://localhost:5173" } },
      "project-active",
      { killTerminals: true }
    );

    expect(result.terminalsKilled).toBe(2);
    expect(result.processesKilled).toBe(2);
    expect(ptyClient.killByProject).toHaveBeenCalledWith("project-active");
    expect(projectStoreMock.clearProjectState).toHaveBeenCalledWith("project-active");
    expect(projectStoreMock.clearCurrentProject).toHaveBeenCalled();
    expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("project-active", "closed");
  });

  it("rejects closing the active project when not killing terminals", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-active");

    const ptyClient = {
      getProjectStats: vi.fn(async () => ({
        terminalCount: 0,
        processIds: [],
        terminalTypes: {},
      })),
      killByProject: vi.fn(async () => 0),
      onProjectSwitch: vi.fn(),
      setActiveProject: vi.fn(),
    };

    const deps = {
      mainWindow: {} as unknown,
      ptyClient,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const closeCall = calls.find((c) => c[0] === CHANNELS.PROJECT_CLOSE);
    expect(closeCall).toBeTruthy();

    const handler = closeCall?.[1] as unknown as (
      event: unknown,
      projectId: string,
      options?: { killTerminals?: boolean }
    ) => Promise<unknown>;

    await expect(
      handler({ senderFrame: { url: "http://localhost:5173" } }, "project-active", {
        killTerminals: false,
      })
    ).rejects.toThrow("open in a window");
  });

  describe("multi-window visibility guard (#11102)", () => {
    /** A WindowRegistry-shaped stub whose windows show the given projects. */
    function registryShowing(...activeProjectIds: Array<string | null>) {
      return {
        all: () =>
          activeProjectIds.map((id) => ({
            services: {
              projectViewManager: {
                getActiveProjectId: () => id,
                getOutgoingBridgeProjectId: () => null,
              },
            },
          })),
      };
    }

    function makePtyClient() {
      return {
        getProjectStats: vi.fn(async () => ({
          terminalCount: 1,
          processIds: [1],
          terminalTypes: { terminal: 1 },
        })),
        killByProject: vi.fn(async () => 1),
        onProjectSwitch: vi.fn(),
        setActiveProject: vi.fn(),
      };
    }

    function getCloseHandler(deps: HandlerDependencies) {
      registerProjectCrudHandlers(deps);
      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const closeCall = calls.find((c) => c[0] === CHANNELS.PROJECT_CLOSE);
      expect(closeCall).toBeTruthy();
      return closeCall?.[1] as unknown as (
        event: unknown,
        projectId: string,
        options?: { killTerminals?: boolean }
      ) => Promise<unknown>;
    }

    const EVENT = { senderFrame: { url: "http://localhost:5173" } };

    it("rejects closing a project visible in a second, unfocused window", async () => {
      // The DB pointer names a DIFFERENT project — pre-fix, the guard let this
      // through and closed a project the user was actively looking at.
      projectStoreMock.getCurrentProjectId.mockReturnValue("project-focused");

      const ptyClient = makePtyClient();
      const deps = {
        mainWindow: {} as unknown,
        ptyClient,
        windowRegistry: registryShowing("project-focused", "project-second-window"),
      } as unknown as HandlerDependencies;

      const handler = getCloseHandler(deps);

      await expect(
        handler(EVENT, "project-second-window", { killTerminals: false })
      ).rejects.toThrow("open in a window");
      expect(ptyClient.killByProject).not.toHaveBeenCalled();
      expect(projectStoreMock.clearProjectState).not.toHaveBeenCalled();
    });

    it("still closes a project no window is showing", async () => {
      projectStoreMock.getCurrentProjectId.mockReturnValue("project-focused");
      projectStoreMock.getProjectById.mockReturnValue({
        id: "project-background",
        name: "Background",
        status: "active",
        path: "/test/project-background",
      } as ReturnType<typeof projectStoreMock.getProjectById>);

      const deps = {
        mainWindow: {} as unknown,
        ptyClient: makePtyClient(),
        windowRegistry: registryShowing("project-focused", "project-second-window"),
      } as unknown as HandlerDependencies;

      const handler = getCloseHandler(deps);

      // The guard must not over-block a genuinely background project.
      await expect(
        handler(EVENT, "project-background", { killTerminals: false })
      ).resolves.toBeTruthy();
    });

    it("rejects a non-kill close when the project goes visible during the stats await", async () => {
      projectStoreMock.getCurrentProjectId.mockReturnValue("project-focused");
      projectStoreMock.getProjectById.mockReturnValue({
        id: "project-late",
        name: "Late",
        status: "active",
        path: "/test/project-late",
      } as ReturnType<typeof projectStoreMock.getProjectById>);

      // No window shows it when the handler starts...
      let shownInSecondWindow: string | null = null;
      const registry = {
        all: () => [
          {
            services: {
              projectViewManager: {
                getActiveProjectId: () => shownInSecondWindow,
                getOutgoingBridgeProjectId: () => null,
              },
            },
          },
        ],
      };

      const ptyClient = {
        // ...but the user switches to it while the stats round-trip is in flight.
        getProjectStats: vi.fn(async () => {
          shownInSecondWindow = "project-late";
          return { terminalCount: 1, processIds: [1], terminalTypes: { terminal: 1 } };
        }),
        killByProject: vi.fn(async () => 1),
        onProjectSwitch: vi.fn(),
        setActiveProject: vi.fn(),
      };

      const deps = {
        mainWindow: {} as unknown,
        ptyClient,
        worktreeService: { pauseProject: vi.fn() },
      } as unknown as HandlerDependencies;
      (deps as unknown as { windowRegistry: unknown }).windowRegistry = registry;

      const handler = getCloseHandler(deps);

      await expect(handler(EVENT, "project-late", { killTerminals: false })).rejects.toThrow(
        "open in a window"
      );
      // The entry guard passed, so only the post-await recheck can have caught
      // this — and it must have caught it BEFORE backgrounding/pausing.
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(
        (deps as unknown as { worktreeService: { pauseProject: Mock } }).worktreeService
          .pauseProject
      ).not.toHaveBeenCalled();
    });

    it("does not clear a pointer that moved to another project during the kill", async () => {
      // Pointer names the project being closed when the handler starts...
      let pointer: string | null = "project-doomed";
      projectStoreMock.getCurrentProjectId.mockImplementation(() => pointer);
      projectStoreMock.getProjectById.mockReturnValue({
        id: "project-doomed",
        name: "Doomed",
        status: "active",
        path: "/test/project-doomed",
      } as ReturnType<typeof projectStoreMock.getProjectById>);

      const ptyClient = {
        getProjectStats: vi.fn(async () => ({
          terminalCount: 1,
          processIds: [1],
          terminalTypes: { terminal: 1 },
        })),
        // ...but another window switches away while the kill is in flight.
        killByProject: vi.fn(async () => {
          pointer = "project-other";
          return 1;
        }),
        onProjectSwitch: vi.fn(),
        setActiveProject: vi.fn(),
      };

      const deps = {
        mainWindow: {} as unknown,
        ptyClient,
      } as unknown as HandlerDependencies;

      const handler = getCloseHandler(deps);
      await handler(EVENT, "project-doomed", { killTerminals: true });

      // Clearing on the stale snapshot would have wiped project-other's pointer.
      expect(projectStoreMock.clearCurrentProject).not.toHaveBeenCalled();
    });

    it("still allows an explicit kill-terminals close of a visible project", async () => {
      // killTerminals is the deliberate, destructive path — the visibility guard
      // deliberately does not apply to it.
      projectStoreMock.getCurrentProjectId.mockReturnValue("project-focused");
      projectStoreMock.getProjectById.mockReturnValue({
        id: "project-second-window",
        name: "Second",
        status: "active",
        path: "/test/project-second-window",
      } as ReturnType<typeof projectStoreMock.getProjectById>);

      const ptyClient = makePtyClient();
      const deps = {
        mainWindow: {} as unknown,
        ptyClient,
        windowRegistry: registryShowing("project-focused", "project-second-window"),
      } as unknown as HandlerDependencies;

      const handler = getCloseHandler(deps);
      await handler(EVENT, "project-second-window", { killTerminals: true });

      expect(ptyClient.killByProject).toHaveBeenCalledWith("project-second-window");
      // The DB pointer names a different project, so it must NOT be cleared —
      // that bookkeeping tracks the pointer, not visibility.
      expect(projectStoreMock.clearCurrentProject).not.toHaveBeenCalled();
    });
  });

  it("backgrounds a non-active project and calls pauseProject", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-active");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "project-bg",
      name: "Background Project",
      status: "active",
      path: "/test/project-bg",
    } as ReturnType<typeof projectStoreMock.getProjectById>);

    const ptyClient = {
      getProjectStats: vi.fn(async () => ({
        terminalCount: 1,
        processIds: [333],
        terminalTypes: { terminal: 1 },
      })),
      killByProject: vi.fn(async () => 0),
      onProjectSwitch: vi.fn(),
      setActiveProject: vi.fn(),
    };

    const worktreeService = {
      pauseProject: vi.fn(),
      resumeProject: vi.fn(),
      loadProject: vi.fn(),
      attachDirectPort: vi.fn(),
    };

    const deps = {
      mainWindow: {} as unknown,
      ptyClient,
      worktreeService,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const closeCall = calls.find((c) => c[0] === CHANNELS.PROJECT_CLOSE);
    const handler = closeCall?.[1] as unknown as (
      event: unknown,
      projectId: string,
      options?: { killTerminals?: boolean }
    ) => Promise<{ terminalsKilled: number; processesKilled: number }>;

    const result = await handler({ senderFrame: { url: "http://localhost:5173" } }, "project-bg", {
      killTerminals: false,
    });

    expect(result.terminalsKilled).toBe(0);
    expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("project-bg", "background");
    expect(worktreeService.pauseProject).toHaveBeenCalledWith("/test/project-bg");
  });

  it("does NOT call pauseProject when killing terminals", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-active");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "project-active",
      name: "Active Project",
      status: "active",
      path: "/test/project-active",
    } as ReturnType<typeof projectStoreMock.getProjectById>);
    projectStoreMock.clearProjectState.mockResolvedValue(undefined);

    const ptyClient = {
      getProjectStats: vi.fn(async () => ({
        terminalCount: 1,
        processIds: [444],
        terminalTypes: { terminal: 1 },
      })),
      killByProject: vi.fn(async () => 1),
      onProjectSwitch: vi.fn(),
      setActiveProject: vi.fn(),
    };

    const worktreeService = {
      pauseProject: vi.fn(),
      resumeProject: vi.fn(),
      loadProject: vi.fn(),
      attachDirectPort: vi.fn(),
    };

    const deps = {
      mainWindow: {} as unknown,
      ptyClient,
      worktreeService,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const closeCall = calls.find((c) => c[0] === CHANNELS.PROJECT_CLOSE);
    const handler = closeCall?.[1] as unknown as (
      event: unknown,
      projectId: string,
      options?: { killTerminals?: boolean }
    ) => Promise<{ terminalsKilled: number; processesKilled: number }>;

    await handler({ senderFrame: { url: "http://localhost:5173" } }, "project-active", {
      killTerminals: true,
    });

    expect(worktreeService.pauseProject).not.toHaveBeenCalled();
  });

  // Note: IPC sender validation is enforced globally via monkey-patch in main.ts,
  // which doesn't apply to mocked ipcMain in unit tests. Integration/E2E tests
  // should verify the actual runtime enforcement.
});
