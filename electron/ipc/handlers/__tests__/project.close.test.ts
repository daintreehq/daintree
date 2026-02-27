import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerProjectHandlers } from "../project.js";
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

    registerProjectHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const closeCall = calls.find((c) => c[0] === CHANNELS.PROJECT_CLOSE);
    expect(closeCall).toBeTruthy();

    const handler = closeCall?.[1] as unknown as (
      event: unknown,
      projectId: string,
      options?: { killTerminals?: boolean }
    ) => Promise<{ success: boolean; terminalsKilled: number; processesKilled: number }>;

    const result = await handler(
      { senderFrame: { url: "http://localhost:5173" } },
      "project-active",
      { killTerminals: true }
    );

    expect(result.success).toBe(true);
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

    registerProjectHandlers(deps);

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
    ).rejects.toThrow("Cannot close the active project");
  });

  // Note: IPC sender validation is enforced globally via monkey-patch in main.ts,
  // which doesn't apply to mocked ipcMain in unit tests. Integration/E2E tests
  // should verify the actual runtime enforcement.
});
