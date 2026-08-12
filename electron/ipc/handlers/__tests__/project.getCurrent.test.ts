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
  getCurrentProjectId: vi.fn<() => string | null>(),
  getProjectById:
    vi.fn<(id: string) => { id: string; name: string; path: string; status?: string } | null>(),
  setCurrentProject: vi.fn<(id: string) => Promise<void>>(),
  getProjectState: vi.fn<(id: string) => Promise<Record<string, unknown> | null>>(),
  saveProjectState: vi.fn<(id: string, state: unknown) => Promise<void>>(),
  getAllProjects: vi.fn(() => []),
  getCurrentProject: vi.fn<() => { id: string; name: string; path: string } | null>(),
  updateProjectStatus: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("../../../services/ProjectSwitchService.js", () => ({
  ProjectSwitchService: class MockProjectSwitchService {
    onSwitch = vi.fn();
    switchProject = vi.fn();
    reopenProject = vi.fn();
  },
}));

vi.mock("../../../services/RunCommandDetector.js", () => ({
  runCommandDetector: { detect: vi.fn().mockResolvedValue([]) },
}));

const mockGetWindowForWebContents = vi.fn();
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: (...args: unknown[]) => mockGetWindowForWebContents(...args),
  getProjectForWebContents: vi.fn(() => null),
  // Registering the CRUD handlers starts real stats/fleet pollers, and their
  // compute broadcasts through the real `typedBroadcast`, which enumerates the
  // registry. Leaving this out made the poller tick reject with a missing-export
  // error — the failure only lands if a tick beats teardown, so it reads as an
  // intermittent CI red rather than a broken test.
  getAllAppWebContents: vi.fn(() => []),
}));

vi.mock("../../../window/portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { createProjectCrudRegistrar } from "./helpers/projectCrudLifecycle.js";
import type { HandlerDependencies } from "../../types.js";
import type {
  WindowRegistry,
  WindowContext,
  WindowServices,
} from "../../../window/WindowRegistry.js";
import { DisposableStore } from "../../../utils/lifecycle.js";
// Disposes the stats/fleet pollers this registration starts; see the helper for
// why dropping the disposer leaks live timers into the rest of the file.
const registerProjectCrudHandlers = createProjectCrudRegistrar();

function makeWindowContext(
  windowId: number,
  webContentsId: number,
  services: Partial<WindowServices> = {}
): WindowContext {
  return {
    windowId,
    webContentsId,
    browserWindow: { id: windowId, isDestroyed: () => false } as unknown as Electron.BrowserWindow,
    projectPath: null,
    abortController: new AbortController(),
    services: services as WindowServices,
    cleanup: new DisposableStore(),
  };
}

function makeWindowRegistry(contexts: WindowContext[]): WindowRegistry {
  const byWindowId = new Map(contexts.map((c) => [c.windowId, c]));
  const byWebContentsId = new Map(contexts.map((c) => [c.webContentsId, c]));
  return {
    getByWindowId: (id: number) => byWindowId.get(id),
    getByWebContentsId: (id: number) => byWebContentsId.get(id),
    getPrimary: () => contexts[0],
    all: () => contexts,
    get size() {
      return contexts.length;
    },
  } as unknown as WindowRegistry;
}

function getHandler(channel: string) {
  const handleMap = new Map<string, (...args: unknown[]) => unknown>();
  for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
    handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
  }
  const handler = handleMap.get(channel);
  expect(handler).toBeDefined();
  return handler!;
}

describe("project:get-current — unbound new window (#6015)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectStoreMock.getCurrentProject.mockReturnValue(null);
    projectStoreMock.getProjectById.mockReturnValue(null);
  });

  it("returns null when PVM exists but the sender WebContents has no binding", async () => {
    // Simulates a user-triggered new window: PVM was created in createWindow(),
    // but registerInitialView was never called, so webContentsToProject is empty.
    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(null),
    };
    const ctx = makeWindowContext(2, 20, { projectViewManager: pvm as never });
    const registry = makeWindowRegistry([ctx]);
    mockGetWindowForWebContents.mockReturnValue({ id: 2, isDestroyed: () => false });

    // The "global" project — must NOT leak into the new window.
    projectStoreMock.getCurrentProject.mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    });

    const worktreeService = { loadProject: vi.fn() };

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm,
      worktreeService,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_GET_CURRENT);

    const result = await handler({ sender: { id: 20 } });

    expect(result).toBeNull();
    expect(pvm.getProjectIdForWebContents).toHaveBeenCalledWith(20);
    // Critical: must not fall through to the global project.
    expect(projectStoreMock.getCurrentProject).not.toHaveBeenCalled();
    // Critical: must not fire the worktree side-effect for an unbound view —
    // no port has been brokered for it, so the snapshot would be orphaned.
    expect(worktreeService.loadProject).not.toHaveBeenCalled();
  });

  it("returns the bound project when PVM has a binding for the sender", async () => {
    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue("proj-bound"),
    };
    const ctx = makeWindowContext(2, 20, { projectViewManager: pvm as never });
    const registry = makeWindowRegistry([ctx]);
    mockGetWindowForWebContents.mockReturnValue({ id: 2, isDestroyed: () => false });

    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-bound",
      name: "Bound Project",
      path: "/projects/bound",
    });

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_GET_CURRENT);

    const result = await handler({ sender: { id: 20 } });

    expect(result).toEqual({
      id: "proj-bound",
      name: "Bound Project",
      path: "/projects/bound",
    });
    expect(projectStoreMock.getCurrentProject).not.toHaveBeenCalled();
  });

  it("returns the URL project when PVM binding is not ready yet", async () => {
    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(null),
    };
    const ctx = makeWindowContext(2, 20, { projectViewManager: pvm as never });
    const registry = makeWindowRegistry([ctx]);
    mockGetWindowForWebContents.mockReturnValue({ id: 2, isDestroyed: () => false });

    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-url",
      name: "URL Project",
      path: "/projects/url",
    });
    projectStoreMock.getCurrentProject.mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    });

    const worktreeService = { loadProject: vi.fn() };
    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm,
      worktreeService,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_GET_CURRENT);

    const result = await handler({
      sender: {
        id: 20,
        getURL: () => "app://daintree/index.html?projectId=proj-url",
      },
    });

    expect(result).toEqual({
      id: "proj-url",
      name: "URL Project",
      path: "/projects/url",
    });
    expect(pvm.getProjectIdForWebContents).toHaveBeenCalledWith(20);
    expect(projectStoreMock.getProjectById).toHaveBeenCalledWith("proj-url");
    expect(projectStoreMock.getCurrentProject).not.toHaveBeenCalled();
    expect(worktreeService.loadProject).not.toHaveBeenCalled();
  });

  it("returns null when the URL project has been closed before PVM binding is ready", async () => {
    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(null),
    };
    const ctx = makeWindowContext(2, 20, { projectViewManager: pvm as never });
    const registry = makeWindowRegistry([ctx]);
    mockGetWindowForWebContents.mockReturnValue({ id: 2, isDestroyed: () => false });

    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-url-closed",
      name: "Closed URL Project",
      path: "/projects/url-closed",
      status: "closed",
    });
    projectStoreMock.getCurrentProject.mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    });

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_GET_CURRENT);

    const result = await handler({
      sender: {
        id: 20,
        getURL: () => "app://daintree/index.html?projectId=proj-url-closed",
      },
    });

    expect(result).toBeNull();
    expect(projectStoreMock.getProjectById).toHaveBeenCalledWith("proj-url-closed");
    expect(projectStoreMock.getCurrentProject).not.toHaveBeenCalled();
  });

  it("returns null when a PVM-bound project has been closed", async () => {
    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue("proj-closed"),
    };
    const ctx = makeWindowContext(2, 20, { projectViewManager: pvm as never });
    const registry = makeWindowRegistry([ctx]);
    mockGetWindowForWebContents.mockReturnValue({ id: 2, isDestroyed: () => false });

    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-closed",
      name: "Closed Project",
      path: "/projects/closed",
      status: "closed",
    });
    projectStoreMock.getCurrentProject.mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    });

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_GET_CURRENT);

    const result = await handler({ sender: { id: 20 } });

    expect(result).toBeNull();
    expect(projectStoreMock.getCurrentProject).not.toHaveBeenCalled();
  });

  it("returns null when PVM has a binding but the project is missing from the store", async () => {
    // Defensive: a stale binding shouldn't fall through to the global project either.
    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue("proj-missing"),
    };
    const ctx = makeWindowContext(2, 20, { projectViewManager: pvm as never });
    const registry = makeWindowRegistry([ctx]);
    mockGetWindowForWebContents.mockReturnValue({ id: 2, isDestroyed: () => false });

    projectStoreMock.getProjectById.mockReturnValue(null);
    projectStoreMock.getCurrentProject.mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    });

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_GET_CURRENT);

    const result = await handler({ sender: { id: 20 } });

    expect(result).toBeNull();
    expect(projectStoreMock.getCurrentProject).not.toHaveBeenCalled();
  });

  it("falls back to projectStore.getCurrentProject() when no PVM is available", async () => {
    // Legacy path: deps with no PVM (test/edge scenarios).
    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProject.mockReturnValue({
      id: "proj-global",
      name: "Global Project",
      path: "/projects/global",
    });

    const worktreeService = { loadProject: vi.fn().mockResolvedValue(undefined) };

    const deps = {
      mainWindow: { id: 1 } as unknown,
      worktreeService,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    const handler = getHandler(CHANNELS.PROJECT_GET_CURRENT);

    const result = await handler({ sender: { id: 99 } });

    expect(result).toEqual({
      id: "proj-global",
      name: "Global Project",
      path: "/projects/global",
    });
    expect(projectStoreMock.getCurrentProject).toHaveBeenCalled();
    // The fallback path still loads worktrees because that path predates the
    // port-per-view broker and was the historical behaviour.
    expect(worktreeService.loadProject).toHaveBeenCalledWith("/projects/global", 1);
  });
});
