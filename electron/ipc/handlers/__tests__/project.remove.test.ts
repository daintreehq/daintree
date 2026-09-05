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

// Unmocked this resolves through the real fire-and-forget dynamic import, so
// deleting the notify from the remove path left this whole file green (#12231).
const pluginLifecycleMock = vi.hoisted(() => ({
  notifyProjectPluginsClosed: vi.fn<(projectId: string) => void>(),
}));
vi.mock("../../../window/projectPluginLifecycle.js", () => pluginLifecycleMock);

const fileSearchCacheInvalidatorMock = vi.hoisted(() => ({
  handleWorktreeUpdate: vi.fn(),
  handleWorktreeRemoved: vi.fn(),
  handleProjectClosed: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("../../../services/workspace-client/fileSearchCacheInvalidation.js", () => ({
  fileSearchCacheInvalidator: fileSearchCacheInvalidatorMock,
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { createProjectCrudRegistrar } from "./helpers/projectCrudLifecycle.js";
import type { HandlerDependencies } from "../../types.js";
// Disposes the stats/fleet pollers this registration starts; see the helper for
// why dropping the disposer leaks live timers into the rest of the file.
const registerProjectCrudHandlers = createProjectCrudRegistrar();

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

  it("drops the removed project's file indexes (#12240)", async () => {
    // The worktree-delete path invalidates per worktree; a project removed
    // whole never goes through it, so its indexes used to sit in main-process
    // memory until something happened to read those exact paths again.
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-1",
      name: "Project",
      path: "/test/proj-1",
    });
    projectStoreMock.removeProject.mockResolvedValue(undefined);

    const deps = {
      mainWindow: {} as unknown,
      ptyClient: {
        getProjectStats: vi.fn(),
        onProjectSwitch: vi.fn(),
        setActiveProject: vi.fn(),
      },
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_REMOVE);

    await handler(fakeEvent, "proj-1");

    expect(fileSearchCacheInvalidatorMock.handleProjectClosed).toHaveBeenCalledWith("/test/proj-1");
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

    // A removed project's plugins must not outlive it, and the notify has to
    // land BEFORE the row goes: afterwards the controller can no longer resolve
    // the project to reconcile it away.
    expect(pluginLifecycleMock.notifyProjectPluginsClosed).toHaveBeenCalledTimes(1);
    expect(pluginLifecycleMock.notifyProjectPluginsClosed).toHaveBeenCalledWith("proj-1");
    expect(
      pluginLifecycleMock.notifyProjectPluginsClosed.mock.invocationCallOrder[0]!
    ).toBeLessThan(removeOrder);
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
    // The row survives with its agents still running, so its plugins do too.
    expect(pluginLifecycleMock.notifyProjectPluginsClosed).not.toHaveBeenCalled();
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

  it("strips the resume count — a renderer can never promise agents it doesn't have", async () => {
    projectStoreMock.updateProject.mockReturnValue({
      id: "proj-1",
      path: "/home/user/proj-1",
      name: "Renamed",
    });

    const deps = { mainWindow: {} as unknown } as unknown as HandlerDependencies;
    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_UPDATE);

    // The count is main-derived from persisted state (#11801) and rides the
    // row's accessible name. A renderer that could set it could make any row
    // announce "99 agents will resume" over a project holding none.
    await handler(fakeEvent, "proj-1", {
      name: "Renamed",
      resumableAgentCount: 99,
    });

    expect(projectStoreMock.updateProject).toHaveBeenCalledWith("proj-1", { name: "Renamed" });
  });
});
