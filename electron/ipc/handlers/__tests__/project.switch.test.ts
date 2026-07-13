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

const projectStoreMock = vi.hoisted(() => {
  const getProjectState = vi.fn<(id: string) => Promise<Record<string, unknown> | null>>();
  const saveProjectState = vi.fn<(id: string, state: unknown) => Promise<void>>();
  return {
    getCurrentProjectId: vi.fn<() => string | null>(),
    getProjectById:
      vi.fn<(id: string) => { id: string; name: string; path: string; status?: string } | null>(),
    setCurrentProject: vi.fn<(id: string) => Promise<void>>(),
    getProjectState,
    saveProjectState,
    // Mirrors the real queue contract: read, apply updater, save unless null.
    enqueueProjectStateUpdate: vi.fn(
      async (
        id: string,
        updater: (existing: Record<string, unknown> | null) => Record<string, unknown> | null
      ) => {
        const existing = await getProjectState(id);
        const updated = await updater(existing);
        if (updated !== null) {
          await saveProjectState(id, updated);
        }
      }
    ),
    getAllProjects: vi.fn(() => []),
    getCurrentProject: vi.fn(() => null),
    updateProjectStatus: vi.fn(),
  };
});

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
  // broadcastProjectSwitchUpdates → broadcastToRenderer → getAllAppWebContents.
  // Returning [] keeps the broadcast a no-op in this suite; PROJECT_UPDATED
  // delivery is covered by projectSwitchBroadcast.test.ts.
  getAllAppWebContents: vi.fn(() => []),
  getProjectForWebContents: vi.fn(() => null),
}));

vi.mock("../../../window/portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { distributePortsToView } from "../../../window/portDistribution.js";
import { registerProjectCrudHandlers } from "../projectCrud/index.js";
import type { HandlerDependencies } from "../../types.js";
import type {
  WindowRegistry,
  WindowContext,
  WindowServices,
} from "../../../window/WindowRegistry.js";
import { DisposableStore } from "../../../utils/lifecycle.js";

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

describe("project:switch multi-window PVM routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses window 2's PVM when the IPC sender is window 2", async () => {
    const mockView = {
      webContents: { id: 200, isDestroyed: () => false, send: vi.fn() },
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
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
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
      webContents: { id: 200, isDestroyed: () => false, send: vi.fn() },
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
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
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
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
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
      webContents: { id: 200, isDestroyed: () => false, send: vi.fn() },
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
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
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
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
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
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
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

describe("project:switch worktree-load-status (#8400)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSwitch(loadProject: () => Promise<void>) {
    const sendMock = vi.fn();
    const mockView = {
      webContents: { id: 300, isDestroyed: () => false, send: sendMock },
    };
    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue({ id: 7, isDestroyed: () => false });

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const worktreeService = {
      loadProject: vi.fn(loadProject),
      attachDirectPort: vi.fn(),
      getHostForProject: vi.fn(() => null),
      resumeProject: vi.fn(),
      pauseProject: vi.fn(),
    };

    const deps = {
      mainWindow: { id: 7 } as unknown,
      projectViewManager: pvm,
      worktreeService: worktreeService as never,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    await handleMap.get(CHANNELS.PROJECT_SWITCH)!({ sender: { id: 300 } }, "proj-new");
    return sendMock;
  }

  it("sends the error targeted to the activated view when loadProject throws", async () => {
    const sendMock = await runSwitch(async () => {
      throw new Error("Not a git repository");
    });

    expect(sendMock).toHaveBeenCalledWith(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
      projectId: "proj-new",
      worktreeLoadError: "Not a git repository",
    });
  });

  it("sends a null status on success so a stale banner clears", async () => {
    const sendMock = await runSwitch(async () => undefined);

    expect(sendMock).toHaveBeenCalledWith(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
      projectId: "proj-new",
      worktreeLoadError: null,
    });
  });
});

describe("project:switch concurrent worktree load", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setup(opts: {
    switchTo: () => Promise<{ view: unknown; isNew: boolean }>;
    loadProject?: () => Promise<void>;
    previousProject?: { id: string; name: string; path: string } | null;
  }) {
    const pvm = {
      switchTo: vi.fn(opts.switchTo),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue({ id: 7, isDestroyed: () => false });

    const previous =
      opts.previousProject === undefined
        ? { id: "proj-old", name: "Old Project", path: "/projects/old" }
        : opts.previousProject;
    projectStoreMock.getCurrentProjectId.mockReturnValue(previous?.id ?? null);
    projectStoreMock.getProjectById.mockImplementation((id: string) => {
      if (id === "proj-new") {
        return { id: "proj-new", name: "New Project", path: "/projects/new" };
      }
      if (previous && id === previous.id) return previous;
      return null;
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const worktreeService = {
      loadProject: vi.fn(opts.loadProject ?? (async () => undefined)),
      attachDirectPort: vi.fn(),
      getHostForProject: vi.fn(() => null),
      resumeProject: vi.fn(),
      pauseProject: vi.fn(),
      unregisterWindow: vi.fn(),
    };

    const deps = {
      mainWindow: { id: 7 } as unknown,
      projectViewManager: pvm,
      worktreeService: worktreeService as never,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const invoke = () =>
      handleMap.get(CHANNELS.PROJECT_SWITCH)!({ sender: { id: 300 } }, "proj-new");

    return { invoke, pvm, worktreeService };
  }

  it("starts the worktree git load before the view swap resolves", async () => {
    let resolveSwap: (v: { view: unknown; isNew: boolean }) => void = () => {};
    const swapGate = new Promise<{ view: unknown; isNew: boolean }>((resolve) => {
      resolveSwap = resolve;
    });
    const { invoke, worktreeService } = setup({ switchTo: () => swapGate });

    const handlerPromise = invoke();

    // The load must be in flight while the swap still is — running them
    // serially re-adds the full host-spawn + git-enumeration time (hundreds of
    // ms on a cold host) to every switch's resolve time.
    await vi.waitFor(() => expect(worktreeService.loadProject).toHaveBeenCalled());
    expect(worktreeService.loadProject).toHaveBeenCalledWith("/projects/new", 7);
    expect(worktreeService.resumeProject).toHaveBeenCalledWith("/projects/new");

    resolveSwap({
      view: { webContents: { id: 300, isDestroyed: () => false, send: vi.fn() } },
      isNew: false,
    });
    await handlerPromise;
  });

  it("re-points the worktree mapping at the previous project when the swap fails", async () => {
    const { invoke, worktreeService } = setup({
      switchTo: async () => {
        throw new Error("load timeout");
      },
    });

    await expect(invoke()).rejects.toThrow("load timeout");

    // The early load already flipped windowToProject to the failed target while
    // the previous view stays visible — exactly the cross-project contamination
    // loadProject exists to prevent. The handler must restore the mapping.
    await vi.waitFor(() =>
      expect(worktreeService.loadProject).toHaveBeenCalledWith("/projects/old", 7)
    );
  });

  it("releases the window mapping when the swap fails with no previous project", async () => {
    const { invoke, worktreeService } = setup({
      switchTo: async () => {
        throw new Error("load timeout");
      },
      previousProject: null,
    });

    await expect(invoke()).rejects.toThrow("load timeout");

    // First switch from the welcome view: there is nothing to restore, so the
    // early load's attachment (and windowToProject mapping) must be released —
    // pausing alone would leave the window routed at the failed target.
    await vi.waitFor(() => expect(worktreeService.unregisterWindow).toHaveBeenCalledWith(7));
    // With nothing to restore, the mapping must not be re-loaded anywhere else.
    expect(worktreeService.loadProject).toHaveBeenCalledTimes(1);
  });

  it("skips the failure restore when a newer switch claimed the window meanwhile", async () => {
    let rejectSwap: (err: Error) => void = () => {};
    const failingSwap = new Promise<{ view: unknown; isNew: boolean }>((_resolve, reject) => {
      rejectSwap = reject;
    });
    let call = 0;
    const { invoke, worktreeService } = setup({
      switchTo: () => {
        call++;
        if (call === 1) return failingSwap;
        return Promise.resolve({
          view: { webContents: { id: 300, isDestroyed: () => false, send: vi.fn() } },
          isNew: false,
        });
      },
    });

    const first = invoke();
    // Let the first handler reach its awaited swap before the second starts.
    await vi.waitFor(() => expect(worktreeService.loadProject).toHaveBeenCalledTimes(1));

    // A second switch claims the window (bumps the epoch) and completes.
    await invoke();

    // Now the first swap fails. Its deferred restore must see the stale epoch
    // and do nothing — re-loading the old project here would clobber the
    // mapping the second switch just established.
    rejectSwap(new Error("load timeout"));
    await expect(first).rejects.toThrow("load timeout");
    await new Promise((r) => setTimeout(r, 10));

    expect(worktreeService.loadProject).not.toHaveBeenCalledWith("/projects/old", 7);
    expect(worktreeService.unregisterWindow).not.toHaveBeenCalled();
  });

  it("does not surface a worktree load failure through a successful swap", async () => {
    const sendMock = vi.fn();
    const { invoke } = setup({
      switchTo: async () => ({
        view: { webContents: { id: 300, isDestroyed: () => false, send: sendMock } },
        isNew: false,
      }),
      loadProject: async () => {
        throw new Error("Not a git repository");
      },
    });

    // Forward-fail (#8400): the load rejection — even though it now starts
    // before the swap — must resolve the switch and surface as the targeted
    // worktree-load-status, not reject the handler.
    await invoke();

    expect(sendMock).toHaveBeenCalledWith(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
      projectId: "proj-new",
      worktreeLoadError: "Not a git repository",
    });
  });
});

describe("project:switch PROJECT_ON_SWITCH notification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runActivation(channel: string, projectOverrides: Record<string, unknown> = {}) {
    const sendMock = vi.fn();
    const mockView = {
      webContents: { id: 300, isDestroyed: () => false, send: sendMock },
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
      ...projectOverrides,
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    await handleMap.get(channel)!({ sender: { id: 99 } }, "proj-new");
    return sendMock;
  }

  it("emits PROJECT_ON_SWITCH with a string switchId to the activated view on switch", async () => {
    const sendMock = await runActivation(CHANNELS.PROJECT_SWITCH);

    const call = sendMock.mock.calls.find((c) => c[0] === CHANNELS.PROJECT_ON_SWITCH);
    expect(call).toBeDefined();
    const payload = call![1] as { project: { id: string }; switchId: string };
    expect(payload.project).toEqual(expect.objectContaining({ id: "proj-new" }));
    // Behavior, not a fixed literal: switchId must be a non-empty string so
    // repeat activations are distinguishable (asserted below).
    expect(typeof payload.switchId).toBe("string");
    expect(payload.switchId.length).toBeGreaterThan(0);
  });

  it("emits a fresh switchId on each switch so repeat activations are distinguishable", async () => {
    const first = await runActivation(CHANNELS.PROJECT_SWITCH);
    const second = await runActivation(CHANNELS.PROJECT_SWITCH);

    const idOf = (mock: ReturnType<typeof vi.fn>) =>
      (mock.mock.calls.find((c) => c[0] === CHANNELS.PROJECT_ON_SWITCH)![1] as { switchId: string })
        .switchId;
    expect(idOf(first)).not.toBe(idOf(second));
  });

  it("emits PROJECT_ON_SWITCH on reopen as well", async () => {
    const sendMock = await runActivation(CHANNELS.PROJECT_REOPEN, { status: "background" });

    const call = sendMock.mock.calls.find((c) => c[0] === CHANNELS.PROJECT_ON_SWITCH);
    expect(call).toBeDefined();
    const switchId = (call![1] as { switchId: string }).switchId;
    expect(typeof switchId).toBe("string");
    expect(switchId.length).toBeGreaterThan(0);
  });
});

describe("project:switch PTY port ordering (#10075)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setup(opts: { isNew: boolean; loadProject: () => Promise<void> }) {
    const sendMock = vi.fn();
    const mockView = {
      webContents: { id: 300, isDestroyed: () => false, send: sendMock },
    };
    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: opts.isNew }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue({ id: 7, isDestroyed: () => false });

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const ptyClient = { onProjectSwitch: vi.fn() };
    const worktreeService = {
      loadProject: vi.fn(opts.loadProject),
      attachDirectPort: vi.fn(),
      getHostForProject: vi.fn(() => null),
      resumeProject: vi.fn(),
      pauseProject: vi.fn(),
    };
    const windowRegistry = makeWindowRegistry([makeWindowContext(7, 300)]);
    (
      windowRegistry as unknown as { registerAppViewWebContents: unknown }
    ).registerAppViewWebContents = vi.fn();

    const deps = {
      mainWindow: { id: 7 } as unknown,
      projectViewManager: pvm,
      worktreeService: worktreeService as never,
      ptyClient: ptyClient as never,
      windowRegistry,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const invoke = () =>
      handleMap.get(CHANNELS.PROJECT_SWITCH)!({ sender: { id: 300 } }, "proj-new");

    return { invoke, ptyClient, worktreeService };
  }

  it("rebrokers the PTY port before the worktree git load resolves on a warm switch", async () => {
    // A deferred loadProject lets us observe state at the moment the handler
    // reaches the (slow) git-load await — the PTY work must already be done by
    // then, otherwise terminal output would queue behind the load (#10075).
    let resolveLoad: () => void = () => {};
    const loadGate = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });

    const { invoke, ptyClient, worktreeService } = setup({
      isNew: false,
      loadProject: () => loadGate,
    });
    const distributeMock = vi.mocked(distributePortsToView);

    const handlerPromise = invoke();

    await vi.waitFor(() => expect(worktreeService.loadProject).toHaveBeenCalled());

    expect(ptyClient.onProjectSwitch).toHaveBeenCalledWith(7, "proj-new", "/projects/new");
    expect(distributeMock).toHaveBeenCalledTimes(1);
    // Port goes to the sender's window/context and carries the live ptyClient —
    // routing to the wrong window would silently drop terminal data.
    expect(distributeMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      expect.any(Object),
      expect.objectContaining({ id: 300 }),
      ptyClient
    );
    // PTY-host routing must be updated before the renderer port opens, else the
    // port is connected while the host still points at the old project.
    expect(ptyClient.onProjectSwitch.mock.invocationCallOrder[0]).toBeLessThan(
      distributeMock.mock.invocationCallOrder[0]
    );

    resolveLoad();
    await handlerPromise;
  });

  it("still rebrokers the PTY port even when the worktree load rejects", async () => {
    const { invoke, ptyClient } = setup({
      isNew: false,
      loadProject: async () => {
        throw new Error("Not a git repository");
      },
    });
    const distributeMock = vi.mocked(distributePortsToView);

    await invoke();

    // The reorder runs PTY work before loadProject, so a git-load failure must
    // not retroactively undo terminal connectivity (#10075).
    expect(ptyClient.onProjectSwitch).toHaveBeenCalledWith(7, "proj-new", "/projects/new");
    expect(distributeMock).toHaveBeenCalledTimes(1);
  });

  it("does not redistribute the PTY port for a cold-started view (isNew guard)", async () => {
    const { invoke, ptyClient } = setup({
      isNew: true,
      loadProject: async () => undefined,
    });
    const distributeMock = vi.mocked(distributePortsToView);

    await invoke();

    // Cold-start views get their first PTY port from
    // ProjectViewManager.onViewReady; redistributing here would race it.
    expect(distributeMock).not.toHaveBeenCalled();
    // onProjectSwitch still fires regardless of new/warm.
    expect(ptyClient.onProjectSwitch).toHaveBeenCalledWith(7, "proj-new", "/projects/new");
  });

  it("resumes the incoming project's workspace host on switch (#10743)", async () => {
    const { invoke, worktreeService } = setup({
      isNew: false,
      loadProject: async () => undefined,
    });

    await invoke();

    // Switching TO a project must foreground its host so a previously
    // backgrounded project resumes full-rate polling for fresh state.
    expect(worktreeService.resumeProject).toHaveBeenCalledWith("/projects/new");
  });
});
