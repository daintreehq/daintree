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
  getCurrentProject: vi.fn(() => null),
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
}));

vi.mock("../../../window/portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerProjectCrudHandlers } from "../projectCrud/index.js";
import type { HandlerDependencies } from "../../types.js";
import type {
  WindowRegistry,
  WindowContext,
  WindowServices,
} from "../../../window/WindowRegistry.js";

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
    cleanup: [],
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

describe("project:switch multi-window PVM routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses window 2's PVM when the IPC sender is window 2", async () => {
    const mockView = {
      webContents: { id: 200, isDestroyed: () => false },
    };

    const pvm1 = {
      switchTo: vi.fn(),
      getProjectIdForWebContents: vi.fn(),
    };
    const pvm2 = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    const ctx1 = makeWindowContext(1, 10, { projectViewManager: pvm1 as never });
    const ctx2 = makeWindowContext(2, 20, { projectViewManager: pvm2 as never });
    const registry = makeWindowRegistry([ctx1, ctx2]);

    // Simulate window 2 sending the IPC
    const fakeWindow2 = { id: 2, isDestroyed: () => false };
    mockGetWindowForWebContents.mockReturnValue(fakeWindow2);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm1,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    expect(handler).toBeDefined();

    const fakeEvent = { sender: { id: 20 } };
    await handler!(fakeEvent, "proj-new");

    // Window 2's PVM should have been called
    expect(pvm2.switchTo).toHaveBeenCalledWith("proj-new", "/projects/new");
    // Window 1's PVM should NOT have been called
    expect(pvm1.switchTo).not.toHaveBeenCalled();
  });

  it("falls back to deps.projectViewManager when windowRegistry lookup fails", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false },
    };

    const pvmFallback = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    // No window registry — simulates single-window or test scenario
    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvmFallback,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    await handler!(fakeEvent, "proj-new");

    expect(pvmFallback.switchTo).toHaveBeenCalledWith("proj-new", "/projects/new");
  });

  it("resolves correct PVM for handleProjectGetCurrent", async () => {
    const pvm1 = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(null),
    };
    const pvm2 = {
      getProjectIdForWebContents: vi.fn().mockReturnValue("proj-2"),
    };

    const ctx1 = makeWindowContext(1, 10, { projectViewManager: pvm1 as never });
    const ctx2 = makeWindowContext(2, 20, { projectViewManager: pvm2 as never });
    const registry = makeWindowRegistry([ctx1, ctx2]);

    const fakeWindow2 = { id: 2, isDestroyed: () => false };
    mockGetWindowForWebContents.mockReturnValue(fakeWindow2);

    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-2",
      name: "Project 2",
      path: "/projects/2",
    });

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm1,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_GET_CURRENT);
    const fakeEvent = { sender: { id: 20 } };
    const result = await handler!(fakeEvent);

    // Window 2's PVM should have been queried
    expect(pvm2.getProjectIdForWebContents).toHaveBeenCalledWith(20);
    // Should return window 2's project
    expect(result).toEqual({ id: "proj-2", name: "Project 2", path: "/projects/2" });
    // Window 1's PVM should NOT have been queried
    expect(pvm1.getProjectIdForWebContents).not.toHaveBeenCalled();
  });

  it("resolves correct PVM for handleProjectReopen", async () => {
    const mockView = {
      webContents: { id: 200, isDestroyed: () => false },
    };

    const pvm1 = {
      switchTo: vi.fn(),
    };
    const pvm2 = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
    };

    const ctx1 = makeWindowContext(1, 10, { projectViewManager: pvm1 as never });
    const ctx2 = makeWindowContext(2, 20, { projectViewManager: pvm2 as never });
    const registry = makeWindowRegistry([ctx1, ctx2]);

    const fakeWindow2 = { id: 2, isDestroyed: () => false };
    mockGetWindowForWebContents.mockReturnValue(fakeWindow2);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-reopen",
      name: "Reopen Project",
      path: "/projects/reopen",
      status: "background",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm1,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_REOPEN);
    const fakeEvent = { sender: { id: 20 } };
    await handler!(fakeEvent, "proj-reopen");

    expect(pvm2.switchTo).toHaveBeenCalledWith("proj-reopen", "/projects/reopen");
    expect(pvm1.switchTo).not.toHaveBeenCalled();
  });
});

describe("project:switch activeWorktreeId pre-apply (#5000)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists activeWorktreeId from outgoingState on project switch", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue(null);
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    const outgoingState = {
      draftInputs: {},
      activeWorktreeId: "wt-feature",
    };

    await handler!(fakeEvent, "proj-new", outgoingState);

    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith(
      "proj-old",
      expect.objectContaining({ activeWorktreeId: "wt-feature" })
    );
  });

  it("clears stale activeWorktreeId when outgoingState sends undefined", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue({
      projectId: "proj-old",
      sidebarWidth: 350,
      terminals: [],
      activeWorktreeId: "wt-stale",
    });
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    const outgoingState = {
      draftInputs: {},
      activeWorktreeId: undefined,
    };

    await handler!(fakeEvent, "proj-new", outgoingState);

    const savedState = projectStoreMock.saveProjectState.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(savedState.activeWorktreeId).toBeUndefined();
  });

  it("persists activeWorktreeId from outgoingState on project reopen", async () => {
    const mockView = {
      webContents: { id: 200, isDestroyed: () => false },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
    };

    const fakeWindow2 = { id: 2, isDestroyed: () => false };
    mockGetWindowForWebContents.mockReturnValue(fakeWindow2);

    const ctx = makeWindowContext(2, 20, { projectViewManager: pvm as never });
    const registry = makeWindowRegistry([ctx]);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-reopen",
      name: "Reopen Project",
      path: "/projects/reopen",
      status: "background",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue(null);
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_REOPEN);
    const fakeEvent = { sender: { id: 20 } };
    const outgoingState = {
      draftInputs: {},
      activeWorktreeId: "wt-reopen",
    };

    await handler!(fakeEvent, "proj-reopen", outgoingState);

    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith(
      "proj-old",
      expect.objectContaining({ activeWorktreeId: "wt-reopen" })
    );
  });
});

describe("project:switch outgoing tabGroups pre-apply (#5001)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists tabGroups from outgoingState on project switch", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue(null);
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    const outgoingState = {
      terminals: [{ id: "t-1", kind: "browser", title: "B", location: "grid" }],
      tabGroups: [{ id: "g1", location: "grid", activeTabId: "t-1", panelIds: ["t-1", "t-2"] }],
      draftInputs: {},
    };

    await handler!(fakeEvent, "proj-new", outgoingState);

    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith(
      "proj-old",
      expect.objectContaining({
        tabGroups: expect.arrayContaining([
          expect.objectContaining({ id: "g1", panelIds: ["t-1", "t-2"] }),
        ]),
      })
    );
  });

  it("does not include tabGroups when outgoingState has no tabGroups", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue(null);
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    const outgoingState = {
      draftInputs: {},
    };

    await handler!(fakeEvent, "proj-new", outgoingState);

    const savedState = projectStoreMock.saveProjectState.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(savedState).not.toHaveProperty("tabGroups");
  });

  it("clears stale tabGroups when outgoingState sends empty array", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    // Simulate existing state with stale tab groups
    projectStoreMock.getProjectState.mockResolvedValue({
      projectId: "proj-old",
      sidebarWidth: 350,
      terminals: [],
      tabGroups: [{ id: "stale-g1", location: "grid", activeTabId: "x", panelIds: ["x", "y"] }],
    });
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    const outgoingState = {
      terminals: [],
      tabGroups: [],
      draftInputs: {},
    };

    await handler!(fakeEvent, "proj-new", outgoingState);

    const savedState = projectStoreMock.saveProjectState.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(savedState.tabGroups).toEqual([]);
  });
});
