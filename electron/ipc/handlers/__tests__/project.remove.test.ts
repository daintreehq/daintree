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
  updateProject: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("../../../services/ProjectSwitchService.js", () => ({
  ProjectSwitchService: class MockProjectSwitchService {
    onSwitch = vi.fn();
  },
}));

const windowStateMock = vi.hoisted(() => ({
  pruneWindowStateForPath: vi.fn(),
}));

vi.mock("../../../windowState.js", () => windowStateMock);

const refreshProjectMenuStateMock = vi.hoisted(() => vi.fn());
vi.mock("../../../projectMenuState.js", () => ({
  refreshProjectMenuState: refreshProjectMenuStateMock,
}));

const teardownMock = vi.hoisted(() => ({
  gracefulTeardownAndJournalProject:
    vi.fn<(...args: unknown[]) => Promise<{ confirmed: boolean; terminalsKilled: number }>>(),
}));
vi.mock("../../../services/pty/projectSessionJournal.js", () => teardownMock);

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
    teardownMock.gracefulTeardownAndJournalProject.mockResolvedValue({
      confirmed: true,
      terminalsKilled: 0,
    });
  });

  it("gracefully tears down and journals terminals before removing the project", async () => {
    projectStoreMock.removeProject.mockResolvedValue(undefined);
    teardownMock.gracefulTeardownAndJournalProject.mockResolvedValue({
      confirmed: true,
      terminalsKilled: 3,
    });

    const ptyClient = {
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

    // Journaling (not a bare kill) must run, and before the row is deleted (#11340).
    expect(teardownMock.gracefulTeardownAndJournalProject).toHaveBeenCalledWith(
      "proj-1",
      ptyClient,
      undefined
    );
    expect(projectStoreMock.removeProject).toHaveBeenCalledWith("proj-1");

    const killOrder = teardownMock.gracefulTeardownAndJournalProject.mock.invocationCallOrder[0]!;
    const removeOrder = projectStoreMock.removeProject.mock.invocationCallOrder[0]!;
    expect(killOrder).toBeLessThan(removeOrder);

    // The row is gone, so a window still bound to it has no project open (#11136).
    expect(refreshProjectMenuStateMock).toHaveBeenCalled();
  });

  it("fails closed: does NOT remove the project when the teardown is unconfirmed", async () => {
    projectStoreMock.removeProject.mockResolvedValue(undefined);
    // Live host, kill unacknowledged — removing the row would orphan the still-
    // running agents (#11340).
    teardownMock.gracefulTeardownAndJournalProject.mockResolvedValue({
      confirmed: false,
      terminalsKilled: 0,
    });

    const ptyClient = {
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

    await expect(handler(fakeEvent, "proj-2")).rejects.toThrow();

    expect(projectStoreMock.removeProject).not.toHaveBeenCalled();
    expect(windowStateMock.pruneWindowStateForPath).not.toHaveBeenCalled();
    expect(refreshProjectMenuStateMock).not.toHaveBeenCalled();
  });

  it("fails closed when the teardown throws: the old swallow-and-remove is gone", async () => {
    projectStoreMock.removeProject.mockResolvedValue(undefined);
    // Pre-fix this handler caught the kill rejection and removed anyway; it must
    // now propagate and keep the project (#11340).
    teardownMock.gracefulTeardownAndJournalProject.mockRejectedValue(
      new Error("PTY host disconnected")
    );

    const ptyClient = {
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

    await expect(handler(fakeEvent, "proj-throw")).rejects.toThrow();

    expect(projectStoreMock.removeProject).not.toHaveBeenCalled();
    expect(windowStateMock.pruneWindowStateForPath).not.toHaveBeenCalled();
    expect(refreshProjectMenuStateMock).not.toHaveBeenCalled();
  });

  it("removes the project when the host is confirmed gone (nothing to journal)", async () => {
    projectStoreMock.removeProject.mockResolvedValue(undefined);
    teardownMock.gracefulTeardownAndJournalProject.mockResolvedValue({
      confirmed: true,
      terminalsKilled: 0,
    });

    const ptyClient = {
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

    await handler(fakeEvent, "proj-gone");

    expect(projectStoreMock.removeProject).toHaveBeenCalledWith("proj-gone");
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

  it("resolves the path before removeProject and prunes window state after removal", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "proj-5", path: "/home/user/proj-5" });
    projectStoreMock.removeProject.mockResolvedValue(undefined);

    const deps = { mainWindow: {} as unknown } as unknown as HandlerDependencies;
    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_REMOVE);

    await handler(fakeEvent, "proj-5");

    expect(projectStoreMock.getProjectById).toHaveBeenCalledWith("proj-5");
    expect(windowStateMock.pruneWindowStateForPath).toHaveBeenCalledWith("/home/user/proj-5");

    // The path must be resolved before removeProject deletes the row...
    const lookupOrder = projectStoreMock.getProjectById.mock.invocationCallOrder[0];
    const removeOrder = projectStoreMock.removeProject.mock.invocationCallOrder[0];
    expect(lookupOrder).toBeLessThan(removeOrder);
    // ...and the prune must run after removal succeeds.
    const pruneOrder = windowStateMock.pruneWindowStateForPath.mock.invocationCallOrder[0];
    expect(removeOrder).toBeLessThan(pruneOrder);
  });

  it("skips the window-state prune when the project path can't be resolved", async () => {
    projectStoreMock.getProjectById.mockReturnValue(null);
    projectStoreMock.removeProject.mockResolvedValue(undefined);

    const deps = { mainWindow: {} as unknown } as unknown as HandlerDependencies;
    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_REMOVE);

    await handler(fakeEvent, "proj-6");

    expect(projectStoreMock.removeProject).toHaveBeenCalledWith("proj-6");
    expect(windowStateMock.pruneWindowStateForPath).not.toHaveBeenCalled();
  });

  it("does not prune window state when removeProject rejects", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "proj-7", path: "/home/user/proj-7" });
    projectStoreMock.removeProject.mockRejectedValue(new Error("db locked"));

    const deps = { mainWindow: {} as unknown } as unknown as HandlerDependencies;
    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_REMOVE);

    await expect(handler(fakeEvent, "proj-7")).rejects.toThrow("db locked");
    expect(windowStateMock.pruneWindowStateForPath).not.toHaveBeenCalled();
  });

  it("throws on invalid projectId without calling cleanup or removal", async () => {
    const ptyClient = {
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
    expect(teardownMock.gracefulTeardownAndJournalProject).not.toHaveBeenCalled();
    expect(projectStoreMock.removeProject).not.toHaveBeenCalled();
  });
});

describe("project:update handler", () => {
  const fakeEvent = { senderFrame: { url: "http://localhost:5173" } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("strips identity fields — a renderer can never rewrite id or path", async () => {
    projectStoreMock.updateProject.mockReturnValue({
      id: "proj-1",
      path: "/home/user/proj-1",
      name: "Renamed",
    });

    const deps = { mainWindow: {} as unknown } as unknown as HandlerDependencies;
    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_UPDATE);

    // Rewriting a project's path to a sibling's would repoint path-keyed host
    // authorization (fileBrowser project routing) at the sibling's workspace
    // host — identity is main-owned, only metadata is renderer-writable.
    await handler(fakeEvent, "proj-1", {
      name: "Renamed",
      id: "other-project",
      path: "/home/user/sibling-project",
      frecencyScore: 9999,
    });

    expect(projectStoreMock.updateProject).toHaveBeenCalledWith("proj-1", { name: "Renamed" });
  });
});
