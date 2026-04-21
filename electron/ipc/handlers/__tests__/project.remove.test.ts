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
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

const projectStoreMock = vi.hoisted(() => ({
  removeProject: vi.fn<(projectId: string) => Promise<void>>(),
  getCurrentProjectId: vi.fn<() => string | null>(),
  getProjectById: vi.fn(),
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

function getHandler(channel: string) {
  const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
    .calls;
  const entry = calls.find((c) => c[0] === channel);
  return entry?.[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
}

describe("project:remove handler", () => {
  const fakeEvent = { senderFrame: { url: "http://localhost:5173" } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kills terminals before removing the project", async () => {
    projectStoreMock.removeProject.mockResolvedValue(undefined);

    const ptyClient = {
      killByProject: vi.fn(async () => 3),
      getProjectStats: vi.fn(),
      onProjectSwitch: vi.fn(),
      setActiveProject: vi.fn(),
    };

    const deps = {
      mainWindow: {} as unknown,
      ptyClient,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_REMOVE);

    await handler(fakeEvent, "proj-1");

    expect(ptyClient.killByProject).toHaveBeenCalledWith("proj-1");
    expect(projectStoreMock.removeProject).toHaveBeenCalledWith("proj-1");

    const killOrder = ptyClient.killByProject.mock.invocationCallOrder[0];
    const removeOrder = projectStoreMock.removeProject.mock.invocationCallOrder[0];
    expect(killOrder).toBeLessThan(removeOrder);
  });

  it("still removes the project when killByProject fails", async () => {
    projectStoreMock.removeProject.mockResolvedValue(undefined);

    const ptyClient = {
      killByProject: vi.fn(async () => {
        throw new Error("PTY host disconnected");
      }),
      getProjectStats: vi.fn(),
      onProjectSwitch: vi.fn(),
      setActiveProject: vi.fn(),
    };

    const deps = {
      mainWindow: {} as unknown,
      ptyClient,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_REMOVE);

    await handler(fakeEvent, "proj-2");

    expect(ptyClient.killByProject).toHaveBeenCalledWith("proj-2");
    expect(projectStoreMock.removeProject).toHaveBeenCalledWith("proj-2");
  });

  it("removes the project when no ptyClient is provided", async () => {
    projectStoreMock.removeProject.mockResolvedValue(undefined);

    const deps = {
      mainWindow: {} as unknown,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_REMOVE);

    await handler(fakeEvent, "proj-4");

    expect(projectStoreMock.removeProject).toHaveBeenCalledWith("proj-4");
  });

  it("throws on invalid projectId without calling cleanup or removal", async () => {
    const ptyClient = {
      killByProject: vi.fn(async () => 0),
      getProjectStats: vi.fn(),
      onProjectSwitch: vi.fn(),
      setActiveProject: vi.fn(),
    };

    const deps = {
      mainWindow: {} as unknown,
      ptyClient,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_REMOVE);

    await expect(handler(fakeEvent, "")).rejects.toThrow("Invalid project ID");
    expect(ptyClient.killByProject).not.toHaveBeenCalled();
    expect(projectStoreMock.removeProject).not.toHaveBeenCalled();
  });
});
